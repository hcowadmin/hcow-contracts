/* HCOW contract test suite. In-process EVM, no network required. */
const fs = require('fs');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, privateToAddress } = require('@ethereumjs/util');
const { Interface } = require('ethers');

const E18 = 10n ** 18n;
const DAY = 86400n, MONTH = 30n * DAY;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const eq = (a, b, m) => ok(a === b, a === b ? m : `${m}   got ${a} want ${b}`);

const load = (n) => JSON.parse(fs.readFileSync(`artifacts/${n}.json`, 'utf8'));
const keys = ['0x'+'11'.repeat(32), '0x'+'22'.repeat(32), '0x'+'33'.repeat(32), '0x'+'44'.repeat(32), '0x'+'55'.repeat(32)];
const acc = keys.map(k => new Address(privateToAddress(hexToBytes(k))));

let vm, common, now = 1900000000n;

const mkBlock = () => Block.fromBlockData(
  { header: { timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n, number: 1n } },
  { common, skipConsensusFormatValidation: true }
);

async function send({ from = 0, to = null, data }) {
  const a = acc[from];
  const account = await vm.stateManager.getAccount(a);
  const tx = LegacyTransaction.fromTxData({
    nonce: account.nonce, gasPrice: 10n, gasLimit: 29_000_000n,
    to: to ?? undefined, value: 0n, data: hexToBytes(data),
  }, { common }).sign(hexToBytes(keys[from]));
  return vm.runTx({ tx, block: mkBlock(), skipBalance: true, skipBlockGasLimitValidation: true });
}

async function call(to, data) {
  const r = await vm.evm.runCall({
    to, caller: acc[0], origin: acc[0], data: hexToBytes(data),
    gasLimit: 29_000_000n, block: mkBlock(),
  });
  if (r.execResult.exceptionError) throw new Error('call reverted: ' + r.execResult.exceptionError.error);
  return bytesToHex(r.execResult.returnValue);
}

const read = (iface, to, fn, args = []) =>
  call(to, iface.encodeFunctionData(fn, args)).then(r => iface.decodeFunctionResult(fn, r)[0]);

async function deploy(name, iface, args) {
  const art = load(name);
  const data = art.bytecode + (args.length ? iface.encodeDeploy(args).slice(2) : '');
  const r = await send({ data });
  if (r.execResult.exceptionError) throw new Error(name + ' deploy failed: ' + r.execResult.exceptionError.error);
  return r.createdAddress;
}

async function main() {
  common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
  vm = await VM.create({ common });
  for (const a of acc) await vm.stateManager.modifyAccountFields(a, { balance: 10n ** 22n });

  const tokenAbi = new Interface(load('HCOWToken').abi);
  const vestAbi = new Interface(load('HCOWVesting').abi);

  // ============================ HCOWToken ============================
  console.log('\nHCOWToken');
  const treasury = acc[1];
  const token = await deploy('HCOWToken', tokenAbi, [treasury.toString()]);

  eq(await read(tokenAbi, token, 'totalSupply'), 200_000_000n * E18, 'total supply is exactly 200,000,000');
  eq(await read(tokenAbi, token, 'INITIAL_SUPPLY'), 200_000_000n * E18, 'INITIAL_SUPPLY constant matches');
  eq(await read(tokenAbi, token, 'balanceOf', [treasury.toString()]), 200_000_000n * E18,
     'entire supply goes to the treasury parameter, not to the deployer');
  eq(await read(tokenAbi, token, 'balanceOf', [acc[0].toString()]), 0n, 'deployer holds zero');
  eq(await read(tokenAbi, token, 'decimals'), 18n, 'decimals is 18');
  eq(await read(tokenAbi, token, 'symbol'), 'HCOW', 'symbol is HCOW');

  const fns = load('HCOWToken').abi.filter(x => x.type === 'function').map(x => x.name);
  ok(!fns.includes('mint'), 'no mint function exists');
  ok(!['owner','transferOwnership','renounceOwnership','pause','unpause','setFee','setTax','blacklist']
      .some(n => fns.includes(n)), 'no owner, pause, fee or blacklist function exists');
  ok(fns.includes('burn') && fns.includes('burnFrom'), 'burn and burnFrom exist');
  ok(fns.includes('permit'), 'ERC20Permit is available');

  // mutation tests run on a throwaway instance so the vesting fixture stays pristine
  const t2 = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
  await send({ from: 1, to: t2, data: tokenAbi.encodeFunctionData('burn', [1_000n * E18]) });
  eq(await read(tokenAbi, t2, 'totalSupply'), 199_999_000n * E18, 'burn permanently reduces total supply');
  await send({ from: 1, to: t2, data: tokenAbi.encodeFunctionData('transfer', [acc[2].toString(), 500n * E18]) });
  eq(await read(tokenAbi, t2, 'balanceOf', [acc[2].toString()]), 500n * E18,
     'transfer delivers the exact amount, so there is no transfer tax');

  {
    const bad = load('HCOWToken').bytecode + tokenAbi.encodeDeploy(['0x' + '00'.repeat(20)]).slice(2);
    const r = await send({ data: bad });
    ok(!!r.execResult.exceptionError, 'deploying with a zero treasury reverts');
  }

  // ============================ HCOWVesting ============================
  console.log('\nHCOWVesting');
  const tge = now + 10n * DAY;
  const vest = await deploy('HCOWVesting', vestAbi, [token.toString(), tge, acc[1].toString()]);

  eq(await read(vestAbi, vest, 'tgeTime'), tge, 'tgeTime is fixed at construction');
  {
    const r = await send({ data: load('HCOWVesting').bytecode +
      vestAbi.encodeDeploy([token.toString(), now - 1n, acc[1].toString()]).slice(2) });
    ok(!!r.execResult.exceptionError, 'a TGE timestamp in the past reverts');
  }

  // The published allocation, taken from the official tokenomics announcements.
  // TGE unlock across all of it must be exactly 27,000,000.
  // Community is TWO schedules, not one. Airdrop and ongoing incentives have
  // different terms and must be added separately.
  const ALLOC = [
    // name,                     tokens,        tgeBps, cliffM, linearM
    ['Public',                   60_000_000n,   1500,  0, 12],
    ['Private',                  40_000_000n,    750,  6, 12],
    ['Seed',                     20_000_000n,   2500,  0,  3],
    ['Community / Airdrop',       8_000_000n,   3750,  0,  6],
    ['Community / Incentives',   12_000_000n,      0,  0, 24],
    ['Ecosystem & R&D',          20_000_000n,      0,  6, 42],
    ['Foundation',               16_000_000n,      0, 12, 36],
    ['Liquidity',                14_000_000n,   5000,  0, 12],
    ['Team',                     10_000_000n,      0, 12, 36],
  ];
  const holders = ALLOC.map((_, i) => new Address(privateToAddress(hexToBytes('0x' + (i + 1).toString(16).padStart(2,'0').repeat(32)))));

  for (let i = 0; i < ALLOC.length; i++) {
    const [, amt, bps, cliff, lin] = ALLOC[i];
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('addSchedule',
      [holders[i].toString(), amt * E18, bps, cliff, lin]) });
    if (r.execResult.exceptionError) throw new Error('addSchedule failed for ' + ALLOC[i][0]);
  }

  eq(await read(vestAbi, vest, 'totalScheduled'), 200_000_000n * E18, 'schedules sum to the full 200,000,000');
  const tgeUnlock = await read(vestAbi, vest, 'totalTgeUnlock');
  eq(tgeUnlock, 27_000_000n * E18, 'TGE unlock across all schedules is exactly 27,000,000');
  eq(tgeUnlock * 1000n / (200_000_000n * E18), 135n, 'TGE circulating is 13.5 percent of supply');

  // non-owner cannot add
  {
    const r = await send({ from: 3, to: vest, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[4].toString(), 1n * E18, 0, 0, 1]) });
    ok(!!r.execResult.exceptionError, 'a non-owner cannot add a schedule');
  }
  // duplicate beneficiary rejected
  {
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('addSchedule',
      [holders[0].toString(), 1n * E18, 0, 0, 1]) });
    ok(!!r.execResult.exceptionError, 'adding a second schedule for the same address reverts');
  }

  // fund the contract
  await send({ from: 1, to: token, data: tokenAbi.encodeFunctionData('transfer', [vest.toString(), 199_999_000n * E18]) });
  eq(await read(vestAbi, vest, 'fundingShortfall'), 1_000n * E18,
     'fundingShortfall reports exactly what is still missing');

  // before TGE nothing vests
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[0].toString()]), 0n, 'nothing vests before TGE');
  {
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('release', [holders[0].toString()]) });
    ok(!!r.execResult.exceptionError, 'release before TGE reverts');
  }

  // seal
  // The caller states what it expects the loaded set to add up to. Reading the
  // figures back and eyeballing them is the step that gets skipped, and the
  // mistake it is meant to catch does not move either total.
  const SEAL_ARGS = [9n, 200_000_000n * E18, 27_000_000n * E18];

  // nothing may leave before the set is final
  {
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('release', [holders[0].toString()]) });
    ok(!!r.execResult.exceptionError, 'release before seal reverts');
  }
  // an underfunded seal is irreversible and unrepairable
  {
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('seal', SEAL_ARGS) });
    ok(!!r.execResult.exceptionError, 'sealing while underfunded reverts');
  }
  ok(!(await read(vestAbi, vest, 'sealed_')), 'and the flag is still unset');

  await send({ from: 1, to: token, data: tokenAbi.encodeFunctionData('transfer', [vest.toString(), 1_000n * E18]) });
  eq(await read(vestAbi, vest, 'fundingShortfall'), 0n, 'shortfall closed before sealing');

  // a commitment that disagrees with what was loaded is refused, one field at a time
  for (const [i, label] of [[0, 'beneficiary count'], [1, 'scheduled total'], [2, 'TGE unlock']]) {
    const bad = [...SEAL_ARGS];
    bad[i] = bad[i] + 1n;
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('seal', bad) });
    ok(!!r.execResult.exceptionError, `a wrong ${label} in the commitment refuses the seal`);
  }
  // and the merge the allocation table warns about: two community tranches as
  // one entry leaves both totals correct and only the count wrong
  {
    const bad = [8n, SEAL_ARGS[1], SEAL_ARGS[2]];
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('seal', bad) });
    ok(!!r.execResult.exceptionError, 'a merged community tranche is caught by the count');
  }

  await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('seal', SEAL_ARGS) });
  ok(await read(vestAbi, vest, 'sealed_'), 'seal() sets the sealed flag');
  {
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[4].toString(), 1n * E18, 0, 0, 1]) });
    ok(!!r.execResult.exceptionError, 'after seal() even the owner cannot add a schedule');
  }

  // ---- at TGE ----
  now = tge;
  const pubIdx = 0, teamIdx = 8, foundIdx = 6, seedIdx = 2, airdropIdx = 3;
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[pubIdx].toString()]), 9_000_000n * E18,
     'Public unlocks 15 percent, 9,000,000, at TGE');
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[seedIdx].toString()]), 5_000_000n * E18,
     'Seed unlocks 25 percent, 5,000,000, at TGE');
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[airdropIdx].toString()]), 3_000_000n * E18,
     'Community Airdrop unlocks 3,000,000 at TGE');
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[teamIdx].toString()]), 0n,
     'Team unlocks nothing at TGE');
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[foundIdx].toString()]), 0n,
     'Foundation unlocks nothing at TGE');

  // anyone can trigger release, tokens go to the beneficiary
  await send({ from: 3, to: vest, data: vestAbi.encodeFunctionData('release', [holders[pubIdx].toString()]) });
  eq(await read(tokenAbi, token, 'balanceOf', [holders[pubIdx].toString()]), 9_000_000n * E18,
     'release is permissionless and pays the beneficiary, not the caller');
  eq(await read(tokenAbi, token, 'balanceOf', [acc[3].toString()]), 0n, 'the caller receives nothing');

  // ---- team cliff behaviour ----
  now = tge + 11n * MONTH;
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[teamIdx].toString()]), 0n,
     'Team still has nothing one month before the 12 month cliff');
  now = tge + 12n * MONTH;
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[teamIdx].toString()]), 0n,
     'Team has nothing at the exact cliff moment');
  now = tge + 30n * MONTH;
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[teamIdx].toString()]), 5_000_000n * E18,
     'Team is halfway, 5,000,000, eighteen months into the 36 month linear');
  now = tge + 48n * MONTH;
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[teamIdx].toString()]), 10_000_000n * E18,
     'Team is fully vested at 48 months');
  now = tge + 72n * MONTH;
  eq(await read(vestAbi, vest, 'vestedAmount', [holders[teamIdx].toString()]), 10_000_000n * E18,
     'vesting never exceeds the total');

  // ---- team is the last money out, relative to every investor and community bucket ----
  now = tge + 47n * MONTH;
  // Public, Private, Seed, Community/Airdrop, Community/Incentives, Liquidity
  const INVESTOR_AND_COMMUNITY = [0, 1, 2, 3, 4, 7];
  let investorsDone = true;
  for (const i of INVESTOR_AND_COMMUNITY) {
    const v = await read(vestAbi, vest, 'vestedAmount', [holders[i].toString()]);
    if (v !== ALLOC[i][1] * E18) investorsDone = false;
  }
  ok(investorsDone, 'every investor and community bucket is fully vested before the Team finishes');
  const teamAt47 = await read(vestAbi, vest, 'vestedAmount', [holders[teamIdx].toString()]);
  ok(teamAt47 < 10_000_000n * E18, 'Team is still not fully vested at month 47, so the team is last out');

  // ---- linear midpoint on a cliffed bucket ----
  now = tge + 12n * MONTH;   // Private: 6m cliff + 12m linear -> 6 months into linear
  const priv = await read(vestAbi, vest, 'vestedAmount', [holders[1].toString()]);
  const expectPriv = 3_000_000n * E18 + (37_000_000n * E18) / 2n;
  eq(priv, expectPriv, 'Private is at TGE amount plus half the remainder at the linear midpoint');

  // ---- release accounting ----
  // top the contract back up first: earlier steps deliberately underfunded it
  await send({ from: 1, to: token, data: tokenAbi.encodeFunctionData('transfer', [vest.toString(), 1_000n * E18]) });
  eq(await read(vestAbi, vest, 'fundingShortfall'), 0n, 'fundingShortfall reaches zero once fully funded');
  now = tge + 60n * MONTH;
  for (let i = 0; i < ALLOC.length; i++) {
    const r = await read(vestAbi, vest, 'releasable', [holders[i].toString()]);
    if (r > 0n) await send({ from: 2, to: vest, data: vestAbi.encodeFunctionData('release', [holders[i].toString()]) });
  }
  let sum = 0n;
  for (let i = 0; i < ALLOC.length; i++) sum += await read(tokenAbi, token, 'balanceOf', [holders[i].toString()]);
  eq(sum, 200_000_000n * E18, 'after full vesting every beneficiary holds exactly their allocation');
  eq(await read(vestAbi, vest, 'totalReleased'), 200_000_000n * E18, 'totalReleased equals totalScheduled');
  {
    const r = await send({ from: 2, to: vest, data: vestAbi.encodeFunctionData('release', [holders[0].toString()]) });
    ok(!!r.execResult.exceptionError, 'releasing again when nothing is due reverts');
  }

  const vfns = load('HCOWVesting').abi.filter(x => x.type === 'function').map(x => x.name);
  ok(!vfns.some(n => ['revoke','cancel','withdraw','emergencyWithdraw','sweep','rescue'].includes(n)),
     'there is no revoke, cancel or sweep function, so schedules cannot be clawed back');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
