'use strict';
// Anchors one hour of game rounds. Meant to run on a schedule, once an hour.
//
//   RPC_URL=... CHAIN_ID=97 PUBLISHER_KEY=0x... \
//   ANCHOR_ADDRESS=0x... ROUNDS_FILE=rounds-2026-09-16T13.json \
//   node scripts/anchor.cjs
//
//   Add DRY_RUN=1 to build and check the batch and print the calldata without
//   sending anything. The first run against a new store should always be a dry
//   run, because a wrong root cannot be replaced once it is anchored.
//
// THE INPUT
//
// ROUNDS_FILE is a JSON array of round records as the fairness engine emits
// them. Only three fields are read:
//
//   { "roundHash": "<64 hex>", "epochKey": "<64 hex>", "nonce": 0 }
//
// Extra fields are ignored, so the file can be the engine's full records. What
// must not be in it is a round from another hour: this script anchors exactly
// what it is given and the period it is given, and it cannot tell whether the
// two match. Selecting the hour is the store's job, not this script's.
//
// WHAT AN ANCHORED ROOT PROVES AND WHAT IT DOES NOT
//
// It proves the rounds in the batch were fixed before the transaction. It does
// not prove the batch holds every round of its hour. Nothing here and nothing
// in HCOWAnchor supports the stronger claim, and the public wording must not
// make it either.

const fs = require('fs');
const path = require('path');
const { connect, at, readRecord, ethers, dryFlag, suppressed } = require('./_connect.cjs');
const { buildBatch, PERIOD } = require('./anchor-merkle.cjs');

function loadRounds(file) {
  if (!file) throw new Error('ROUNDS_FILE must be set');
  if (!fs.existsSync(file)) throw new Error(`ROUNDS_FILE not found: ${file}`);
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`ROUNDS_FILE is not valid JSON: ${e.message}`); }
  if (!Array.isArray(rows)) throw new Error('ROUNDS_FILE must contain a JSON array');
  return rows.map((r) => ({ roundHash: r.roundHash, epochKey: r.epochKey, nonce: r.nonce }));
}

/**
 * The period to anchor.
 *
 * PERIOD_START if given, otherwise the hour before the current one. Never the
 * current hour: it is not over, so rounds are still arriving and a batch built
 * now would be missing them with no way to add them later.
 */
function periodToAnchor() {
  if (process.env.PERIOD_START) {
    const p = Number(process.env.PERIOD_START);
    if (!Number.isSafeInteger(p) || p <= 0) throw new Error('PERIOD_START must be a unix second');
    if (p % PERIOD !== 0) throw new Error(`PERIOD_START ${p} is not aligned to ${PERIOD}s`);
    return p;
  }
  return defaultPeriod();
}

/** 기본값 — 방금 끝난 시간. 갭 판정의 기준점이기도 하다. */
function defaultPeriod() {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % PERIOD) - PERIOD;
}

/**
 * 그 시간이 끝났는가. 컨트랙트도 같은 것을 강제하지만 여기서 먼저 멈춘다.
 *
 * 3차 감사 A-1 후속. 컨트랙트의 경계는 **포함**(`block.timestamp >= endsAt`)이고
 * 그 자체는 올바르다 — 세 지점(endsAt-1 / endsAt / endsAt+1)을 테스트가 직접
 * 지나간다. 남는 위험은 시계가 두 개라는 것이다:
 *
 *   - 이 스크립트는 서버의 Date.now() 를 본다
 *   - 컨트랙트는 block.timestamp 를 본다 (BSC 검증자에게 몇 초 재량이 있다)
 *
 * 두 시계가 독립적으로 앞설 수 있으므로, 시간이 끝나자마자 앵커하면 그 시간의
 * 마지막 몇 초에 들어온 라운드가 배치에서 빠진 채 영구히 고정될 수 있다.
 *
 * 컨트랙트에 GRACE 를 넣지 않고 여기서 처리하는 이유: 초 수는 정책 수치이고
 * immutable 생성자 인자로 박으면 잘못 잡았을 때 되돌릴 수 없다. 반면 이 지연은
 * 운영 파라미터이고 언제든 바꿀 수 있다. 그리고 **양쪽 시계를 다 본다** —
 * 체인 시각을 같이 확인하는 것이 시계 발산에 대한 진짜 대응이다.
 */
const ANCHOR_DELAY_SECONDS = Number(process.env.ANCHOR_DELAY_SECONDS ?? 60);

async function assertPeriodEnded(periodStart, provider) {
  if (!Number.isSafeInteger(ANCHOR_DELAY_SECONDS) || ANCHOR_DELAY_SECONDS < 0) {
    throw new Error('ANCHOR_DELAY_SECONDS must be a non-negative integer');
  }
  const endsAt = periodStart + PERIOD;
  const localNow = Math.floor(Date.now() / 1000);

  // 체인 시각도 본다. 서버 시계만 보면 두 시계가 어긋났을 때 알 수 없다.
  let chainNow = null;
  if (provider) {
    const blk = await provider.getBlock('latest');
    if (blk) chainNow = Number(blk.timestamp);
  }

  const clocks = [['the server clock', localNow]];
  if (chainNow !== null) clocks.push(['the chain clock', chainNow]);

  for (const [label, now] of clocks) {
    if (endsAt + ANCHOR_DELAY_SECONDS > now) {
      throw new Error(
        `period ${periodStart} ends at ${endsAt} (${new Date(endsAt * 1000).toISOString()}), ` +
        `and by ${label} that is ${endsAt - now}s away ` +
        `(waiting ${ANCHOR_DELAY_SECONDS}s past the boundary). Anchoring an hour that is still ` +
        'running would fix it forever with the rounds still to come in it missing, and it cannot ' +
        'be corrected. Set ANCHOR_DELAY_SECONDS to change the margin.');
    }
  }

  if (chainNow !== null && Math.abs(chainNow - localNow) > ANCHOR_DELAY_SECONDS) {
    console.log(`           NOTE: the server clock and the chain clock differ by ` +
      `${Math.abs(chainNow - localNow)}s, which is more than ANCHOR_DELAY_SECONDS ` +
      `(${ANCHOR_DELAY_SECONDS}). Check the server clock.`);
  }
}

async function main() {
  // 7차 감사 H-4. 이 스크립트는 DRY_RUN 만 알고 PRINT_ONLY 를 몰랐다. 저장소가
  // PRINT_ONLY 를 표준어로 쓰는 스크립트가 넷이라 운영자가 그 이름을 익히게 되어
  // 있고, 여기서는 그게 무시되어 첫 앵커가 제네시스 시각을 영구히 고정했다.
  const dryRun = suppressed();
  // keyVar 를 넘기지 않으면 _connect.cjs 가 DEPLOYER_KEY 를 읽는다. 헤더는
  // PUBLISHER_KEY 를 쓰라고 하는데 코드는 배포키로 서명을 시도했고, DRY_RUN 에서는
  // publisher 확인도 건너뛰어 드라이런이 조용히 통과했다. 감사 A-M1.
  const { provider, signer, net, mainnet } = await connect({ keyVar: 'PUBLISHER_KEY' });
  const chainId = Number(net.chainId);
  const me = await signer.getAddress();

  const record = readRecord(chainId) || {};
  const address = process.env.ANCHOR_ADDRESS || record.addresses?.HCOWAnchor;
  if (!address) throw new Error('ANCHOR_ADDRESS must be set, or deployments/<chain>.json must name HCOWAnchor');
  // 11차 감사: set-root.cjs 가 10차에 고친 것과 같은 모양이 여기 남아 있었다.
  // ANCHOR_ADDRESS 가 레코드의 HCOWAnchor 와 달라도 대조 없이 진행했다 (재현함).
  // 앵커는 공개 검증의 기준점이라, 다른 컨트랙트에 앵커하면 그 시간대의 기록이
  // 우리가 공표한 주소 밖에 쌓인다.
  const recordedAnchor = record.addresses?.HCOWAnchor;
  if (process.env.ANCHOR_ADDRESS && recordedAnchor &&
      process.env.ANCHOR_ADDRESS.toLowerCase() !== recordedAnchor.toLowerCase()) {
    throw new Error(
      `ANCHOR_ADDRESS ${process.env.ANCHOR_ADDRESS} but deployments/${chainId}.json records HCOWAnchor as ` +
      `${recordedAnchor}. One of the two is wrong and this script will not pick.`);
  }
  if ((await provider.getCode(address)) === '0x') throw new Error(`${address} has no code on chain ${chainId}`);

  const anchor = at('HCOWAnchor', address, signer);

  const onChainPublisher = await anchor.publisher();
  console.log(`chain      ${chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`anchor     ${address}`);
  console.log(`publisher  ${onChainPublisher}`);
  console.log(`signer     ${me}${dryRun ? '   (DRY RUN)' : ''}`);
  // 드라이런에서도 확인한다. 드라이런의 목적이 "이대로 보내면 되는가" 이므로,
  // 키가 틀린 것을 드라이런이 숨기면 드라이런이 하는 일이 없다.
  if (onChainPublisher.toLowerCase() !== me.toLowerCase()) {
    throw new Error(
      `the signer ${me} is not the publisher ${onChainPublisher}; anchor() would revert with NotPublisher. ` +
      'Set PUBLISHER_KEY, not DEPLOYER_KEY.');
  }

  const periodStart = periodToAnchor();
  await assertPeriodEnded(periodStart, provider);
  const iso = new Date(periodStart * 1000).toISOString();
  console.log(`period     ${periodStart}  ${iso}`);

  // 3차 감사 A-8. 이 스크립트의 PERIOD 는 전부 anchor-merkle.cjs 에서 온다.
  // 정렬 검사·periodToAnchor·assertPeriodEnded·갭 산술이 모두 그 값을 쓰는데
  // 정작 상대 컨트랙트의 PERIOD() 는 한 번도 읽지 않았다. ANCHOR_ADDRESS 가
  // 다른 컨트랙트를 가리키면 산술이 조용히 틀린다. 배포 시 1회 대조로는 부족하다.
  const onChainPeriod = Number(await anchor.PERIOD());
  if (onChainPeriod !== PERIOD) {
    throw new Error(
      `the contract at ${address} has PERIOD=${onChainPeriod}s but this script builds ` +
      `${PERIOD}s batches. Alignment, gap arithmetic and "has the hour ended" are all wrong ` +
      'under that mismatch. Check ANCHOR_ADDRESS.');
  }

  const lastPeriod = Number(await anchor.lastPeriodStart());
  console.log(`last       ${lastPeriod || '(none)'}${lastPeriod ? '  ' + new Date(lastPeriod * 1000).toISOString() : ''}`);
  if (periodStart <= lastPeriod) {
    throw new Error(
      `period ${periodStart} is not after the last anchored period ${lastPeriod}. ` +
      'An anchored period cannot be replaced; if this hour needs a correction, it cannot have one.');
  }
  // 3차 감사 A-3.
  //
  // 이전 판은 `lastPeriod && ...` 였다. 갓 배포한 컨트랙트는 lastPeriodStart 가
  // 0 이라 단락되어 **갭 검사가 아예 실행되지 않았다.** 첫 앵커의 PERIOD_START
  // 오타 하나가 그 사이 모든 시간을 영구히 앵커 불가로 만드는데, 그 가장 위험한
  // 실행에서만 가드가 비어 있었다. A-H1 이 막으려던 바로 그 시나리오다.
  //
  // 첫 앵커에는 비교 기준이 없으므로 "직전에 끝난 시간"(기본값)을 기준으로 삼는다.
  // 의도적으로 과거부터 시작하는 경우는 ALLOW_GAP=1 로 명시한다.
  if (lastPeriod) {
    if (periodStart > lastPeriod + PERIOD) {
      const missed = (periodStart - lastPeriod) / PERIOD - 1;
      if (process.env.ALLOW_GAP !== '1') {
        throw new Error(
          `${missed} hour(s) between the last batch (${lastPeriod}) and this one (${periodStart}) ` +
          'would be skipped, and skipped hours can never be anchored later. If that is intended ' +
          '(an outage, say), re-run with ALLOW_GAP=1. If it is not, check PERIOD_START.');
      }
      console.log(`           ALLOW_GAP=1: ${missed} hour(s) will stay unanchored, permanently.`);
    }
  } else if (periodStart !== defaultPeriod()) {
    // 첫 배치에는 비교할 직전 시간이 없다. 그래서 이전 판은 갭 검사를 통째로
    // 건너뛰었고, PERIOD_START 오타가 무경고로 통과했다. 그런데 첫 배치야말로
    // 되돌릴 수 없는 선택이다 — periodStart 는 여기서부터 엄격히 증가하므로
    // **이 시간 이전은 영원히 앵커할 수 없게 된다.**
    //
    // 기준점은 기본값(방금 끝난 시간)으로 잡는다. 그냥 지금부터 시작하는
    // 정상 경로에서는 조용하고, PERIOD_START 로 다른 시간을 지목했을 때만 멈춘다.
    const d = defaultPeriod();
    const hours = Math.abs(periodStart - d) / PERIOD;
    if (process.env.ALLOW_GAP !== '1') {
      throw new Error(
        `this is the first batch on this contract, and PERIOD_START (${periodStart}, ` +
        `${new Date(periodStart * 1000).toISOString()}) is ${hours} hour(s) ` +
        `${periodStart < d ? 'before' : 'after'} the hour that just ended (${d}). ` +
        'periodStart only ever increases, so every hour before the one you pick here can never ' +
        'be anchored. If this genesis hour is intended, re-run with ALLOW_GAP=1. ' +
        'If it is not, check PERIOD_START.');
    }
    console.log(`           ALLOW_GAP=1: genesis hour set to ${periodStart}; everything before it stays unanchorable.`);
  }

  const rounds = loadRounds(process.env.ROUNDS_FILE);
  console.log(`rounds     ${rounds.length} from ${path.basename(process.env.ROUNDS_FILE)}`);
  if (rounds.length === 0) throw new Error('nothing to anchor; the contract refuses an empty batch');

  // Builds the tree, derives the root twice by independent paths, and replays
  // every proof before returning. Any of those failing throws here rather than
  // producing a root nothing downstream could question.
  const batch = buildBatch(periodStart, rounds);
  console.log(`root       ${batch.root}`);
  console.log(`           second path agrees, ${batch.leafCount} proofs replayed`);

  // exporter 가 멈춰 ROUNDS_FILE 이 갱신되지 않으면 매시간 같은 루트가 앵커되고
  // 체인 위에서는 정상으로 보인다. 그건 데이터 파이프라인이 죽었다는 신호다.
  if (lastPeriod) {
    const prev = await anchor.batchForPeriod(lastPeriod);
    if (prev.root === batch.root && process.env.ALLOW_SAME_ROOT !== '1') {
      throw new Error(
        `this batch has the same root as the previous hour (${batch.root}). ` +
        'That almost always means ROUNDS_FILE was not refreshed. Set ALLOW_SAME_ROOT=1 to override.');
    }
  }

  const data = anchor.interface.encodeFunctionData('anchor', [batch.root, batch.leafCount, periodStart]);

  // 3차 감사 A-4.
  //
  // 이전 판은 이 쓰기가 dry-run 분기와 전송보다 **앞**에 있었다. 결과 둘:
  //   (1) DRY_RUN 이 증명 파일을 남기는데 그 안에 앵커 여부를 말하는 필드가
  //       하나도 없어서, 앵커되지 않은 시간의 파일이 진짜와 구별되지 않았다
  //   (2) 헤더가 권장하는 "먼저 DRY_RUN=1" 을 따르면 실제 실행이 "already exists"
  //       로 막혀, 운영자가 매시간 손으로 파일을 지워 가드를 무력화하도록 훈련됐다
  //
  // 이제 파일은 **전송이 확인된 뒤에만** 쓰고 txHash 와 batch index 를 같이 적는다.
  // dry run 은 .dryrun.json 으로 따로 쓴다 — 증명으로 쓸 수 없는 파일임이 이름에서 보인다.
  const out = process.env.BATCH_OUT;
  const writeBatchFile = (file, extra) => {
    if (fs.existsSync(file)) {
      throw new Error(
        `${file} already exists. A fixed BATCH_OUT name overwrites the previous hour's proofs, ` +
        'and the verification page cannot rebuild them from the root alone. Use a per-hour name.');
    }
    // chainId · 컨트랙트 · 시각을 같이 적는다. 파일만 보고 어느 체인의 어느
    // 컨트랙트의 몇 번 배치인지 알 수 없으면 증명이 쓸모없다. 감사 A-M5.
    fs.writeFileSync(file, JSON.stringify({
      chainId, anchor: address, periodStart, periodIso: iso,
      builtAt: new Date().toISOString(),
      ...extra,
      ...batch,
    }, null, 2) + '\n');
    return file;
  };

  if (dryRun) {
    if (out) {
      const f = writeBatchFile(out.replace(/(\.json)?$/i, '') + '.dryrun.json',
        { anchored: false, note: 'DRY RUN — this batch was never sent. Not a proof file.' });
      console.log(`proofs     dry-run copy written to ${f} (not a proof file)`);
    }
    console.log(`\ncalldata   ${data}`);
    console.log('\nDRY RUN — nothing was sent.');
    return;
  }

  if (!out) {
    console.log('proofs     BATCH_OUT not set, so the proofs will not be saved.');
    console.log('           The verification page needs them; the root alone cannot produce them.');
  }

  const gas = await anchor.anchor.estimateGas(batch.root, batch.leafCount, periodStart);
  const fee = await provider.getFeeData();
  const price = fee.gasPrice ?? 0n;
  console.log(`gas        ${gas} at ${ethers.formatUnits(price, 'gwei')} gwei  =  ${ethers.formatEther(gas * price)} BNB`);

  const tx = await anchor.anchor(batch.root, batch.leafCount, periodStart);
  console.log(`tx         ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`mined      block ${rc.blockNumber}, ${rc.gasUsed} gas used`);

  const count = await anchor.batchCount();
  const stored = await anchor.batchAt(count - 1n);
  if (stored.root !== batch.root) throw new Error('the stored root does not match the built root');
  const batchIndex = Number(count - 1n);
  console.log(`confirmed  batch index ${batchIndex}, root ${stored.root}`);

  // 여기까지 와야 증명 파일을 쓴다. 파일이 존재한다 == 체인에 올라갔다.
  if (out) {
    const f = writeBatchFile(out, {
      anchored: true, txHash: tx.hash, blockNumber: rc.blockNumber, batchIndex,
    });
    console.log(`proofs     written to ${f}`);
  }
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
