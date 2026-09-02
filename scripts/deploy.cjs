'use strict';
// Deploys HCOWToken and HCOWVesting. Loads no schedules and seals nothing.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... \
//   TREASURY_ADDRESS=0x... RESCUE_RECIPIENT=0x... TGE_TIME=<unix seconds> \
//   SCHEDULE=schedule/testnet.json \
//   EXPECT_BENEFICIARIES=.. EXPECT_SCHEDULED=.. EXPECT_TGE_UNLOCK=.. EXPECT_HASH=0x.. \
//   node scripts/deploy.cjs
//
// Get the four EXPECT_ values from `node scripts/commitcheck.cjs <schedule>`.
// This script recomputes them from the same schedule file using a different
// implementation and refuses to deploy unless both agree. That is the entire
// point of the pair: the commitments are immutable and a wrong one produces a
// contract that can never be sealed, so they are checked by two things that
// could have disagreed rather than by one thing twice.
//
// WHY THE TREASURY IS ALSO THE VESTING OWNER, AND WHY THIS SCRIPT INSISTS.
//
// fundAndSeal() pulls the shortfall from msg.sender, and before TGE
// _authoriseSeal() requires msg.sender == owner(). So the address that holds
// the HCOW must be the address that owns the contract, or the intended atomic
// funding path does not exist at all and the only remaining route is a bare
// transfer followed by a separate seal, which is exactly the window the atomic
// path was written to close. The audit reported this as Vesting Low #5. The
// fix is operational rather than a code change, which is why the deployed
// bytecode is still the audited bytecode, and this check is what makes the
// operational fix real rather than remembered.

const path = require('path');
const { connect, deploy, at, writeRecord, readRecord, ethers } = require('./_connect.cjs');
const { commitments } = require('../vestcommit.cjs');
const { loadSchedule } = require('./commitcheck.cjs');

const DAY = 24 * 60 * 60;

const addr = (k, { required = true } = {}) => {
  const v = process.env[k];
  if (!v) {
    if (!required) return null;
    throw new Error(`${k} must be set`);
  }
  if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);
  return ethers.getAddress(v);
};

async function main() {
  const { provider, signer, net, mainnet } = await connect();
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);

  console.log(`chain     ${net.chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB\n`);
  if (bal === 0n) throw new Error('deployer has no BNB');

  const treasury = addr('TREASURY_ADDRESS');
  const rescue = addr('RESCUE_RECIPIENT');

  // The deploy key publishes bytecode and then matters to nothing. If it is
  // also the treasury it holds the entire supply, and the whole argument for
  // using a throwaway key collapses.
  if (mainnet && treasury.toLowerCase() === me.toLowerCase()) {
    throw new Error('TREASURY_ADDRESS must not be the deploy key on mainnet.');
  }
  // rescueRecipient is immutable, and the constructor already refuses the two
  // values that make rescue a silent no-op. It does not refuse the treasury,
  // which is fine, or the vesting contract's own future address, which nobody
  // can predict here. Refusing the zero address is the one thing left.
  if (rescue === ethers.ZeroAddress) throw new Error('RESCUE_RECIPIENT must not be the zero address');

  // ---- TGE time ---------------------------------------------------------
  // tgeTime is immutable and everything hangs off it: addSchedule closes at
  // TGE, seal() changes hands at TGE, and every unlock is measured from it.
  const tge = Number(process.env.TGE_TIME || 0);
  if (!Number.isInteger(tge) || tge <= 0) {
    throw new Error('TGE_TIME must be a unix timestamp in SECONDS, not milliseconds and not a date string.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (tge <= now) throw new Error(`TGE_TIME ${tge} is in the past (now ${now})`);
  if (tge > now + 365 * DAY) throw new Error(`TGE_TIME ${tge} is more than 365 days out; the constructor refuses it`);
  const days = ((tge - now) / DAY).toFixed(2);
  console.log(`TGE       ${new Date(tge * 1000).toISOString()}  (${days} days out)`);
  // Loading the table has to finish before TGE or addSchedule closes with a
  // half written table. Nine rows is minutes, but a TGE hours away leaves no
  // room for anything going wrong.
  if (mainnet && tge < now + 2 * DAY) {
    throw new Error(
      `TGE_TIME is less than 2 days away. addSchedule closes at TGE and a table ` +
      `that is not finished by then cannot be completed. Set a later TGE.`);
  }

  // ---- schedule and commitments ----------------------------------------
  const file = process.env.SCHEDULE || 'schedule/testnet.json';
  const { meta, rows } = loadSchedule(path.resolve(file));
  console.log(`schedule  ${file}  (${rows.length} rows)`);
  if (mainnet && /TESTNET ONLY/i.test(meta.warning || '')) {
    throw new Error(`${file} is marked TESTNET ONLY. Refusing to deploy it on mainnet.`);
  }
  if (mainnet && rows.some((r) => /^0x0{40}$/i.test(r.beneficiary))) {
    throw new Error(`${file} still has placeholder zero addresses. Fill in every beneficiary.`);
  }

  const c = commitments(rows.map((r) => ({
    beneficiary: r.beneficiary,
    total: BigInt(r.total),
    tgeBps: r.tgeBps,
    cliffMonths: r.cliffMonths,
    linearMonths: r.linearMonths,
  })));

  const expect = {
    count: process.env.EXPECT_BENEFICIARIES,
    total: process.env.EXPECT_SCHEDULED,
    unlock: process.env.EXPECT_TGE_UNLOCK,
    hash: process.env.EXPECT_HASH,
  };
  if (!expect.count || !expect.total || !expect.unlock || !expect.hash) {
    throw new Error(
      'The four EXPECT_ values are required. Produce them with:\n' +
      `  node scripts/commitcheck.cjs ${file}\n` +
      'and export the four lines it prints. They are checked against a second,\n' +
      'independent computation here before anything is deployed.');
  }
  const disagree = [];
  if (String(c.count) !== String(expect.count)) disagree.push(`beneficiaries ${c.count} vs ${expect.count}`);
  if (String(c.total) !== String(expect.total)) disagree.push(`scheduled ${c.total} vs ${expect.total}`);
  if (String(c.unlock) !== String(expect.unlock)) disagree.push(`tgeUnlock ${c.unlock} vs ${expect.unlock}`);
  if (c.hash.toLowerCase() !== expect.hash.toLowerCase()) disagree.push(`hash ${c.hash} vs ${expect.hash}`);
  if (disagree.length) {
    throw new Error(
      'THE TWO COMMITMENT COMPUTATIONS DISAGREE. Nothing has been deployed.\n  ' +
      disagree.join('\n  ') +
      '\n\nOne of them is wrong. Find out which before deploying anything. The most\n' +
      'common cause is `total` computed at 256 bits: it is uint128 in the preimage.');
  }
  console.log('commit    two independent computations agree\n');

  const E = 10n ** 18n;
  const tok = (v) => (v / E).toLocaleString('en-US');
  console.log(`  beneficiaries  ${c.count}`);
  console.log(`  scheduled      ${tok(c.total)} HCOW`);
  console.log(`  TGE unlock     ${tok(c.unlock)} HCOW  (${(Number(c.unlock * 10000n / c.total) / 100).toFixed(2)}% of the table)`);
  console.log(`  hash           ${c.hash}\n`);

  // ---- token ------------------------------------------------------------
  let token = process.env.HCOW_ADDRESS ? ethers.getAddress(process.env.HCOW_ADDRESS) : null;
  let tokenTx = null;
  if (!token) {
    const t = await deploy('HCOWToken', signer, [treasury]);
    token = await t.getAddress();
    tokenTx = t.deploymentTransaction().hash;
    console.log(`HCOWToken     ${token}  tx ${tokenTx}`);
  } else {
    console.log(`HCOWToken     ${token}  (existing)`);
  }

  const tk = at('HCOWToken', token, provider);
  const [sym, dec, supply, held] = await Promise.all([
    tk.symbol(), tk.decimals(), tk.totalSupply(), tk.balanceOf(treasury),
  ]);
  console.log(`              ${sym}, ${dec} decimals, supply ${tok(supply)}, treasury holds ${tok(held)}`);
  if (Number(dec) !== 18) throw new Error(`token reports ${dec} decimals, the schedule is written in 18`);
  if (c.total > supply) throw new Error(`the table schedules ${tok(c.total)} but supply is ${tok(supply)}`);
  if (held < c.total) {
    throw new Error(
      `treasury ${treasury} holds ${tok(held)} HCOW but the table needs ${tok(c.total)}. ` +
      'fundAndSeal pulls from the owner, so the owner must hold it.');
  }

  // ---- vesting ----------------------------------------------------------
  // owner_ is the treasury. See the header.
  const v = await deploy('HCOWVesting', signer, [
    token, tge, treasury, rescue, c.count, c.total, c.unlock, c.hash,
  ]);
  const vesting = await v.getAddress();
  console.log(`HCOWVesting   ${vesting}  tx ${v.deploymentTransaction().hash}`);

  // Read the commitments back off the deployed contract rather than trusting
  // the arguments that were sent. A constructor argument encoded wrongly is
  // silent, and this is the last cheap moment to notice.
  const vc = at('HCOWVesting', vesting, provider);
  const [ob, os, ou, oh, oo, ot] = await Promise.all([
    vc.expectedBeneficiaries(), vc.expectedScheduled(), vc.expectedTgeUnlock(),
    vc.expectedScheduleHash(), vc.owner(), vc.tgeTime(),
  ]);
  const bad = [];
  if (ob !== c.count) bad.push(`expectedBeneficiaries ${ob}`);
  if (os !== c.total) bad.push(`expectedScheduled ${os}`);
  if (ou !== c.unlock) bad.push(`expectedTgeUnlock ${ou}`);
  if (oh.toLowerCase() !== c.hash.toLowerCase()) bad.push(`expectedScheduleHash ${oh}`);
  if (oo.toLowerCase() !== treasury.toLowerCase()) bad.push(`owner ${oo}, expected the treasury ${treasury}`);
  if (ot !== BigInt(tge)) bad.push(`tgeTime ${ot}`);
  if (bad.length) throw new Error('the deployed contract does not read back as deployed:\n  ' + bad.join('\n  '));
  console.log('              commitments read back correctly from chain\n');

  const prev = readRecord(Number(net.chainId)) || {};
  const rec = {
    ...prev,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployedBy: me,
    schedule: file,
    treasury,
    rescueRecipient: rescue,
    tgeTime: tge,
    commitments: {
      beneficiaries: String(c.count),
      scheduled: String(c.total),
      tgeUnlock: String(c.unlock),
      scheduleHash: c.hash,
    },
    addresses: { HCOWToken: token, HCOWVesting: vesting },
    deploymentTxs: {
      ...(tokenTx ? { HCOWToken: tokenTx } : {}),
      HCOWVesting: v.deploymentTransaction().hash,
    },
    sealed: false,
  };
  const p = writeRecord(Number(net.chainId), rec);
  console.log(`written to ${p}`);

  console.log('\nNEXT, IN ORDER, BOTH SIGNED BY THE TREASURY:');
  console.log('  1. node scripts/load.cjs     loads the nine schedules');
  console.log('  2. node scripts/seal.cjs     verifies, then approves and calls fundAndSeal');
  console.log('\nNothing is live until step 2. addSchedule closes at TGE, so step 1 must');
  console.log('finish before then. seal() stays callable after TGE deliberately.');
}

main().catch((e) => {
  console.error('\n' + (e.message || e));
  process.exitCode = 1;
});
