'use strict';
// Registers one round's Merkle root on a deployed HCOWClaim, after proving the
// root again from the tree file rather than trusting the summary.
//
//   RPC_URL=... CHAIN_ID=97 TREASURY_KEY=0x... \
//   node scripts/set-root.cjs --rounds build/merkle/rounds.json --round 0
//
//   PRINT_ONLY=yes ...   prints to / data for the treasury Safe instead of sending
//
// WHY A SCRIPT AND NOT A HAND-TYPED CALL
//
// This is the one call that is repeated, once per round, months apart, and it
// is irreversible the moment the round opens: after startTime the root can
// never be corrected, by anyone, by design. A root pasted into the wrong round
// or off by one character cannot be taken back. So before anything is signed
// this rebuilds the tree from the round file, checks the rebuilt root against
// the summary file and against every proof in it, and checks the round on
// chain is still open to being set.

const fs = require('fs');
const path = require('path');
const { connect, at, sendOrPrint, readRecord, ethers, dryFlag, suppressed } = require('./_connect.cjs');
const { buildRound, verifyProof, leafB } = require('./merkle.cjs');

const E = 10n ** 18n;
const hcow = (v) => (Number(BigInt(v) * 10000n / E) / 10000).toLocaleString('en-US');

function args(argv) {
  const out = {};
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[++i];
  return out;
}

async function main() {
  const o = args(process.argv);
  const roundsFile = o.rounds || 'build/merkle/rounds.json';
  if (o.round === undefined) throw new Error('--round <n> is required');
  const roundId = Number(o.round);
  if (!Number.isInteger(roundId) || roundId < 0) throw new Error(`--round ${o.round} is not a round number`);

  const summary = JSON.parse(fs.readFileSync(path.resolve(roundsFile), 'utf8'));
  const entry = summary.rounds.find((r) => r.roundId === roundId);
  if (!entry) throw new Error(`${roundsFile} has no round ${roundId}. It has: ${summary.rounds.map((r) => r.roundId).join(', ')}`);

  const treeFile = path.join(path.dirname(path.resolve(roundsFile)), `round-${roundId}.json`);
  const tree = JSON.parse(fs.readFileSync(treeFile, 'utf8'));

  // ---- rebuild, and check the summary against the tree ------------------
  const rebuilt = buildRound(roundId, Object.entries(tree.claims).map(([account, c]) => ({ account, amount: c.amount })));
  const disagree = [];
  if (rebuilt.root.toLowerCase() !== rebuilt.rootSecondPath.toLowerCase()) disagree.push('the two rebuild paths disagree with each other');
  if (rebuilt.root.toLowerCase() !== tree.merkleRoot.toLowerCase()) disagree.push(`the rebuilt root ${rebuilt.root} is not ${treeFile}'s ${tree.merkleRoot}`);
  if (tree.merkleRoot.toLowerCase() !== entry.merkleRoot.toLowerCase()) disagree.push(`${treeFile} and ${roundsFile} name different roots`);
  if (tree.startTime !== entry.startTime) disagree.push(`${treeFile} and ${roundsFile} name different start times`);
  for (const [account, c] of Object.entries(tree.claims)) {
    if (!verifyProof(leafB(roundId, c.index, account, c.amount), c.proof, tree.merkleRoot)) {
      disagree.push(`the proof shipped for ${account} does not replay to the root`);
      break;
    }
  }
  if (disagree.length) {
    throw new Error('THE TREE FILES DO NOT AGREE. Nothing has been sent.\n  ' + disagree.join('\n  '));
  }
  const total = Object.values(tree.claims).reduce((a, c) => a + BigInt(c.amount), 0n);
  console.log(`round     ${roundId}`);
  console.log(`root      ${tree.merkleRoot}  (rebuilt from ${treeFile} by both paths)`);
  console.log(`opens     ${new Date(tree.startTime * 1000).toISOString()}`);
  console.log(`pays      ${hcow(total)} HCOW to ${Object.keys(tree.claims).length} addresses`);

  // ---- chain ------------------------------------------------------------
  const { provider, signer, net, mainnet } = await connect({ keyVar: 'TREASURY_KEY' });
  const chainId = Number(net.chainId);
  const record = readRecord(chainId) || {};
  const claimAddr = o.claim || record.addresses?.HCOWClaim;
  if (!claimAddr) throw new Error('--claim <address> is required, or deployments/<chain>.json must name HCOWClaim');

  const claim = at('HCOWClaim', claimAddr, provider);
  const me = await signer.getAddress();
  const [owner, onchain, tokenAddr] = await Promise.all([claim.owner(), claim.rounds(roundId), claim.token()]);
  const held = await at('HCOWToken', tokenAddr, provider).balanceOf(claimAddr);
  const nowTs = (await provider.getBlock('latest')).timestamp;

  console.log(`\nclaim     ${claimAddr} on chain ${chainId}${mainnet ? '  (MAINNET)' : ''}`);
  console.log(`owner     ${owner}`);
  console.log(`holds     ${hcow(held)} HCOW`);

  if (onchain.merkleRoot !== ethers.ZeroHash) {
    console.log(`existing  ${onchain.merkleRoot} opening ${new Date(Number(onchain.startTime) * 1000).toISOString()}`);
    if (nowTs >= Number(onchain.startTime)) {
      throw new Error(`round ${roundId} opened at ${new Date(Number(onchain.startTime) * 1000).toISOString()}. Its root is frozen forever and setRoot will revert.`);
    }
    console.log('          this call REPLACES that root. It has not opened yet, so it is still allowed.');
  }
  // A startTime already past opens and freezes the round in the same block,
  // with no window to correct the root. LEAD_SECONDS is the margin on top of
  // that: the normal path is PRINT_ONLY, and a Safe executes the printed call
  // minutes to days later, so a round that is barely ahead at preparation
  // time can be behind at execution time. Checking only `<= nowTs` checks the
  // wrong clock. (Audit 4, M-11.)
  // The contract's own notice period is the floor. A script that prepares a
  // call the contract will reject is worse than no check: the operator finds
  // out when the Safe execution reverts, days later, with the round still
  // unregistered. (Audit 4, A-1.)
  const notice = Number(await claim.minRoundNotice());
  const LEAD = Number(process.env.LEAD_SECONDS ?? Math.max(86400, notice));
  if (!Number.isInteger(LEAD) || LEAD < 0) throw new Error('LEAD_SECONDS must be a whole number of seconds');
  if (LEAD < notice) {
    throw new Error(
      `LEAD_SECONDS is ${LEAD} but the contract's minRoundNotice is ${notice}. setRoot would revert ` +
      'with NoticeTooShort. The margin cannot be smaller than the notice the contract enforces.');
  }
  console.log(`notice    ${notice}s enforced on chain; using a ${LEAD}s margin`);
  if (tree.startTime <= nowTs) {
    throw new Error(
      `round ${roundId} starts at ${new Date(tree.startTime * 1000).toISOString()}, which is already past ` +
      `(chain time ${new Date(nowTs * 1000).toISOString()}). It would open and freeze in the same block, with no ` +
      'window to correct the root. Rebuild the trees with a TGE or round start that is still ahead.');
  }
  if (tree.startTime - nowTs < LEAD) {
    throw new Error(
      `round ${roundId} opens in ${(((tree.startTime - nowTs) / 3600)).toFixed(1)} hours, less than the ` +
      `${(LEAD / 3600).toFixed(1)} hour margin. A queued Safe transaction can execute after that, and then the ` +
      'round opens and freezes on arrival. Rebuild with a later start, or set LEAD_SECONDS deliberately.');
  }
  // 1900000000000 is 'seconds' that are really milliseconds: ~year 62178. The
  // contract accepts it and the round then never opens. (Audit 4, M-10.)
  // 7차 감사 M-3. 이 값은 검증되지 않았다. Number('3650d') 은 NaN 이고
  // x > NaN 은 항상 false 라, 오타 한 글자가 아래 가드를 통째로 껐다.
  // 22줄 위 LEAD_SECONDS 는 Number.isInteger 로 검증한다. 형제 간 불일치였다.
  const MAX_AHEAD = Number(process.env.MAX_AHEAD_SECONDS ?? 3650 * 86400);
  if (!Number.isInteger(MAX_AHEAD) || MAX_AHEAD <= 0) {
    throw new Error(
      `MAX_AHEAD_SECONDS must be a positive whole number of seconds, got ` +
      `${JSON.stringify(process.env.MAX_AHEAD_SECONDS)}. Anything else reads as NaN and silently ` +
      'disables the check that a millisecond timestamp never reaches setRoot.');
  }
  if (tree.startTime - nowTs > MAX_AHEAD) {
    throw new Error(
      `round ${roundId} opens at ${new Date(tree.startTime * 1000).toISOString()}, ` +
      `${(((tree.startTime - nowTs) / 86400)).toFixed(0)} days out. That is past the ` +
      `${(MAX_AHEAD / 86400).toFixed(0)} day sanity bound and is what a millisecond timestamp looks like. ` +
      'A round registered that far out never opens and its root is stuck there.');
  }

  // The README says this script checks that the contract holds enough to pay
  // the round. It said that while this was a console.log. (Audit 4, H-9.)
  // Claims revert safely when underfunded, so this is a stop and not a
  // disaster, but the document has to be true.
  if (held < total) {
    if (!dryFlag('ALLOW_UNDERFUNDED')) {
      throw new Error(
        `the round pays ${hcow(total)} HCOW and the contract holds ${hcow(held)}. Every claim past the ` +
        'balance reverts with InsufficientBalance until the vesting release lands, and the root is frozen ' +
        'the moment the round opens. Release the bucket first, or set ALLOW_UNDERFUNDED=yes if opening ' +
        'ahead of funding is deliberate.');
    }
    console.log(`          WARNING: the round pays ${hcow(total)} HCOW and only ${hcow(held)} is here. ` +
                'ALLOW_UNDERFUNDED is set, so this is going ahead.');
  }
  // 7차 감사 H-3. 이 스크립트는 PRINT_ONLY 만 알고 DRY_RUN 을 몰랐다.
  // DRY_RUN=yes 는 정의되지 않은 환경변수로 무시되고 setRoot 가 실제로 나갔다.
  if (!suppressed() && owner.toLowerCase() !== me.toLowerCase()) {
    throw new Error(`TREASURY_KEY is ${me} but the owner is ${owner}. Use PRINT_ONLY=yes and sign from the Safe.`);
  }

  await sendOrPrint(
    `setRoot(${roundId}, ${tree.merkleRoot}, ${tree.startTime})`,
    at('HCOWClaim', claimAddr, signer), 'setRoot', [roundId, tree.merkleRoot, tree.startTime], { from: me });
}

main().catch((e) => { console.error('\n' + (e.message || e)); process.exitCode = 1; });
