'use strict';
// Deploys HCOWClaim. Registers no round and holds no tokens when it finishes.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... \
//   HCOW_ADDRESS=0x... CLAIM_OWNER=0x<treasury Safe> CLAIM_DEADLINE=<unix seconds> \
//   TGE_TIME=<unix seconds> CLAIM_NOTICE_SECONDS=259200 CLAIM_WINDOW_SECONDS=7776000 \
//   node scripts/deploy-claim.cjs
//
//   DRY_RUN=yes   runs every check below and deploys nothing.
//   PRINT_ONLY=yes  is accepted as the same thing, because the rest of this
//   repository uses that name and the fourth adversarial audit (2026-09-18,
//   C-1) found that this script silently ignored both and deployed for real.
//   Do a dry run first. The deploy is not reversible.
//
// WHY THIS RUNS BEFORE seal(), AND WHY IT CHECKS
//
// The Community/Airdrop schedule's beneficiary is this contract's address, and
// HCOWVesting fixes every beneficiary at seal() forever. So the order is deploy
// here, point the schedule at what this prints, then seal. If the vesting
// contract is already sealed, the address it was sealed with is the only
// address that will ever receive that bucket and a claim contract deployed now
// can never be funded by it. This script reads sealed_() and refuses in that
// case, because the alternative is a contract that looks right, verifies on
// BscScan, and silently never receives a token.
//
// WHAT IT CANNOT CHECK
//
// Whether CLAIM_OWNER is really the treasury Safe, and whether CLAIM_DEADLINE
// is the agreed length. Both are open in spec section 10 and both are
// one-way: ownership transfers need the new owner to accept, and the deadline
// extends but never shortens.

const { connect, deploy, at, writeRecord, readRecord, dryFlag, ethers } = require('./_connect.cjs');

const DAY = 24 * 60 * 60;
const E = 10n ** 18n;

const addr = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set`);
  if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);
  return ethers.getAddress(v);
};

async function main() {
  const dryRun = dryFlag('DRY_RUN') || dryFlag('PRINT_ONLY');

  const { provider, signer, net, mainnet } = await connect();
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);
  const chainId = Number(net.chainId);

  console.log(dryRun
    ? '\n*** DRY RUN. Every check below runs. Nothing is deployed and nothing is written. ***\n'
    : '\n*** LIVE. This deploys a contract. Run with DRY_RUN=yes first if you have not. ***\n');
  console.log(`chain     ${chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : '  (TESTNET)'}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB\n`);
  if (bal === 0n) throw new Error('deployer has no BNB');

  const priorRecord = readRecord(chainId);
  const record = priorRecord || {};

  // ---- has this already been deployed? ----------------------------------
  //
  // deploy-anchor.cjs has this guard and this script did not, so a second run
  // deployed a second contract, overwrote the record, and left the FIRST
  // address recorded nowhere. If the schedule was already pointed at the
  // first one, set-root.cjs then reads the record and registers the round on
  // the empty contract. (Audit 4, C-3.)
  const recordedClaim = record.addresses?.HCOWClaim;
  if (recordedClaim && (await provider.getCode(recordedClaim)) !== '0x') {
    if (!dryFlag('REPLACE_CLAIM')) {
      throw new Error(
        `HCOWClaim is already deployed on chain ${chainId} at ${recordedClaim} and has code there. ` +
        'Deploying again produces a second contract that vesting will never fund, and overwrites the ' +
        'record that set-root.cjs and the schedule both read. If the first one really is to be ' +
        'abandoned AND the schedule has not been sealed against it, re-run with REPLACE_CLAIM=yes.');
    }
    console.log(`REPLACE_CLAIM is set. The record currently names ${recordedClaim}; it will be overwritten.`);
  }
  if (!priorRecord && !dryFlag('FIRST_DEPLOY') && !dryRun) {
    throw new Error(
      `no deployments/${chainId}.json exists. That is what a first deploy looks like, and it is also ` +
      'what a wiped or missing record looks like after something was already deployed here. The ' +
      'checks below that need the record (TGE comparison, sealed_(), treasury match) cannot run ' +
      'without it. If this really is the first deploy on this chain, re-run with FIRST_DEPLOY=yes. ' +
      'If it is not, restore the record first.');
  }

  // ---- the token --------------------------------------------------------
  const token = process.env.HCOW_ADDRESS ? addr('HCOW_ADDRESS') : record.addresses?.HCOWToken;
  if (!token) throw new Error('HCOW_ADDRESS must be set, or deployments/<chain>.json must already name HCOWToken');

  if ((await provider.getCode(token)) === '0x') throw new Error(`${token} has no code on chain ${chainId}`);
  const tk = at('HCOWToken', token, provider);
  const [sym, dec, supply] = await Promise.all([tk.symbol(), tk.decimals(), tk.totalSupply()]);
  console.log(`token     ${token}  ${sym}, ${dec} decimals, supply ${ethers.formatUnits(supply, dec)}`);
  if (Number(dec) !== 18) throw new Error(`token reports ${dec} decimals; every amount in the trees is written in 18`);

  // HCOWClaim.token is immutable. The previous version of this script printed
  // the symbol and compared nothing, so an 18-decimal decoy passed and the
  // claim contract was wired to it forever. (Audit 4, C-4.)
  if (sym !== 'HCOW') {
    throw new Error(
      `the token at ${token} calls itself ${JSON.stringify(sym)}, not "HCOW". HCOWClaim.token is ` +
      'immutable, so a claim contract bound to the wrong token can never pay anyone and its sweep ' +
      'moves the wrong asset.');
  }
  if (mainnet && supply !== 200_000_000n * E) {
    throw new Error(
      `the token at ${token} reports a total supply of ${ethers.formatUnits(supply, 18)}, not 200,000,000. ` +
      'HCOW has a fixed supply and no mint function, so this is not HCOW.');
  }
  // A record that already names a token is the value seal.cjs and release.cjs
  // treat as authoritative. Replacing it from an environment variable without
  // saying so is how the authoritative value becomes the unverified one.
  const recordedToken = record.addresses?.HCOWToken;
  if (recordedToken && recordedToken.toLowerCase() !== token.toLowerCase()) {
    throw new Error(
      `HCOW_ADDRESS is ${token} but deployments/${chainId}.json already names HCOWToken as ` +
      `${recordedToken}. One of the two is wrong and this script will not pick. Other scripts read ` +
      'that record as the authoritative token address.');
  }

  // ---- the owner --------------------------------------------------------
  const owner = addr('CLAIM_OWNER');
  if (owner === ethers.ZeroAddress) throw new Error('CLAIM_OWNER must not be the zero address');
  if (mainnet && owner.toLowerCase() === me.toLowerCase()) {
    throw new Error(
      'CLAIM_OWNER is the deploy key. setRoot, sweep and extendDeadline are the whole of this ' +
      "contract's trust surface and they belong to the treasury Safe, not to a throwaway key.");
  }
  const ownerCode = await provider.getCode(owner);
  console.log(`owner     ${owner}  ${ownerCode === '0x' ? 'EOA' : `contract, ${(ownerCode.length - 2) / 2} bytes of code`}`);

  // The record already carries the treasury address and this script already
  // holds the record, and it compared nothing. (Audit 4, H-6.)
  if (record.treasury && record.treasury.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `CLAIM_OWNER is ${owner} but deployments/${chainId}.json records the treasury as ` +
      `${record.treasury}. setRoot, sweep and extendDeadline are the whole trust surface of this ` +
      'contract and ownership cannot be renounced, so a wrong owner here is permanent. If the ' +
      'treasury really has moved, update the record first so both agree.');
  }
  if (mainnet && ownerCode === '0x') {
    if (!dryFlag('ALLOW_EOA_OWNER')) {
      throw new Error(
        'CLAIM_OWNER is an externally owned account on mainnet. Spec 4-7 says the owner is a ' +
        'multisig (Safe), and this key would hold setRoot, sweep and extendDeadline permanently ' +
        'with no way to renounce. A warning printed here was ignorable; this is not. Set ' +
        'ALLOW_EOA_OWNER=yes only if a single key really is the intended owner.');
    }
    console.log('          WARNING: this is an EOA and ALLOW_EOA_OWNER is set. Proceeding.');
  }

  // ---- the deadline -----------------------------------------------------
  const deadline = Number(process.env.CLAIM_DEADLINE || 0);
  if (!Number.isInteger(deadline) || deadline <= 0) {
    throw new Error('CLAIM_DEADLINE must be a unix timestamp in SECONDS, not milliseconds and not a date string.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now) throw new Error(`CLAIM_DEADLINE ${deadline} is already in the past`);
  if (deadline > now + 3650 * DAY) throw new Error(`CLAIM_DEADLINE ${deadline} is more than 10 years out; the constructor refuses it`);
  console.log(`deadline  ${new Date(deadline * 1000).toISOString()}  (${((deadline - now) / DAY).toFixed(1)} days out)`);

  // The last round opens five 30-day months after TGE under the policy as
  // drafted. A deadline before that would close claiming on rounds that have
  // not opened. The deadline extends but never shortens, so erring long costs
  // nothing and erring short cannot be undone.
  // 7차 감사 M-4. 이 대조는 record.tgeTime 에만 의존했고, 그 값을 쓰는 곳은
  // 저장소 전체에서 deploy.cjs 하나뿐이다. 정해진 배포 순서는
  // token -> HCOWClaim -> vesting 이므로 이 스크립트가 도는 시점에 tgeTime 은
  // 구조적으로 항상 없었다. 즉 "no TGE recorded" 가 예외가 아니라 상시였고,
  // claimDeadline 은 연장만 되고 줄일 수 없으므로 "너무 짧게 잡았다" 를 잡아
  // 줄 유일한 검사가 한 번도 돌지 않았다. 대표 결정으로 env 로 직접 받는다.
  const envTge = process.env.TGE_TIME;
  if (envTge !== undefined && !/^\d+$/.test(String(envTge).trim())) {
    throw new Error(`TGE_TIME "${envTge}" must be a unix timestamp in SECONDS, not milliseconds and not a date string.`);
  }
  const tgeFromEnv = envTge === undefined ? null : Number(String(envTge).trim());
  // 둘 다 있으면 일치해야 한다. 이 스크립트가 고르지 않는다.
  if (tgeFromEnv !== null && record.tgeTime && Number(record.tgeTime) !== tgeFromEnv) {
    throw new Error(
      `TGE_TIME is ${tgeFromEnv} but deployments/${chainId}.json records tgeTime as ${record.tgeTime}. ` +
      'One of the two is wrong and this script will not pick. The vesting contract fixes tgeTime as ' +
      'immutable, so the recorded value is what the chain will hold.');
  }
  const tge = tgeFromEnv ?? (record.tgeTime ? Number(record.tgeTime) : null);
  if (tge) {
    const monthsAfterTge = (deadline - tge) / (30 * DAY);
    console.log(`          ${monthsAfterTge.toFixed(1)} thirty-day months after TGE ${tgeFromEnv !== null ? '(TGE_TIME)' : '(recorded)'}`);
    if (deadline <= tge) throw new Error('CLAIM_DEADLINE is at or before TGE; no round would ever be claimable');
    if (mainnet && monthsAfterTge < 12) {
      throw new Error(
        `CLAIM_DEADLINE is ${monthsAfterTge.toFixed(1)} months after TGE. The drafted policy's last round ` +
        'opens at month 4, and a deadline this close reads as a countdown. It extends later but never ' +
        'shortens, so set it long and extend if you need to.');
    }
  } else if (mainnet && !dryRun) {
    throw new Error(
      'TGE_TIME must be set, in unix SECONDS, or deployments/<chain>.json must already record tgeTime. ' +
      'CLAIM_DEADLINE can only ever be extended, so the comparison against TGE is the one check that ' +
      'can catch a deadline set too short, and on mainnet it is not optional. In the deployment order ' +
      'this repository uses, the claim contract is deployed before vesting exists, so the record does ' +
      'not have tgeTime yet and the value has to come from here.');
  } else {
    console.log('          no TGE given and none recorded; the deadline is not being compared to it');
  }

  // ---- the notice period ------------------------------------------------
  //
  // Audit 4, A-1. setRoot is the owner's second route to the balance and it is
  // not time-locked the way sweep() is. That route cannot be removed: a
  // distributor whose operator chooses the root cannot tell an honest
  // recipient list from a dishonest one. What the notice buys is that no round
  // can open in the block it was registered, so every root is a public
  // RoundSet event before it can pay anyone -- and, the reason it was actually
  // chosen, that a mistyped startTime can no longer freeze a wrong root
  // instantly. It is immutable once deployed.
  const notice = Number(process.env.CLAIM_NOTICE_SECONDS || 0);
  if (!Number.isInteger(notice) || notice <= 0) {
    throw new Error(
      'CLAIM_NOTICE_SECONDS must be set, in SECONDS. It is how far ahead a round must be ' +
      'registered before it can open, it is immutable after deployment, and the contract ' +
      'accepts 3600 (1 hour) to 2592000 (30 days). The recommendation on record is 259200 (72 hours).');
  }
  if (notice < 3600 || notice > 30 * DAY) {
    throw new Error(`CLAIM_NOTICE_SECONDS ${notice} is outside the contract's [3600, ${30 * DAY}] range`);
  }
  console.log(`notice    ${notice}s  (${(notice / 3600).toFixed(1)} hours a round must wait before it can open)`);
  if (mainnet && notice < 24 * 3600) {
    throw new Error(
      `CLAIM_NOTICE_SECONDS is ${(notice / 3600).toFixed(1)} hours. Under a day gives nobody time to ` +
      'read a new root before it can pay, which is the entire point of the parameter. The hour floor ' +
      'exists for testnet rehearsal. Set it deliberately or use the recommended 259200.');
  }

  // ---- the claim window -------------------------------------------------
  //
  // Every round must open at least this long before CLAIM_DEADLINE. Without it
  // the deadline and the round schedule are unrelated numbers, and a deadline
  // earlier than the last round's start puts sweep() in reach of tokens no
  // round has opened to pay out. Immutable once deployed, like the notice.
  const window = Number(process.env.CLAIM_WINDOW_SECONDS || 0);
  if (!Number.isInteger(window) || window <= 0) {
    throw new Error(
      'CLAIM_WINDOW_SECONDS must be set, in SECONDS. It is how long every round must stay ' +
      'claimable before sweep() can open, it is immutable after deployment, and the contract ' +
      'accepts 3600 (1 hour) to 31536000 (365 days).');
  }
  if (window < 3600 || window > 365 * DAY) {
    throw new Error(`CLAIM_WINDOW_SECONDS ${window} is outside the contract's [3600, ${365 * DAY}] range`);
  }
  console.log(`window    ${window}s  (${(window / DAY).toFixed(1)} days every round stays claimable)`);
  if (mainnet && window < 30 * DAY) {
    throw new Error(
      `CLAIM_WINDOW_SECONDS is ${(window / DAY).toFixed(1)} days. Under 30 days on mainnet means the ` +
      'last round could close to sweep() before slow claimants arrive. The hour floor exists for ' +
      'testnet rehearsal.');
  }
  if (deadline < now + notice + window) {
    throw new Error(
      `CLAIM_DEADLINE ${deadline} is earlier than now + CLAIM_NOTICE_SECONDS + CLAIM_WINDOW_SECONDS ` +
      `(${now + notice + window}). The constructor refuses it: no round could ever be registered.`);
  }

  // ---- has the vesting contract already been sealed? --------------------
  const vesting = record.addresses?.HCOWVesting;
  if (vesting) {
    const v = at('HCOWVesting', vesting, provider);
    const sealed = await v.sealed_();
    console.log(`vesting   ${vesting}  ${sealed ? 'SEALED' : 'not sealed'}`);
    if (sealed) {
      throw new Error(
        'HCOWVesting is already sealed. Its beneficiaries are fixed forever, so the ' +
        'Community/Airdrop bucket will pay whatever address was sealed in and never this one. ' +
        'A claim contract deployed now cannot be funded by vesting. Deploy order is spec section 9: ' +
        'claim contract first, beneficiary set to it, then seal.');
    }
  } else {
    console.log('vesting   not recorded for this chain; cannot check whether it is sealed');
  }

  // ---- deploy -----------------------------------------------------------
  if (dryRun) {
    console.log('\nDRY RUN. Every check above passed. These are the constructor arguments that');
    console.log('would be used, and nothing has been sent or written:');
    console.log(`  token          ${token}`);
    console.log(`  owner          ${owner}`);
    console.log(`  claimDeadline  ${deadline}  (${new Date(deadline * 1000).toISOString()})`);
    console.log(`  minRoundNotice ${notice}  (${(notice / 3600).toFixed(1)} hours)`);
    console.log(`  minClaimWindow ${window}  (${(window / DAY).toFixed(1)} days)`);
    console.log('\nRe-run without DRY_RUN / PRINT_ONLY to deploy.');
    return;
  }
  const c = await deploy('HCOWClaim', signer, [token, owner, deadline, notice, window]);
  const claim = await c.getAddress();
  const tx = c.deploymentTransaction().hash;
  console.log(`\nHCOWClaim ${claim}  tx ${tx}`);

  // Read the constructor arguments back off the chain rather than trusting
  // what was sent. A wrongly encoded argument is silent and this is the last
  // cheap moment to notice: token and owner cannot be changed afterwards and
  // the deadline can only move one way.
  const cc = at('HCOWClaim', claim, provider);
  const [oTok, oOwner, oDeadline, oMin, oNotice, oWindow] = await Promise.all([
    cc.token(), cc.owner(), cc.claimDeadline(), cc.minClaimAmount(),
    cc.minRoundNotice(), cc.minClaimWindow(),
  ]);
  const bad = [];
  if (oTok.toLowerCase() !== token.toLowerCase()) bad.push(`token ${oTok}`);
  if (oOwner.toLowerCase() !== owner.toLowerCase()) bad.push(`owner ${oOwner}`);
  if (oDeadline !== BigInt(deadline)) bad.push(`claimDeadline ${oDeadline}`);
  if (oMin !== 0n) bad.push(`minClaimAmount ${oMin}, expected 0`);
  // Both are immutable. A wrongly encoded one is silent and cannot be fixed.
  if (oNotice !== BigInt(notice)) bad.push(`minRoundNotice ${oNotice}, expected ${notice}`);
  if (oWindow !== BigInt(window)) bad.push(`minClaimWindow ${oWindow}, expected ${window}`);
  if (bad.length) throw new Error('the deployed contract does not read back as deployed:\n  ' + bad.join('\n  '));
  console.log('          token, owner, deadline, notice, window and a zero minClaimAmount all read back correctly');

  const rec = {
    ...record,
    chainId,
    addresses: { ...(record.addresses || {}), HCOWToken: token, HCOWClaim: claim },
    deploymentTxs: { ...(record.deploymentTxs || {}), HCOWClaim: tx },
    claim: {
      deployedAt: new Date().toISOString(),
      deployedBy: me,
      owner,
      claimDeadline: deadline,
      token,
    },
  };
  console.log(`written to ${writeRecord(chainId, rec)}`);

  console.log('\nNEXT, IN ORDER:');
  console.log(`  1. Set the Community/Airdrop beneficiary to ${claim}`);
  console.log('     THIS IS THE POINT OF NO RETURN. seal() fixes it forever.');
  console.log('  2. node scripts/load.cjs and node scripts/seal.cjs');
  console.log('  3. After TGE, release the bucket so tokens arrive here');
  console.log('  4. node scripts/build-merkle.cjs <recipients> --policy <policy.json> --tge <tge>');
  console.log('  5. node scripts/set-root.cjs --rounds build/merkle/rounds.json --round 0');
  console.log('\nVerify on BscScan with solc 0.8.34, optimizer 200 runs, evmVersion paris.');
  console.log('Constructor arguments, ABI-encoded:');
  console.log('  ' + new ethers.AbiCoder().encode(['address', 'address', 'uint256', 'uint256', 'uint256'],
    [token, owner, deadline, notice, window]).slice(2));
}

main().catch((e) => { console.error('\n' + (e.message || e)); process.exitCode = 1; });
