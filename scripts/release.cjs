'use strict';
// Reports what a sealed HCOWVesting owes right now, and optionally releases it.
//
//   RPC_URL=... CHAIN_ID=97 node scripts/release.cjs              report only
//   RELEASE=yes DEPLOYER_KEY=0x... node scripts/release.cjs        release all
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
const { connect, at, readRecord, ethers } = require('./_connect.cjs');
const { loadSchedule, tgeUnlockOf, vestedAt } = require('./commitcheck.cjs');

const E = 10n ** 18n;
const tok = (v) => {
  const whole = v / E;
  const frac = v % E;
  return frac === 0n ? whole.toLocaleString('en-US')
                     : (Number(v) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 });
};

async function main() {
  const doRelease = process.env.RELEASE === 'yes';
  const { provider, signer, net, mainnet } = await connect({ needSigner: doRelease });

  const rec = readRecord(Number(net.chainId));
  if (!rec || !rec.addresses) throw new Error(`no deployment record for chain ${net.chainId}`);
  const vc = at('HCOWVesting', rec.addresses.HCOWVesting, doRelease ? signer : provider);
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
  if (now < tgeTime) {
    console.log('TGE has not happened. Nothing is releasable yet, by design.');
    return;
  }

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

  if (!doRelease) {
    console.log('\nReport only. Re-run with RELEASE=yes and a funded DEPLOYER_KEY to release.');
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
