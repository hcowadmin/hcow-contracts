'use strict';
// Reports what a sealed HCOWVesting owes right now, and optionally releases it.
//
//   RPC_URL=... CHAIN_ID=97 node scripts/release.cjs              report only
//   RELEASE=yes DEPLOYER_KEY=0x... node scripts/release.cjs        release all
//   RELEASE=yes DRY_RUN=yes / PRINT_ONLY=yes ...                   print the nine
//                                                                  calls, send none
//
// release(beneficiary) is permissionless and always pays the beneficiary, so
// any funded wallet can trigger it. That is the design: nobody, including a
// lost owner key, can withhold a vested allocation.
//
// WHAT THIS IS FOR. On testnet it is the last step of the rehearsal and the
// only one that proves the numbers rather than the mechanics. Everything
// before it shows that a table was loaded and a contract was sealed. This
// shows that the table pays what the published announcement says it pays: at
// TGE exactly 27,000,000 HCOW across nine allocations, and that each one gets
// the figure printed against its name.
//
// On mainnet it is a monitoring script. Run it whenever, release when there is
// something to release.

const path = require('path');
const { connect, at, readRecord, suppressed, ethers } = require('./_connect.cjs');
const { loadSchedule, tgeUnlockOf, vestedAt } = require('./commitcheck.cjs');

const E = 10n ** 18n;
const tok = (v) => {
  const whole = v / E;
  const frac = v % E;
  return frac === 0n ? whole.toLocaleString('en-US')
                     : (Number(v) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 });
};

async function main() {
  // 9차 감사 B-F5. 이 파일은 DRY_RUN 도 PRINT_ONLY 도 몰랐다 — 두 이름이 소스에
  // 한 번도 등장하지 않았다. 7차 H-3/H-4/H-5 의 재작업 대상 6개와 8차의 대상
  // 5개에서 모두 빠졌고, 자식 프로세스로 돌리는 테스트도 0건이었다. 재현 확인:
  // RELEASE=yes DRY_RUN=yes PRINT_ONLY=yes 로 돌리니 release() 9건이 실제로
  // 나가고 31.8M HCOW 가 움직였다.
  //
  // release() 는 permissionless 이고 수취인에게만 지급하므로 자금 손실은 아니다.
  // 그러나 되돌릴 수 없는 온체인 동작이고, 리허설이라 믿은 시점에 TGE 언락
  // 물량의 지급 시각이 결정된다. 7차 조치가 문서로 적어둔 위험의 마지막 사례다.
  const noSend = suppressed();
  const doRelease = process.env.RELEASE === 'yes';
  const { provider, signer, net, mainnet } = await connect({
    needSigner: doRelease && !noSend,
    // 10차 감사: 이전 문구는 배포 스크립트용 설명("publishes bytecode and holds no
    // role")을 그대로 보여줬다. 이 스크립트의 키는 가스만 낸다.
    keyHint: 'Any funded wallet will do: release() is permissionless and always pays the ' +
             'beneficiary, so this key only pays gas and gains nothing.',
  });

  const rec = readRecord(Number(net.chainId));
  if (!rec || !rec.addresses) throw new Error(`no deployment record for chain ${net.chainId}`);
  // 11차 감사: 베스팅이 기록되지 않았으면 ethers 내부 오류("invalid value for
  // Contract target")로 끝났다.
  if (!rec.addresses.HCOWVesting) {
    throw new Error(`deployments/${net.chainId}.json names no HCOWVesting yet. There is nothing to report on.`);
  }
  const vc = at('HCOWVesting', rec.addresses.HCOWVesting, (doRelease && !noSend) ? signer : provider);
  const tk = at('HCOWToken', rec.addresses.HCOWToken, provider);

  const file = process.env.SCHEDULE || rec.schedule || 'schedule/testnet.json';
  const { rows } = loadSchedule(path.resolve(file));

  const [isSealed, tgeTime, totalScheduled, totalReleased, onChainTgeUnlock] = await Promise.all([
    vc.sealed_(), vc.tgeTime(), vc.totalScheduled(), vc.totalReleased(), vc.totalTgeUnlock(),
  ]);
  const now = BigInt((await provider.getBlock('latest')).timestamp);

  console.log(`chain     ${net.chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`vesting   ${rec.addresses.HCOWVesting}`);
  console.log(`sealed    ${isSealed}`);
  console.log(`TGE       ${new Date(Number(tgeTime) * 1000).toISOString()}  ` +
              `(${now >= tgeTime ? 'passed' : `in ${((Number(tgeTime - now)) / 86400).toFixed(3)} days`})`);
  console.log(`released  ${tok(totalReleased)} of ${tok(totalScheduled)} HCOW\n`);

  if (!isSealed) {
    console.log('Not sealed. release() reverts NotSealed until it is. Nothing to do.');
    return;
  }
  // 11차 감사: 여기서 TGE 전이면 바로 돌아갔다. 그런데 아래의 totalTgeUnlock()
  // 대조는 시간과 무관하고, seal.cjs 는 봉인 확인 도구로 이 보고 모드를 안내한다.
  // 봉인은 TGE 전에 하므로 그 안내가 사실이려면 TGE 전에도 대조가 돌아야 한다.

  // What the table pays at exactly tgeTime, computed from the file. This is
  // the figure the public announcement states, and unlike anything measured
  // "now" it does not move, so it can be compared for equality.
  let expectedTge = 0n;
  const before = [];
  for (const r of rows) {
    const [releasable, bal, sched] = await Promise.all([
      vc.releasable(r.beneficiary), tk.balanceOf(r.beneficiary), vc.schedules(r.beneficiary),
    ]);
    const tgeShare = tgeUnlockOf(BigInt(r.total), r.tgeBps, r.cliffMonths, r.linearMonths);
    expectedTge += tgeShare;
    before.push({ r, releasable, bal, tgeShare, releasedBefore: sched.released });
  }

  console.log('  allocation              TGE entitlement    releasable now');
  for (const b of before) {
    console.log(`  ${String(b.r.label || '').padEnd(22)} ${tok(b.tgeShare).padStart(14)}  ${tok(b.releasable).padStart(16)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${tok(expectedTge).padStart(14)}`);

  // Time independent and therefore exact: the contract's own totalTgeUnlock()
  // runs the release maths at tgeTime across the loaded table, and the figure
  // above runs the same maths over the file. If they agree, the contract pays
  // at TGE exactly what the announcement says.
  const tgeMatch = onChainTgeUnlock === expectedTge;
  console.log(`\n  ${tgeMatch ? 'ok  ' : 'FAIL'}  totalTgeUnlock() on chain is ${tok(onChainTgeUnlock)} HCOW, ` +
              `${tgeMatch ? 'matching' : 'NOT matching'} the schedule file`);

  // 10차 감사: 보고 모드와 억제 모드는 위 FAIL 이 찍혀도 exit 0 이었다. 라이브만
  // exit 1 이라, 리허설은 초록이고 실전은 빨강이었다. 그리고 exit code 만 보는
  // 모니터링은 불일치를 놓친다. 이 스크립트가 "메인넷에서는 모니터링 스크립트"
  // 라고 스스로 말하므로, 불일치는 어느 모드에서든 exit 1 이다.
  if (!tgeMatch) process.exitCode = 1;
  if (now < tgeTime) {
    console.log('\nTGE has not happened. The TGE unlock above is checked; nothing is releasable yet, by design.');
    return;
  }
  if (!doRelease) {
    console.log('\nReport only. Re-run with RELEASE=yes and a funded DEPLOYER_KEY to release.');
    return;
  }
  if (noSend) {
    console.log('\nDRY RUN. RELEASE=yes was given but a suppression flag is set, so nothing is sent.');
    console.log('These are the calls that would go out, in this order:\n');
    let would = 0n, n = 0;
    for (const b of before) {
      if (b.releasable === 0n) {
        console.log(`  ${String(b.r.label).padEnd(22)} nothing releasable, would be skipped`);
        continue;
      }
      n += 1;
      would += b.releasable;
      console.log(`  ${String(b.r.label).padEnd(22)} release(${b.r.beneficiary})`);
      console.log(`  ${' '.repeat(22)}   to    ${rec.addresses.HCOWVesting}`);
      console.log(`  ${' '.repeat(22)}   data  ${vc.interface.encodeFunctionData('release', [b.r.beneficiary])}`);
      console.log(`  ${' '.repeat(22)}   pays  about ${tok(b.releasable)} HCOW at the moment of this read`);
    }
    console.log(`\n${n} call(s), about ${tok(would)} HCOW in total. The real amounts will be larger:`);
    console.log('linear vesting accrues every second and each transaction lands later than this read.');
    console.log('\nRe-run without DRY_RUN / PRINT_ONLY to send them.');
    return;
  }

  let bad = tgeMatch ? 0 : 1;

  // Each payment is checked against the vesting curve evaluated at the block
  // timestamp of its own transaction.
  //
  // The obvious check, comparing the payment to releasable() read a moment
  // earlier, is wrong and looks like a contract bug when it fails. Linear
  // vesting accrues every second, so by the time a transaction lands the
  // amount owed has grown, and nine sequential releases drift further with
  // each one. Reimplementing _vestedAt and evaluating it at the transaction's
  // own timestamp makes the comparison exact, and turns this from a smoke test
  // into an independent check of the whole unlock curve.
  console.log('\nreleasing');
  const results = [];
  for (const b of before) {
    if (b.releasable === 0n) {
      console.log(`  ${String(b.r.label).padEnd(22)} nothing releasable, skipped`);
      continue;
    }
    const tx = await vc.release(b.r.beneficiary);
    const rc = await tx.wait();
    const blk = await provider.getBlock(rc.blockNumber);
    const expected = vestedAt(b.r, tgeTime, blk.timestamp) - b.releasedBefore;
    const after = await tk.balanceOf(b.r.beneficiary);
    const delta = after - b.bal;
    results.push({ b, delta, expected, ts: blk.timestamp });
    console.log(`  ${String(b.r.label).padEnd(22)} +${tok(delta)} HCOW  tx ${rc.hash}`);
  }

  console.log('\nverifying each payment against the vesting curve at its own block time');
  let paid = 0n;
  for (const { b, delta, expected, ts } of results) {
    paid += delta;
    if (delta !== expected) {
      bad++;
      console.log(`  FAIL  ${b.r.label} at ts ${ts}: expected +${tok(expected)}, received +${tok(delta)}`);
    }
  }
  if (results.length) {
    console.log(`  ${bad === (tgeMatch ? 0 : 1) ? 'ok  ' : 'FAIL'}  ` +
                `${results.length} payments, each equal to the curve evaluated at its transaction`);
  }
  console.log(`  paid this run ${tok(paid)} HCOW`);

  const finalReleased = await vc.totalReleased();
  console.log(`\ntotalReleased ${tok(finalReleased)} of ${tok(totalScheduled)} HCOW`);
  if (bad) { console.log(`\n${bad} problems.`); process.exitCode = 1; }
  else console.log('\nEvery payment matches an independent reimplementation of the schedule.');
}

main().catch((e) => {
  console.error('\n' + (e.message || e));
  process.exitCode = 1;
});
