'use strict';
// Registers one round's Merkle root on a deployed HCOWClaim, after proving the
// root again from the tree file rather than trusting the summary.
//
//   RPC_URL=... CHAIN_ID=97 TREASURY_KEY=0x... \
//   node scripts/set-root.cjs --rounds build/merkle/rounds.json --round 0
//
//   PRINT_ONLY=yes / DRY_RUN=yes ...   prints to / data for the treasury Safe instead
//                                      of sending. TREASURY_KEY is not needed.
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
const { vestedAt } = require('./commitcheck.cjs');
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
  // 8차 감사 M-9. 이전 판은 needSigner 를 주지 않아 PRINT_ONLY 에서도
  // TREASURY_KEY 를 요구했다. PRINT_ONLY 의 존재 이유가 "트레저리 개인키는
  // 스크립트에 없고 있어서도 안 되므로 to/data 만 뽑아 Safe 에서 서명한다" 인데,
  // 뽑으려면 개인키가 있어야 했다. load.cjs 는 처음부터 맞게 돼 있었다.
  const noSend = suppressed();
  const { provider, signer, net, mainnet } = await connect({ keyVar: 'TREASURY_KEY', needSigner: !noSend });
  const chainId = Number(net.chainId);
  const record = readRecord(chainId) || {};
  const claimAddr = o.claim || record.addresses?.HCOWClaim;
  // 10차 감사. --claim 이 레코드의 HCOWClaim 과 다르면 이 스크립트는 고르지 않는다.
  // 재현: 레코드가 가리키는 claim 과 다른 주소를 --claim 으로 주면 대조 없이
  // exit 0 이었다. 둘 중 하나는 자금이 없는 claim 이고, 그 claim 에 등록된 루트는
  // 아무에게도 지급하지 않는 채로 개시·동결된다.
  const recordedClaim = record.addresses?.HCOWClaim;
  if (o.claim && recordedClaim && o.claim.toLowerCase() !== recordedClaim.toLowerCase()) {
    throw new Error(
      `--claim ${o.claim} but deployments/${chainId}.json records HCOWClaim as ${recordedClaim}. One ` +
      'of the two is wrong and this script will not pick. Vesting funds only the address it was ' +
      'deployed with, so a root registered on the other one pays nobody.');
  }
  if (!claimAddr) throw new Error('--claim <address> is required, or deployments/<chain>.json must name HCOWClaim');

  // 9차 감사 B-F8. --claim 은 CLI 로 직접 받는, 이 저장소에서 오타 위험이 가장
  // 큰 주소다. anchor.cjs 와 deploy-claim.cjs 는 코드 존재를 먼저 보는데 여기만
  // 없어서, 오타를 내면 ethers 내부 오류(BAD_DATA)로 끝났다.
  if (!ethers.isAddress(claimAddr)) throw new Error(`--claim ${claimAddr} is not an address`);
  if (await provider.getCode(claimAddr) === '0x') {
    throw new Error(
      `there is no contract at ${claimAddr} on chain ${chainId}. That address came from ` +
      `${o.claim ? '--claim' : `deployments/${chainId}.json`}. Check it before anything is signed.`);
  }
  const claim = at('HCOWClaim', claimAddr, provider);
  const [owner, onchain, tokenAddr] = await Promise.all([claim.owner(), claim.rounds(roundId), claim.token()]);
  // 키가 없을 때 찍을 `from` 은 체인에서 읽은 owner 다. 이 호출을 실제로 보낼 수
  // 있는 주소가 그것 하나이고, 레코드의 treasury 가 아니라 체인이 근거여야 한다.
  const me = noSend ? owner : await signer.getAddress();
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

  // 7차 감사 M-7. 컨트랙트는 startTime > claimDeadline − minClaimWindow 인 라운드를
  // ClaimWindowTooShort 로 거부한다 (design note 8). 이 스크립트는 그것을 미리 보지
  // 않았다. 위 LEAD 검사 주석이 스스로 적은 대로, 컨트랙트가 거부할 호출을 준비하는
  // 스크립트는 검사가 없는 것보다 나쁘다: PRINT_ONLY 로 뽑은 호출이 며칠 뒤 Safe
  // 실행에서야 되돌려지고, 그동안 라운드는 등록되지 않은 채로 남는다.
  const [clDeadline, clWindow] = await Promise.all([claim.claimDeadline(), claim.minClaimWindow()]);
  const latestStart = Number(clDeadline) - Number(clWindow);
  if (tree.startTime > latestStart) {
    throw new Error(
      `round ${roundId} opens at ${new Date(tree.startTime * 1000).toISOString()}, but every round must open ` +
      `at least minClaimWindow (${(Number(clWindow) / 86400).toFixed(1)} days) before claimDeadline ` +
      `(${new Date(Number(clDeadline) * 1000).toISOString()}), so the latest start is ` +
      `${new Date(latestStart * 1000).toISOString()}. setRoot would revert with ClaimWindowTooShort. ` +
      'Rebuild with an earlier start, or have the owner call extendDeadline first. Nothing has been sent.');
  }

  // ---- 체인에 등록된 라운드 전부 (14·15차 감사 잔여) ------------------------
  //
  // 아래의 누계 검사는 rounds.json 에 있는 라운드만 센다. 라운드 매핑은 열거할 수
  // 없으므로, 이 빌드에 없는 roundId 로 체인에 등록된 루트는 보이지 않았다. 그 루트도
  // 같은 잔고에서 지급한다. 재빌드에서 빈 라운드가 빠지거나 Safe 로 손으로 등록한
  // 경우가 그렇다. 유일하게 완전한 목록은 RoundSet 이벤트다. claim 이 배포된 블록부터
  // 끝까지 읽는다. 값싼 입력 검사(LEAD · MAX_AHEAD · 창)가 모두 끝난 뒤에 돈다:
  // 메인넷에서는 요청이 수천 번이다.
  //
  // 시작 블록 (재검 F2 · F4): CLAIM_FROM_BLOCK > 레코드의 claim.deployedBlock >
  // 레코드의 배포 트랜잭션 영수증 > (메인넷 밖) 0. 메인넷에서 아무것도 없으면 멈춘다.
  // 노드는 오래된 트랜잭션 색인을 지우므로 영수증은 배포 후 몇 주면 사라질 수 있다.
  const recordedIsThis = recordedClaim && recordedClaim.toLowerCase() === claimAddr.toLowerCase();
  const headBlock = Number(await provider.send('eth_blockNumber', []));
  let recordedFrom = null;
  if (recordedIsThis && record.claim && record.claim.deployedBlock !== undefined) {
    recordedFrom = Number(record.claim.deployedBlock);
    if (!Number.isInteger(recordedFrom) || recordedFrom < 0) {
      throw new Error(`deployments/${chainId}.json claim.deployedBlock is ${JSON.stringify(record.claim.deployedBlock)}, not a block number.`);
    }
  }
  let fromBlock = null;
  let fromWhy = '';
  if (process.env.CLAIM_FROM_BLOCK !== undefined) {
    const raw = String(process.env.CLAIM_FROM_BLOCK).trim();
    fromBlock = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(fromBlock)) {
      throw new Error(`CLAIM_FROM_BLOCK must be a block number, got ${JSON.stringify(process.env.CLAIM_FROM_BLOCK)}`);
    }
    // 재검 F2: 오타 한 자리가 이 검사를 조용히 끈다. 머리 블록보다 크거나, 기록된
    // 배포 블록보다 늦은 값은 받지 않는다.
    if (fromBlock > headBlock) {
      throw new Error(`CLAIM_FROM_BLOCK ${fromBlock} is past the chain head ${headBlock}. Nothing would be read.`);
    }
    if (recordedFrom !== null && fromBlock > recordedFrom) {
      throw new Error(`CLAIM_FROM_BLOCK ${fromBlock} is later than the block the claim was deployed in (${recordedFrom}, ` +
                      `from deployments/${chainId}.json). Events before it would be skipped.`);
    }
    fromWhy = 'CLAIM_FROM_BLOCK';
  } else if (recordedFrom !== null) {
    fromBlock = recordedFrom;
    fromWhy = 'the recorded deployment block';
  } else if (recordedIsThis && record.deploymentTxs?.HCOWClaim) {
    let rc = null;
    try { rc = await provider.getTransactionReceipt(record.deploymentTxs.HCOWClaim); } catch (_) { rc = null; }
    if (!rc) {
      throw new Error(
        `this RPC returns no receipt for ${record.deploymentTxs.HCOWClaim}, the transaction deployments/${chainId}.json ` +
        'names as deploying the claim contract. Nodes drop old transaction indexes, so this is expected some weeks ' +
        'after deployment. Set CLAIM_FROM_BLOCK to the block the claim contract was deployed in (BscScan shows it). ' +
        'Nothing has been sent.');
    }
    if (String(rc.contractAddress || '').toLowerCase() !== claimAddr.toLowerCase()) {
      throw new Error(
        `deployments/${chainId}.json names ${record.deploymentTxs.HCOWClaim} as the transaction that deployed ` +
        `HCOWClaim ${claimAddr}, but that transaction created ${rc.contractAddress || 'no contract'}. The record is ` +
        'wrong. Set CLAIM_FROM_BLOCK to the block the claim contract was deployed in. Nothing has been sent.');
    }
    fromBlock = Number(rc.blockNumber);
    fromWhy = 'the recorded deployment transaction';
  } else if (!mainnet) {
    fromBlock = 0;
    fromWhy = 'block 0 (no deployment block recorded; allowed off mainnet)';
  } else {
    throw new Error(
      `this script reads every RoundSet event the claim contract has emitted, from the block it was deployed ` +
      `in, and deployments/${chainId}.json records neither that block nor the deployment transaction of ` +
      `${claimAddr}. Set CLAIM_FROM_BLOCK to that block (BscScan shows it on the contract page). Nothing has been sent.`);
  }
  const maxRange = Number(process.env.LOG_RANGE ?? 5000);
  if (!Number.isInteger(maxRange) || maxRange < 1) throw new Error('LOG_RANGE must be a positive whole number of blocks');
  const rsTopic = claim.interface.getEvent('RoundSet').topicHash;
  // 재재검 N1 · N2: 시작 블록이 맞는지 스캔 스스로 증명한다. HCOWClaim 은 생성자에서
  // OwnershipTransferred(0 → owner) 를 딱 한 번 낸다 (OZ Ownable. renounceOwnership 은
  // 막혀 있고, 이후의 소유권 이전은 이전 소유자가 0 이 아니다). 그 이벤트를 같은
  // 필터에 넣어 (요청 수는 늘지 않는다) 찾지 못하면 멈춘다. 시작 블록을 어디서
  // 얻었든 (CLAIM_FROM_BLOCK 오타 · 틀린 레코드 · 옛 로그를 안 주는 노드) 같은 검사다.
  const otTopic = claim.interface.getEvent('OwnershipTransferred').topicHash;
  const zeroTopic = ethers.zeroPadValue('0x', 32);
  const registeredIds = new Set();
  let sawConstructor = false;
  let requests = 0;
  let range = maxRange;
  // 재검 F1: 일시적 오류 한 번이 범위를 영구히 반으로 줄였고, 범위 1에서 오류가 한 번
  // 더 나면 멈췄다. 같은 범위를 두 번 더 시도한 뒤에야 줄인다. (재재검 N3: 범위를 다시
  // 키우던 것은 뺐다. 노드의 범위 상한 아래로 줄어든 뒤 매번 다시 부딪혀 요청을 낭비했다.)
  for (let from = fromBlock; from <= headBlock;) {
    const to = Math.min(from + range - 1, headBlock);
    let logs = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3 && logs === null; attempt++) {
      try {
        requests++;
        logs = await provider.getLogs({ address: claimAddr, topics: [[rsTopic, otTopic]], fromBlock: from, toBlock: to });
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    if (logs === null) {
      if (range > 1) { range = Math.max(1, Math.floor(range / 2)); continue; }
      throw new Error(`could not read RoundSet events for block ${from}: ${lastErr.shortMessage || lastErr.message}. ` +
                      'Nothing has been sent.');
    }
    for (const l of logs) {
      if (l.topics[0] === otTopic) {
        if (String(l.topics[1]).toLowerCase() === zeroTopic) sawConstructor = true;
        continue;
      }
      registeredIds.add(claim.interface.parseLog(l).args.roundId.toString());
    }
    from = to + 1;
  }
  if (!sawConstructor) {
    throw new Error(
      `the scan from block ${fromBlock} (${fromWhy}) did not find the claim contract's constructor event ` +
      `(OwnershipTransferred from the zero address). So it did not start at or before ${claimAddr} was deployed, ` +
      'or this RPC does not serve logs that old, and its list of registered rounds cannot be trusted. Set ' +
      'CLAIM_FROM_BLOCK to the block the claim contract was deployed in, or use an RPC with full log history. ' +
      'Nothing has been sent.');
  }
  console.log(`rounds    ${registeredIds.size} registered on chain (RoundSet events from block ${fromBlock}, ` +
              `${fromWhy}; ${requests} request${requests === 1 ? '' : 's'})`);
  // 재검 F2: 스캔이 완전한지 스스로 확인한다. 이 빌드의 라운드 중 체인에 등록된 것은
  // 모두 이벤트에 있어야 한다. 없으면 시작 블록이 너무 늦었거나 노드가 옛 로그를 주지
  // 않은 것이고, 그 스캔의 "모르는 라운드 0개" 는 믿을 수 없다.
  const missed = [];
  for (const r of summary.rounds) {
    const oc = await claim.rounds(r.roundId);
    if (oc.merkleRoot !== ethers.ZeroHash && !registeredIds.has(String(r.roundId))) missed.push(r.roundId);
  }
  if (onchain.merkleRoot !== ethers.ZeroHash && !registeredIds.has(String(roundId)) && !missed.includes(roundId)) missed.push(roundId);
  if (missed.length) {
    throw new Error(
      `round${missed.length > 1 ? 's' : ''} ${missed.join(', ')} ${missed.length > 1 ? 'are' : 'is'} registered on chain, but no ` +
      `RoundSet event for ${missed.length > 1 ? 'them' : 'it'} was found from block ${fromBlock} (${fromWhy}). The scan is ` +
      'incomplete: the start block is too late, or this RPC does not serve old logs. Its answer about rounds ' +
      'outside this build cannot be trusted. Nothing has been sent.');
  }
  const fileIds = new Set(summary.rounds.map((r) => String(r.roundId)));
  const unknown = [...registeredIds].filter((id) => !fileIds.has(id) && id !== String(roundId));
  if (unknown.length) {
    const lines = [];
    for (const id of unknown) {
      const oc = await claim.rounds(id);
      lines.push(`round ${id}: root ${oc.merkleRoot}, opening ${new Date(Number(oc.startTime) * 1000).toISOString()}`);
    }
    const what = `registered on chain but not in ${roundsFile}:\n  ${lines.join('\n  ')}\n` +
      'They pay out of the same balance, and without their files their totals cannot be counted. Put each ' +
      'one\'s entry in rounds.json and its round-<n>.json back into this build (from the build that registered it).';
    // 재검 F3: 이 탈출구는 ALLOW_UNDERFUNDED 와 따로 둔다. 옛 빌드 파일을 한 번 잃으면
    // 이후 모든 실행에 필요해지는데, 같은 플래그면 자금 검사 둘까지 영구히 꺼진다.
    if (!dryFlag('ALLOW_UNKNOWN_ROUNDS')) {
      throw new Error(`${unknown.length} round${unknown.length > 1 ? 's' : ''} ${what} Or set ALLOW_UNKNOWN_ROUNDS=yes ` +
                      'to go ahead without counting them. Nothing has been sent.');
    }
    console.log(`          WARNING: ${unknown.length} round${unknown.length > 1 ? 's' : ''} ${what}`);
    console.log('          ALLOW_UNKNOWN_ROUNDS is set, so this is going ahead without counting them.');
  }

  // The README says this script checks that the contract holds enough to pay
  // the round. It said that while this was a console.log. (Audit 4, H-9.)
  // Claims revert safely when underfunded, so this is a stop and not a
  // disaster, but the document has to be true.
  // 11차 감사. 이 검사는 "지금 claim 이 들고 있는 잔고" 만 봤다. 그런데 0번
  // 라운드(TGE 지급, 공개 약속 "시즌 1 상금 HCOW 는 TGE 시점 지급")는 구조상
  // TGE 전에 등록해야 하고(minRoundNotice), 그 시점에 claim 잔고는 언제나 0 이다 —
  // 베스팅은 TGE 에야 풀린다. 재현: 정해진 순서대로 가면 0번 라운드는
  // ALLOW_UNDERFUNDED=yes 없이는 등록되지 않았다. 즉 이 가드는 가장 중요한
  // 라운드에서 한 번도 작동하지 않고 매번 꺼지고 있었다.
  //
  // 맞는 질문은 "startTime 에 이 라운드를 낼 수 있는가" 다. 봉인된 베스팅이
  // 이 claim 에 줄 몫 중 startTime 까지 풀릴 양(누가 그 시점에 release 를
  // 부르면 들어올 양)을 더한다. 베스팅이 봉인되지 않았으면 release() 가
  // 되돌려지므로 0 으로 센다.
  let pending = 0n;
  let pendingNote = '';
  let willBeVested = null;   // 봉인된 베스팅이 startTime 까지 이 claim 에 풀어줄 누계. 없으면 null
  let directFloor = 0n;
  const vestingAddr = record.addresses?.HCOWVesting;
  // 12차 감사 M-B 때문에 held 가 충분해도 베스팅을 읽는다: 아래 누계 검사에 필요하다.
  if (vestingAddr) {
    const v = at('HCOWVesting', vestingAddr, provider);
    const [vSealed, vTge, sched] = await Promise.all([
      v.sealed_().catch(() => false), v.tgeTime().catch(() => 0n), v.schedules(claimAddr).catch(() => null),
    ]);
    if (vSealed && sched && sched.exists) {
      willBeVested = vestedAt(
        { total: sched.total, tgeBps: sched.tgeBps, cliffMonths: sched.cliffMonths, linearMonths: sched.linearMonths },
        vTge, tree.startTime);
      pending = willBeVested > sched.released ? willBeVested - sched.released : 0n;
      // 누계 검사에 쓸, 베스팅 밖에서 들어온 양의 하한. held = released + 직접송금 − 청구분
      // 이고 청구분 >= 0 이므로 직접송금 >= held − released, 그리고 >= 0.
      directFloor = held > sched.released ? held - sched.released : 0n;
      pendingNote = `vesting ${vestingAddr} will have released ${hcow(pending)} more HCOW to it by the round's start`;
    } else if (!vSealed) {
      pendingNote = `vesting ${vestingAddr} is not sealed, so nothing it holds counts yet`;
    } else {
      pendingNote = `vesting ${vestingAddr} has no schedule for this claim contract`;
    }
    if (held < total) console.log(`          ${pendingNote}`);
  }
  if (held + pending < total) {
    if (!dryFlag('ALLOW_UNDERFUNDED')) {
      throw new Error(
        `the round pays ${hcow(total)} HCOW and the contract holds ${hcow(held)}${pending ? ` plus ${hcow(pending)} the vesting will release by then` : ''}. Every claim past the ` +
        'balance reverts with InsufficientBalance until the vesting release lands, and the root is frozen ' +
        'the moment the round opens. Release the bucket first, or set ALLOW_UNDERFUNDED=yes if opening ' +
        'ahead of funding is deliberate.');
    }
    console.log(`          WARNING: the round pays ${hcow(total)} HCOW and only ${hcow(held)} is here. ` +
                'ALLOW_UNDERFUNDED is set, so this is going ahead.');
  } else if (held < total) {
    console.log(`          funded at start: ${hcow(held)} held now plus what vesting releases by then. Someone must call`);
    console.log(`          release(${claimAddr}) on the vesting contract at or after the round opens;`);
    console.log('          until then claims revert whole with InsufficientBalance and nothing is lost.');
  }
  // 12차 감사 M-B. 바로 위 검사는 이 라운드 하나만 본다. 그런데 HCOWClaim 은 모든
  // 라운드가 잔고 하나를 나눠 쓴다 (_claim 은 balanceOf(this) >= amount 만 본다).
  // held 에는 앞 라운드가 아직 받아가지 않은 몫이 들어 있다. 재현: 0번 라운드를
  // TGE 언락 전액으로 등록한 뒤, 단독으로는 맞지만 누계로는 1,000 HCOW 넘치는
  // 1번 라운드가 exit 0 으로 등록됐다. 1번 청구자는 받았고 0번(TGE 상금 포함)
  // 청구는 InsufficientBalance 로 막혔다. 잃은 것은 없지만(청구가 통째로 되돌려진다)
  // 앞 라운드가 뒤 라운드에 밀리는 선착순이 된다.
  //
  // 맞는 질문: 이 라운드가 열릴 때까지 베스팅이 이 claim 에 푼 누계가, 그때까지
  // 열리는 모든 라운드 합계 이상인가. 청구된 양과 무관한 부등식이다 (둘 다에서
  // 같이 빠진다). 직접 송금은 하한(held − released, 0 이상)만 세므로 안전한 쪽으로
  // 틀린다. 합계는 이 라운드 파일들에서 다시 계산하고, 이미 등록된 라운드는 체인의
  // 루트와 대조한다.
  // 이 스크립트가 알 수 없는 것: 이 빌드에 없는 roundId 로 체인에 등록된 루트.
  // 매핑은 열거할 수 없다.
  //
  // 13차 감사로 세 가지를 더 닫았다.
  //  (a) 이 라운드보다 **뒤에** 열리도록 이미 등록된 라운드도 본다. 앞선 날짜의
  //      라운드를 나중에 끼워 넣으면, 그 뒤에 이미 등록된 라운드가 넘치게 된다.
  //      재현: 0~4번 등록 뒤 7번(+45일)을 끼우니 exit 0, 2번 청구 3건 실패. 이제
  //      이 라운드의 시작과, 그 뒤에 등록된 각 라운드의 시작마다 누계를 잰다.
  //  (b) 등록된 라운드의 시작 시각은 파일이 아니라 체인에서 읽는다. 루트는 시작
  //      시각을 담지 않으므로, 파일과 다른 시각으로 등록된 라운드를 파일 시각으로
  //      걸러 빠뜨렸다 (재현함).
  //  (c) 베스팅 수치가 없으면(베스팅 미기록 · 미봉인 · 이 claim 의 행 없음) 누계를
  //      계산만 하고 무시했다. 그때는 지금 잔고가 아직 열리지 않은 라운드 합계를
  //      덮는지 본다. 이미 열린 라운드의 남은 몫은 청구량을 모르므로 세지 못한다.
  const included = [{ roundId, start: tree.startTime, total, registered: false, self: true }];
  const staleRounds = [];
  for (const r of summary.rounds) {
    if (r.roundId === roundId) continue;
    const oc = await claim.rounds(r.roundId);
    const onRoot = String(oc.merkleRoot).toLowerCase();
    const fileRoot = String(r.merkleRoot).toLowerCase();
    const registered = onRoot !== ethers.ZeroHash;
    // 14차 감사 M-1. 13차 판은 등록된 루트가 파일과 다르면 무조건 멈췄다. 그런데
    // TGE 전 정정(수령자 추가 → build-merkle 재실행)은 모든 라운드의 루트를 바꾸고,
    // 아직 열리지 않은 라운드는 교체가 정당한 유일한 정정 경로다. 재현: 0~4번을
    // 미리 등록한 뒤 재빌드하니 어떤 순서로도 모든 라운드가 거부됐고 우회 플래그도
    // 없었다. 이제 **이미 열린** 라운드만 멈춘다(그 루트는 영원히 고정이고 이 빌드는
    // 그 빚을 모른다). 아직 열리지 않은 라운드는 파일의 판으로 세고, 더 이른 시각으로
    // 세며(체인과 파일 중), 열리기 전에 교체하라고 크게 경고한다. 옛 루트의 합계는
    // 이 스크립트가 읽을 수 없다.
    let stale = false;
    if (registered && onRoot !== fileRoot) {
      if (Number(oc.startTime) <= nowTs) {
        throw new Error(
          `round ${r.roundId} is registered on chain with root ${oc.merkleRoot} and has already opened, but ` +
          `${roundsFile} names ${r.merkleRoot}. That root is frozen and this build does not describe what it ` +
          'owes, so this script cannot tell whether the balance covers round ' + roundId + ' as well. ' +
          'Nothing has been sent.');
      }
      // 15차 감사 F1. 열리지 않았어도 이제 교체할 수 없는 라운드가 있다: 파일의 시작이
      // LEAD(>= notice) 안이면 setRoot 가 되돌려지고 이 스크립트도 거부하며, 체인의
      // 시작이 LEAD 안이면 대기 중인 Safe 트랜잭션보다 옛 루트가 먼저 열린다. 그때
      // 실제로 지급하는 것은 옛 루트이므로 파일의 판으로 셀 수 없다. 열린 것과 같이 멈춘다.
      // 재현: 옛 루트가 2일 뒤 열리고 LEAD 3일일 때 exit 0, 이후 0번 청구가 실패했다.
      if (Number(oc.startTime) - nowTs < LEAD || Number(r.startTime) - nowTs < LEAD) {
        throw new Error(
          `round ${r.roundId} is registered on chain with root ${oc.merkleRoot}, opening ` +
          `${new Date(Number(oc.startTime) * 1000).toISOString()}, but ${roundsFile} names ${r.merkleRoot}` +
          ` opening ${new Date(Number(r.startTime) * 1000).toISOString()}. It can no longer be replaced in ` +
          `time (a ${(LEAD / 3600).toFixed(1)} hour margin is needed on both), so the old root is what it ` +
          'will pay and this build does not describe it. Nothing has been sent. (16차: to register other ' +
          `rounds from this build, put back round ${r.roundId}'s entry in rounds.json and its round file ` +
          'from the build that produced the on-chain root, so the two agree.)');
      }
      stale = true;
      staleRounds.push(r.roundId);
    }
    let start;
    if (stale) {
      start = Math.min(Number(oc.startTime), Number(r.startTime));
    } else if (registered) {
      start = Number(oc.startTime);
      if (start !== Number(r.startTime)) {
        console.log(`          round ${r.roundId} is registered on chain to open ${new Date(start * 1000).toISOString()}, ` +
                    `not at the file's ${new Date(Number(r.startTime) * 1000).toISOString()}; using the chain`);
      }
    } else {
      start = Number(r.startTime);
      if (start <= nowTs + notice) {
        // 등록되지 않았고, 이제는 그 startTime 으로 등록할 수도 없다 (notice). 빚이 아니다.
        console.log(`          round ${r.roundId} is not registered and can no longer open at its start; not counted`);
        continue;
      }
      // 이 라운드보다 뒤에 열릴 미등록 라운드는 그것을 등록할 때 이 검사를 받는다.
      if (start > tree.startTime) continue;
    }
    const f = path.join(path.dirname(path.resolve(roundsFile)), `round-${r.roundId}.json`);
    if (!fs.existsSync(f)) {
      throw new Error(`${roundsFile} lists round ${r.roundId}, which this check has to count, but ${f} is missing. ` +
                      'Its total cannot be checked, so the balance cannot be checked. Nothing has been sent.');
    }
    const t = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (String(t.merkleRoot).toLowerCase() !== fileRoot) {
      throw new Error(`${f} and ${roundsFile} name different roots for round ${r.roundId}. Nothing has been sent.`);
    }
    // 14차 감사(기존 결함). 다른 라운드의 합계는 claims 목록에서 더하는데, 그 목록이
    // 루트 필드와 맞는지는 보지 않았다. 이 라운드처럼 다시 빌드해 대조한다.
    const rb = buildRound(r.roundId, Object.entries(t.claims).map(([account, c]) => ({ account, amount: c.amount })));
    if (rb.root.toLowerCase() !== fileRoot) {
      throw new Error(`${f}'s claims rebuild to ${rb.root}, not the root ${r.merkleRoot} it names. Its total cannot ` +
                      'be trusted, so the balance cannot be checked. Nothing has been sent.');
    }
    const rTotal = Object.values(t.claims).reduce((a, c) => a + BigInt(c.amount), 0n);
    included.push({ roundId: r.roundId, start, total: rTotal, registered });
  }
  included.sort((a, b) => a.start - b.start);
  if (staleRounds.length) {
    console.log(`          WARNING: round${staleRounds.length > 1 ? 's' : ''} ${staleRounds.join(', ')} ` +
                `${staleRounds.length > 1 ? 'are' : 'is'} registered with a different root than this build and ` +
                'not yet open. This check counts the build\'s version. Replace each with set-root before it ' +
                'opens: until then the old root is what it pays, and its total is not known here.');
  }
  const others = included.filter((x) => !x.self);
  if (others.length) {
    console.log(`          rounds counted with this one: ` + others.map((x) =>
      `round ${x.roundId} ${hcow(x.total)}${x.registered ? '' : ' (not registered yet)'}` +
      `${x.start > tree.startTime ? ' (opens later)' : ''}`).join(', '));
  }
  // 이 라운드의 시작, 그리고 그 뒤에 등록된 각 라운드의 시작이 검사 시점이다.
  const checkpoints = included.filter((x) => x.start >= tree.startTime && (x.self || x.registered));
  for (const cp of checkpoints) {
    const upTo = included.filter((x) => x.start <= cp.start);
    let need, have, what;
    if (willBeVested !== null) {
      need = upTo.reduce((a, x) => a + x.total, 0n);
      const v = at('HCOWVesting', vestingAddr, provider);
      const sched = await v.schedules(claimAddr);
      const vTge = await v.tgeTime();
      const vested = vestedAt(
        { total: sched.total, tgeBps: sched.tgeBps, cliffMonths: sched.cliffMonths, linearMonths: sched.linearMonths },
        vTge, cp.start);
      have = vested + directFloor;
      what = `the vesting will have released ${hcow(vested)} HCOW to this claim contract in total` +
             `${directFloor ? ` (plus at least ${hcow(directFloor)} sent to it directly)` : ''}`;
    } else {
      need = upTo.filter((x) => x.start > nowTs).reduce((a, x) => a + x.total, 0n);
      have = held;
      what = `there is no sealed vesting figure for this claim contract, and it holds ${hcow(held)} HCOW`;
    }
    if (have < need) {
      const at_ = cp.self ? `round ${roundId} opens` : `round ${cp.roundId} (already registered) opens`;
      if (!dryFlag('ALLOW_UNDERFUNDED')) {
        throw new Error(
          `by the time ${at_}, ${what}, but the rounds open by then pay ${hcow(need)} HCOW in total ` +
          `(${upTo.map((x) => `round ${x.roundId} ${hcow(x.total)}`).join(', ')}). The contract has one balance ` +
          'for all rounds, so whoever claims first is paid and an earlier round\'s claimants can be the ones ' +
          'left waiting. Move this round later, or set ALLOW_UNDERFUNDED=yes if that is deliberate.');
      }
      console.log(`          WARNING: by the time ${at_} the rounds open by then pay ${hcow(need)} HCOW and ` +
                  `only ${hcow(have)} is accounted for. ALLOW_UNDERFUNDED is set, so this is going ahead.`);
    }
  }
  // 7차 감사 H-3. 이 스크립트는 PRINT_ONLY 만 알고 DRY_RUN 을 몰랐다.
  // DRY_RUN=yes 는 정의되지 않은 환경변수로 무시되고 setRoot 가 실제로 나갔다.
  if (!noSend && owner.toLowerCase() !== me.toLowerCase()) {
    // 8차 감사 L-4. 문구가 PRINT_ONLY 만 안내했다. 7차 조치로 두 이름은 같은 뜻이다.
    throw new Error(
      `TREASURY_KEY is ${me} but the owner is ${owner}. Re-run with PRINT_ONLY=yes (or DRY_RUN=yes, ` +
      'the same thing) to print `to` and `data`, and sign it from the Safe. Neither name needs ' +
      'TREASURY_KEY to be set at all.');
  }

  await sendOrPrint(
    `setRoot(${roundId}, ${tree.merkleRoot}, ${tree.startTime})`,
    at('HCOWClaim', claimAddr, signer), 'setRoot', [roundId, tree.merkleRoot, tree.startTime], { from: me });
}

main().catch((e) => { console.error('\n' + (e.message || e)); process.exitCode = 1; });
