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
const { connect, at, readRecord, sendOrPrint, ethers, suppressed } = require('./_connect.cjs');
const { loadSchedule } = require('./commitcheck.cjs');
const { commitments } = require('../vestcommit.cjs');

async function main() {
  // 8차 감사 M-10. 이 스크립트는 PRINT_ONLY 만 알았다. 7차 조치로 sendOrPrint 가
  // 두 이름을 모두 이해하게 됐으므로, DRY_RUN=yes 는 전송만 막고 그 뒤 되읽기에서
  // "9명을 기대했는데 체인은 0" 이라는 엉뚱한 실패를 냈다. 위험하진 않지만
  // "두 이름은 어디서나 같은 뜻" 이라는 7차 조치의 약속이 깨져 있었다.
  const printOnly = suppressed();
  const { provider, signer, net, mainnet } = await connect({
    needSigner: !printOnly, keyVar: 'TREASURY_KEY',
  });

  const rec = readRecord(Number(net.chainId));
  if (!rec || !rec.addresses || !rec.addresses.HCOWVesting) {
    // 11차 감사: 파일이 있는데 베스팅만 없을 때도 "no deployment record" 라고 했다.
    throw new Error(
      rec ? `deployments/${net.chainId}.json names no HCOWVesting yet. Run scripts/deploy.cjs first.`
          : `no deployment record for chain ${net.chainId}. Run scripts/deploy.cjs first.`);
  }
  const vestingAddr = rec.addresses.HCOWVesting;
  // 9차 감사 B-F7. rec.treasury 가 없으면 아래 toLowerCase 에서 진단 없는
  // TypeError 가 났다. 무엇이 없는지 말한다.
  if (!rec.treasury || !ethers.isAddress(rec.treasury)) {
    throw new Error(
      `deployments/${net.chainId}.json has no usable "treasury" field (found ${JSON.stringify(rec.treasury)}). ` +
      'That field is what this script compares the signing key against. Restore the record.');
  }
  const treasury = ethers.getAddress(rec.treasury);

  const vc = at('HCOWVesting', vestingAddr, printOnly ? provider : signer);
  // 9차 감사 B-F6. 이전 판은 owner 를 레코드에서 읽어 "owner" 라고 라벨링해 찍고,
  // 그 주소에서 서명하라고 지시했다. vc.owner() 를 한 번도 부르지 않았다.
  // 재현 확인: 레코드의 treasury 필드만 오염시키면 PRINT_ONLY 가 그 주소를 owner
  // 로 출력하고 exit 0 이었다 — Safe 에서 제출하면 OwnableUnauthorizedAccount 로
  // revert 한다. seal.cjs 는 처음부터 체인에서 읽어 대조했고, set-root.cjs 는
  // 8차에 그렇게 바뀌었다. 같은 원칙을 여기에도 적용한다. 체인이 근거다.
  const onChainOwner = await vc.owner();
  if (onChainOwner.toLowerCase() !== treasury.toLowerCase()) {
    throw new Error(
      `the vesting contract at ${vestingAddr} reports owner ${onChainOwner}, but ` +
      `deployments/${net.chainId}.json records the treasury as ${treasury}. One of the two is wrong. ` +
      'addSchedules is owner-only, so a call built against the recorded value would revert with ' +
      'OwnableUnauthorizedAccount. This script will not print a call it knows cannot land.');
  }

  const from = printOnly ? onChainOwner : await signer.getAddress();
  if (from.toLowerCase() !== onChainOwner.toLowerCase()) {
    throw new Error(
      `TREASURY_KEY is ${from} but the vesting contract's owner is ` +
      `${onChainOwner}. addSchedules is owner-only; this key cannot load the table.`);
  }

  console.log(`chain     ${net.chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`vesting   ${vestingAddr}`);
  console.log(`owner     ${onChainOwner}  (read from the chain)\n`);

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
    // 11차 감사: 이전 안내("PRINT_ONLY 없이 다시 돌려 확인하라")는 Safe 트레저리에서
    // 실행할 수 없었다 — 키가 없고, PRINT_ONLY 로 돌리면 이미 적재돼 거부된다.
    // 행 단위 대조는 seal.cjs 의 드라이런이 한다.
    console.log('then confirm with `DRY_RUN=yes node scripts/seal.cjs`: it compares every row on chain');
    console.log('with the file and checks the commitments, without sending anything.');
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
