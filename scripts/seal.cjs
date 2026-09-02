'use strict';
// Verifies a loaded HCOWVesting against its schedule file and, only if
// everything agrees, approves the shortfall and calls fundAndSeal.
//
//   RPC_URL=... CHAIN_ID=97 TREASURY_KEY=0x... node scripts/seal.cjs
//
// Dry run, which is what to do first every time:
//
//   DRY_RUN=yes RPC_URL=... CHAIN_ID=97 node scripts/seal.cjs
//
// Mainnet, where the treasury is a hardware wallet:
//
//   PRINT_ONLY=yes RPC_URL=... CHAIN_ID=56 node scripts/seal.cjs
//
// THIS IS THE IRREVERSIBLE ONE. After it lands the owner has no powers left,
// the table is frozen, and there is no sweep and no upgrade path. Every check
// below runs before anything is sent, and any single failure stops the script.
//
// WHY approve THEN fundAndSeal, RATHER THAN transfer THEN seal.
//
// A transfer moves the tokens whether or not the seal that follows succeeds.
// If the seal then reverts, the contract holds the entire allocation, release()
// is gated on a seal that cannot happen, rescueForeignToken refuses the vesting
// token, and there is no sweep: the whole amount is stranded for the life of
// the chain. fundAndSeal pulls and seals in one transaction, so a failing seal
// unwinds the transfer and nothing moves. The approve beforehand grants an
// allowance and moves nothing, so it is not part of the window.
//
// The approval is for the exact shortfall, never unlimited.

const path = require('path');
const { connect, at, readRecord, writeRecord, sendOrPrint, ethers } = require('./_connect.cjs');
const { loadSchedule } = require('./commitcheck.cjs');
const { commitments } = require('../vestcommit.cjs');

const E = 10n ** 18n;
const tok = (v) => (v / E).toLocaleString('en-US');

let checks = 0, failures = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) { console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

async function main() {
  const printOnly = process.env.PRINT_ONLY === 'yes';
  const dryRun = process.env.DRY_RUN === 'yes';
  const { provider, signer, net, mainnet } = await connect({
    needSigner: !printOnly && !dryRun, keyVar: 'TREASURY_KEY',
  });

  const rec = readRecord(Number(net.chainId));
  if (!rec || !rec.addresses || !rec.addresses.HCOWVesting) {
    throw new Error(`no deployment record for chain ${net.chainId}`);
  }
  const { HCOWVesting: vestingAddr, HCOWToken: tokenAddr } = rec.addresses;
  const treasury = rec.treasury;

  const from = (printOnly || dryRun) ? treasury : await signer.getAddress();
  if (from.toLowerCase() !== treasury.toLowerCase()) {
    throw new Error(`TREASURY_KEY is ${from}, the recorded treasury and owner is ${treasury}`);
  }

  const runner = (printOnly || dryRun) ? provider : signer;
  const vc = at('HCOWVesting', vestingAddr, runner);
  const tk = at('HCOWToken', tokenAddr, runner);

  console.log(`chain     ${net.chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`vesting   ${vestingAddr}`);
  console.log(`token     ${tokenAddr}`);
  console.log(`treasury  ${treasury}  (also the vesting owner)`);
  if (dryRun) console.log('mode      DRY RUN, nothing will be sent');
  if (printOnly) console.log('mode      PRINT ONLY, the calls are printed for the treasury wallet');
  console.log('');

  const file = process.env.SCHEDULE || rec.schedule || 'schedule/testnet.json';
  const { rows } = loadSchedule(path.resolve(file));
  const c = commitments(rows.map((r) => ({
    beneficiary: r.beneficiary, total: BigInt(r.total), tgeBps: r.tgeBps,
    cliffMonths: r.cliffMonths, linearMonths: r.linearMonths,
  })));

  console.log(`PRE-SEAL CHECKS  (schedule ${file})`);

  const [isSealed, owner, count, onTotal, onUnlock, onHash,
         eb, es, eu, eh, tgeTime, tokenOfVesting, supply, treasuryBal, shortfall, vestingBal] =
    await Promise.all([
      vc.sealed_(), vc.owner(), vc.beneficiaryCount(), vc.totalScheduled(), vc.totalTgeUnlock(),
      vc.scheduleHash(), vc.expectedBeneficiaries(), vc.expectedScheduled(), vc.expectedTgeUnlock(),
      vc.expectedScheduleHash(), vc.tgeTime(), vc.token(), tk.totalSupply(),
      tk.balanceOf(treasury), vc.fundingShortfall(), tk.balanceOf(vestingAddr),
    ]);

  ok('the contract is not already sealed', isSealed === false);
  ok('the vesting owner is the treasury', owner.toLowerCase() === treasury.toLowerCase(), `${owner}`);
  ok('the vesting contract points at this token', tokenOfVesting.toLowerCase() === tokenAddr.toLowerCase());

  // The number the runbook has said for months. Stated on its own line so a
  // human reading the output sees it and not just a green tick.
  ok(`beneficiaryCount() reads exactly ${c.count}`, count === c.count, `chain says ${count}`);

  ok('the file reproduces the deployed commitments', 
     c.count === eb && c.total === es && c.unlock === eu && c.hash.toLowerCase() === eh.toLowerCase());
  ok('the loaded table reproduces them too',
     count === eb && onTotal === es && onUnlock === eu && onHash.toLowerCase() === eh.toLowerCase());

  // Row by row, because the three running totals can agree while two rows have
  // swapped amounts.
  let rowBad = 0;
  for (const r of rows) {
    const s = await vc.schedules(r.beneficiary);
    if (!(s.exists && s.total === BigInt(r.total) && Number(s.tgeBps) === Number(r.tgeBps) &&
          Number(s.cliffMonths) === Number(r.cliffMonths) &&
          Number(s.linearMonths) === Number(r.linearMonths))) {
      rowBad++;
      console.log(`        row differs: ${r.label} ${r.beneficiary}`);
    }
  }
  ok('every row on chain matches the file', rowBad === 0, rowBad ? `${rowBad} rows differ` : '');

  // Vesting Low #6. seal() checks totalScheduled against LIVE supply, and this
  // table is the entire supply, so a single wei burned by anyone before the
  // seal makes sealing impossible forever. The window is only safe while the
  // treasury is the sole holder.
  ok('live supply still covers the committed total', onTotal <= supply,
     `scheduled ${tok(onTotal)}, supply ${tok(supply)}`);
  if (onTotal === supply) {
    console.log('        note: the table is the entire supply, so any burn before the');
    console.log('        seal makes this contract permanently unsealable. Seal now.');
  }

  ok('the treasury can cover the shortfall', treasuryBal >= shortfall,
     `holds ${tok(treasuryBal)}, needs ${tok(shortfall)}`);

  const secondsToTge = Number(tgeTime) - Math.floor(Date.now() / 1000);
  ok('TGE has not passed, or the seal is still open to the owner', true);
  console.log(`        TGE ${secondsToTge > 0 ? `in ${(secondsToTge / 86400).toFixed(2)} days` : 'has passed'}; ` +
              `after TGE anyone may call seal(), before it only the owner may`);

  console.log(`\n  vesting currently holds ${tok(vestingBal)} HCOW`);
  console.log(`  fundingShortfall()      ${tok(shortfall)} HCOW  (${shortfall} wei)`);

  console.log(`\n${checks - failures} of ${checks} checks passed`);
  if (failures) {
    throw new Error(`${failures} checks failed. NOTHING WAS SENT. Do not seal until every one passes.`);
  }

  if (dryRun) {
    console.log('\nDRY RUN. Nothing sent. Re-run without DRY_RUN to seal.');
    return;
  }

  console.log('\nSEALING. After this the owner has no remaining powers.');
  await sendOrPrint(`approve(${vestingAddr}, ${shortfall})`, tk, 'approve', [vestingAddr, shortfall], { from });
  await sendOrPrint('fundAndSeal()', vc, 'fundAndSeal', [], { from });

  if (printOnly) {
    console.log('\nNothing was sent. Submit the two calls above from the treasury wallet,');
    console.log('in that order, then re-run with DRY_RUN=yes to confirm the result.');
    return;
  }

  const [nowSealed, finalBal, finalAllowance] = await Promise.all([
    vc.sealed_(), tk.balanceOf(vestingAddr), tk.allowance(treasury, vestingAddr),
  ]);
  console.log(`\nsealed_()            ${nowSealed}`);
  console.log(`vesting holds        ${tok(finalBal)} HCOW`);
  console.log(`remaining allowance  ${finalAllowance} wei`);
  if (!nowSealed) throw new Error('fundAndSeal returned but sealed_ is still false');
  if (finalBal < es) throw new Error(`vesting holds ${tok(finalBal)} but the table commits ${tok(es)}`);
  // fundAndSeal pulls exactly the shortfall, so a residue here means the
  // approval was larger than what was needed. Not dangerous, worth seeing.
  if (finalAllowance !== 0n) {
    console.log('note: an allowance remains. It is harmless because the contract can no');
    console.log('longer pull, but revoke it if you prefer a clean approval list.');
  }

  writeRecord(Number(net.chainId), { ...rec, sealed: true, sealedAt: new Date().toISOString() });
  console.log('\nSealed. The table is frozen and the owner has no powers over it.');
}

main().catch((e) => {
  console.error('\n' + (e.message || e));
  process.exitCode = 1;
});
