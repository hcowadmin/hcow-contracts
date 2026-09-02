'use strict';
// Loads the nine schedules into a deployed, unsealed HCOWVesting. Signed by
// the treasury, which is the owner.
//
//   RPC_URL=... CHAIN_ID=97 TREASURY_KEY=0x... SCHEDULE=schedule/testnet.json \
//   node scripts/load.cjs
//
// On mainnet the treasury is a hardware wallet and has no exportable key, so:
//
//   PRINT_ONLY=yes RPC_URL=... CHAIN_ID=56 SCHEDULE=schedule/mainnet.json \
//   node scripts/load.cjs
//
// prints the exact `to` and `data` to submit from that wallet, after running
// every check below. Nothing is sent.
//
// ONE TRANSACTION, DELIBERATELY. addSchedules loops addSchedule, so nine rows
// in one call cost one signature and produce one atomic result: either the
// whole table is written or none of it is. Nine separate calls can stop at row
// four, and the only way back from a partial table is replaceTable, which is
// another owner transaction against a contract whose scheduleHash is already
// half built.

const path = require('path');
const { connect, at, readRecord, sendOrPrint, ethers } = require('./_connect.cjs');
const { loadSchedule } = require('./commitcheck.cjs');
const { commitments } = require('../vestcommit.cjs');

async function main() {
  const printOnly = process.env.PRINT_ONLY === 'yes';
  const { provider, signer, net, mainnet } = await connect({
    needSigner: !printOnly, keyVar: 'TREASURY_KEY',
  });

  const rec = readRecord(Number(net.chainId));
  if (!rec || !rec.addresses || !rec.addresses.HCOWVesting) {
    throw new Error(`no deployment record for chain ${net.chainId}. Run scripts/deploy.cjs first.`);
  }
  const vestingAddr = rec.addresses.HCOWVesting;
  const treasury = rec.treasury;

  const from = printOnly ? treasury : await signer.getAddress();
  if (from.toLowerCase() !== treasury.toLowerCase()) {
    throw new Error(
      `TREASURY_KEY is ${from} but the deployment records the treasury and owner ` +
      `as ${treasury}. addSchedules is owner-only; this key cannot load the table.`);
  }

  const vc = at('HCOWVesting', vestingAddr, printOnly ? provider : signer);
  console.log(`chain     ${net.chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`vesting   ${vestingAddr}`);
  console.log(`owner     ${treasury}\n`);

  if (await vc.sealed_()) throw new Error('this contract is already sealed. Nothing can be loaded.');
  const already = await vc.beneficiaryCount();
  if (already > 0n) {
    throw new Error(
      `the contract already holds ${already} schedules. Loading again would revert ` +
      `ScheduleExists on the first duplicate and leave the table as it is. If the ` +
      `loaded table is wrong, replaceTable is the only correction and it is not ` +
      `this script.`);
  }

  const tgeTime = await vc.tgeTime();
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now >= tgeTime) {
    throw new Error(
      `TGE was at ${tgeTime} and it is now ${now}. addSchedule is closed. This ` +
      `contract can never be loaded and never be sealed; it has to be redeployed.`);
  }
  console.log(`TGE in    ${((Number(tgeTime - now)) / 86400).toFixed(2)} days\n`);

  // ---- the table --------------------------------------------------------
  const file = process.env.SCHEDULE || rec.schedule || 'schedule/testnet.json';
  const { rows } = loadSchedule(path.resolve(file));
  console.log(`schedule  ${file}  (${rows.length} rows)`);

  // The commitments in the contract were fixed at deployment. Loading a table
  // that does not reproduce them produces a contract that cannot be sealed,
  // and the only signal is a revert at seal time against a funded contract.
  const c = commitments(rows.map((r) => ({
    beneficiary: r.beneficiary, total: BigInt(r.total), tgeBps: r.tgeBps,
    cliffMonths: r.cliffMonths, linearMonths: r.linearMonths,
  })));
  const [eb, es, eu, eh] = await Promise.all([
    vc.expectedBeneficiaries(), vc.expectedScheduled(), vc.expectedTgeUnlock(), vc.expectedScheduleHash(),
  ]);
  const bad = [];
  if (c.count !== eb) bad.push(`beneficiaries: file ${c.count}, contract ${eb}`);
  if (c.total !== es) bad.push(`scheduled: file ${c.total}, contract ${es}`);
  if (c.unlock !== eu) bad.push(`tgeUnlock: file ${c.unlock}, contract ${eu}`);
  if (c.hash.toLowerCase() !== eh.toLowerCase()) bad.push(`scheduleHash: file ${c.hash}, contract ${eh}`);
  if (bad.length) {
    throw new Error(
      'THIS SCHEDULE FILE DOES NOT MATCH THE DEPLOYED COMMITMENTS.\n  ' + bad.join('\n  ') +
      '\n\nLoading it would produce a contract that can never be sealed. Either the\n' +
      'wrong file is being used, or it changed after deployment. Nothing sent.');
  }
  console.log('commit    the file reproduces the deployed commitments exactly\n');

  const E = 10n ** 18n;
  rows.forEach((r, i) => console.log(
    `  ${String(i + 1).padStart(2)} ${String(r.label || '').padEnd(22)} ` +
    `${(BigInt(r.total) / E).toLocaleString('en-US').padStart(12)}  ${r.beneficiary}`));

  const args = [
    rows.map((r) => r.beneficiary),
    rows.map((r) => BigInt(r.total)),
    rows.map((r) => r.tgeBps),
    rows.map((r) => r.cliffMonths),
    rows.map((r) => r.linearMonths),
  ];

  console.log('');
  await sendOrPrint('addSchedules', vc, 'addSchedules', args, { from });

  if (printOnly) {
    console.log('\nNothing was sent. Submit the call above from the treasury wallet,');
    console.log('then re-run this script without PRINT_ONLY to verify the result.');
    return;
  }

  // ---- read the whole table back ----------------------------------------
  // The strongest check available and it costs nine calls. A row written with
  // a transposed argument is accepted by the contract and invisible until
  // somebody is paid the wrong amount years later.
  const count = await vc.beneficiaryCount();
  console.log(`\nloaded    beneficiaryCount() = ${count}`);
  if (count !== c.count) throw new Error(`expected ${c.count} beneficiaries, chain says ${count}`);

  let mismatches = 0;
  for (const r of rows) {
    const s = await vc.schedules(r.beneficiary);
    const same =
      s.total === BigInt(r.total) &&
      Number(s.tgeBps) === Number(r.tgeBps) &&
      Number(s.cliffMonths) === Number(r.cliffMonths) &&
      Number(s.linearMonths) === Number(r.linearMonths) &&
      s.exists === true;
    if (!same) {
      mismatches++;
      console.log(`  MISMATCH ${r.label} ${r.beneficiary}`);
      console.log(`    file  total=${r.total} tgeBps=${r.tgeBps} cliff=${r.cliffMonths} linear=${r.linearMonths}`);
      console.log(`    chain total=${s.total} tgeBps=${s.tgeBps} cliff=${s.cliffMonths} linear=${s.linearMonths} exists=${s.exists}`);
    }
  }
  const [onTotal, onHash, onUnlock] = await Promise.all([
    vc.totalScheduled(), vc.scheduleHash(), vc.totalTgeUnlock(),
  ]);
  if (onTotal !== es) { mismatches++; console.log(`  MISMATCH totalScheduled ${onTotal} vs ${es}`); }
  if (onUnlock !== eu) { mismatches++; console.log(`  MISMATCH totalTgeUnlock ${onUnlock} vs ${eu}`); }
  if (onHash.toLowerCase() !== eh.toLowerCase()) { mismatches++; console.log(`  MISMATCH scheduleHash ${onHash} vs ${eh}`); }

  if (mismatches) {
    throw new Error(
      `${mismatches} mismatches between the file and the chain. Do NOT seal. ` +
      `replaceTable is the correction and it must be done before TGE.`);
  }
  console.log('          every row matches the file, and so do the three running totals');
  console.log('\nThe table is loaded and correct. Next: node scripts/seal.cjs');
}

main().catch((e) => {
  console.error('\n' + (e.message || e));
  process.exitCode = 1;
});
