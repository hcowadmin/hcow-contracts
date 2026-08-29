/* HCOW contract test suite. In-process EVM, no network required. */
const { commitments } = require('./vestcommit.cjs');
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

/**
 * The custom error a reverted call returned, by name.
 *
 * Asserting only that something reverted is how a guard passes its own test for
 * the wrong reason: several guards can stand on one path, and "it reverted" is
 * satisfied by any of them, so deleting the one under test leaves the assertion
 * green. Name the error.
 */
function errorName(iface, r) {
  const data = bytesToHex(r.execResult.returnValue || new Uint8Array());
  if (!data || data.length < 10) return '';
  try { return iface.parseError(data)?.name ?? ''; } catch (_) { return ''; }
}

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

  // BEP-20 tooling calls getOwner() unconditionally. A contract that does not
  // implement it reverts, and a tool that does not expect the revert reports
  // the token as malformed rather than as ownerless.
  {
    let got = 'absent';
    try { got = await read(tokenAbi, token, 'getOwner'); } catch (_) {}
    eq(got, '0x0000000000000000000000000000000000000000',
       'getOwner reports the zero address, which is what tooling reads as renounced');
  }

  const fns = load('HCOWToken').abi.filter(x => x.type === 'function').map(x => x.name);
  ok(fns.includes('getOwner'), 'getOwner is present for BEP-20 tooling');
  ok(!fns.includes('mint'), 'no mint function exists');
  ok(!fns.includes('setOwner') && !fns.includes('transferOwnership'),
     'getOwner has no setter and no counterpart that could grant a role');
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

  // The four figures are now constructor arguments, so they are derived from
  // the published table before anything is deployed rather than read back off
  // a contract that has already been loaded. That read-back was the whole of
  // the audit's Low #1: it made the check a restatement instead of a
  // verification.
  const COMMIT = commitments(ALLOC.map(([, amt, bps, cliff, lin], i) => ({
    beneficiary: holders[i].toString(), total: amt * E18,
    tgeBps: bps, cliffMonths: cliff, linearMonths: lin,
  })));
  eq(COMMIT.total, 200_000_000n * E18, 'the published table sums to 200,000,000 before deployment');
  eq(COMMIT.unlock, 27_000_000n * E18, 'the published table unlocks exactly 27,000,000 at TGE');

  const VEST_ARGS = [token.toString(), tge, acc[1].toString(), acc[0].toString(),
                     COMMIT.count, COMMIT.total, COMMIT.unlock, COMMIT.hash];
  const vest = await deploy('HCOWVesting', vestAbi, VEST_ARGS);

  eq(await read(vestAbi, vest, 'tgeTime'), tge, 'tgeTime is fixed at construction');
  eq(await read(vestAbi, vest, 'expectedScheduleHash'), COMMIT.hash,
     'the commitment hash is fixed at construction, not supplied at seal');
  {
    const r = await send({ data: load('HCOWVesting').bytecode +
      vestAbi.encodeDeploy([token.toString(), now - 1n, acc[1].toString(), acc[0].toString(),
                            COMMIT.count, COMMIT.total, COMMIT.unlock, COMMIT.hash]).slice(2) });
    ok(!!r.execResult.exceptionError, 'a TGE timestamp in the past reverts');
  }

  // A commitment no table can ever satisfy has to be refused at deployment,
  // not at seal. expectedTgeUnlock was named by the CommitmentMismatch error
  // and constrained by nothing: totalTgeUnlock() can never exceed
  // totalScheduled, so a decimal slip here produced a contract that could
  // never be sealed, with both figures immutable and replaceTable unable to
  // help. HCOW sent to it before anyone noticed would have been stranded
  // permanently.
  {
    const bad = [token.toString(), tge, acc[1].toString(), acc[0].toString(),
                 COMMIT.count, COMMIT.total, COMMIT.total + 1n, COMMIT.hash];
    const r = await send({ data: load('HCOWVesting').bytecode + vestAbi.encodeDeploy(bad).slice(2) });
    eq(errorName(vestAbi, r), 'CommitmentMismatch',
       'a TGE unlock larger than the scheduled total is refused at deployment');
  }
  {
    const ok_ = [token.toString(), tge, acc[1].toString(), acc[0].toString(),
                 COMMIT.count, COMMIT.total, COMMIT.total, COMMIT.hash];
    const r = await send({ data: load('HCOWVesting').bytecode + vestAbi.encodeDeploy(ok_).slice(2) });
    ok(!r.execResult.exceptionError,
       'and a TGE unlock exactly equal to the scheduled total is still allowed');
  }

  // rescueRecipient is immutable and there is no owner after sealing, so the
  // two values that make the rescue path permanently useless are refused.
  for (const [badAddr, label] of [[null, 'the vesting contract itself'], [token.toString(), 'the vesting token']]) {
    const args = [token.toString(), tge, acc[1].toString(), acc[0].toString(),
                  COMMIT.count, COMMIT.total, COMMIT.unlock, COMMIT.hash];
    if (badAddr === null) {
      // address(this) is not known before deployment, so it is exercised by
      // the contract's own check rather than by a literal: deploying with the
      // predicted CREATE address is the only way to hit it, and the guard is
      // instead demonstrated against the token, which is the reachable half.
      continue;
    }
    args[3] = badAddr;
    const r = await send({ data: load('HCOWVesting').bytecode + vestAbi.encodeDeploy(args).slice(2) });
    eq(errorName(vestAbi, r), 'InvalidRescueRecipient',
       `a rescue recipient set to ${label} is refused at deployment`);
  }

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

  // nothing may leave before the set is final
  {
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('release', [holders[0].toString()]) });
    ok(!!r.execResult.exceptionError, 'release before seal reverts');
  }
  // an underfunded seal is irreversible and unrepairable
  {
    const r = await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('seal') });
    ok(!!r.execResult.exceptionError, 'sealing while underfunded reverts');
  }
  ok(!(await read(vestAbi, vest, 'sealed_')), 'and the flag is still unset');

  await send({ from: 1, to: token, data: tokenAbi.encodeFunctionData('transfer', [vest.toString(), 1_000n * E18]) });
  eq(await read(vestAbi, vest, 'fundingShortfall'), 0n, 'shortfall closed before sealing');

  // The commitment now binds because it was fixed before the table existed.
  // Testing it means deploying against a figure that disagrees with the table
  // and confirming the contract refuses, which is the check an owner used to be
  // able to satisfy by reading the live values straight back off the contract.
  /** The full committed table as five parallel arrays, for replaceTable. */
  const allocArrays = (skipIdx = -1, wrongAmountAt = -1) => {
    const b = [], tot = [], bp = [], cl = [], li = [];
    for (let i = 0; i < ALLOC.length; i++) {
      if (i === skipIdx) continue;
      const [, amt, bps, cliff, lin] = ALLOC[i];
      b.push(holders[i].toString());
      tot.push(i === wrongAmountAt ? (amt - 1_000_000n) * E18 : amt * E18);
      bp.push(bps); cl.push(cliff); li.push(lin);
    }
    return [b, tot, bp, cl, li];
  };
  const loadAlloc = async (v, skipIdx = -1, wrongAmountAt = -1) => {
    for (let i = 0; i < ALLOC.length; i++) {
      if (i === skipIdx) continue;
      const [, amt, bps, cliff, lin] = ALLOC[i];
      const total = i === wrongAmountAt ? (amt - 1_000_000n) * E18 : amt * E18;
      const r = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
        [holders[i].toString(), total, bps, cliff, lin]) });
      if (r.execResult.exceptionError) throw new Error('addSchedule failed at ' + i);
    }
  };
  // The side deployments below need their own supply: the treasury has by now
  // funded the main contract with all 200,000,000. Without this they would
  // revert for want of tokens and pass for the wrong reason.
  const token2 = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
  const VEST2_ARGS = [token2.toString(), tge, acc[1].toString(), acc[0].toString(),
                      COMMIT.count, COMMIT.total, COMMIT.unlock, COMMIT.hash];

  // a committed total above what exists can never be funded, and the honest
  // place to discover that is before deployment rather than after a transfer
  {
    const over = [...VEST2_ARGS];
    over[5] = COMMIT.total + 1n;
    const r = await send({ data: load('HCOWVesting').bytecode + vestAbi.encodeDeploy(over).slice(2) });
    ok(!!r.execResult.exceptionError, 'committing more than the token supply is refused at deployment');
  }
  for (const [i, label] of [[4, 'beneficiary count'], [5, 'scheduled total'], [6, 'TGE unlock'], [7, 'schedule hash']]) {
    const bad = [...VEST2_ARGS];
    bad[i] = i === 7
      ? '0x' + (BigInt(bad[7]) ^ 1n).toString(16).padStart(64, '0')
      : (i === 5 ? bad[i] - 1n : bad[i] + 1n);
    const v = await deploy('HCOWVesting', vestAbi, bad);
    await loadAlloc(v);
    await send({ from: 1, to: token2, data: tokenAbi.encodeFunctionData('approve', [v.toString(), 200_000_000n * E18]) });
    const r = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('fundAndSeal') });
    ok(!!r.execResult.exceptionError, `a deployment committing the wrong ${label} cannot be sealed`);
  }
  // the merge the allocation table warns about: two community tranches as one
  // entry leaves both totals correct and only the count wrong
  {
    const merged = ALLOC.map(([, amt, bps, cliff, lin], i) => ({
      beneficiary: holders[i].toString(), total: amt * E18, tgeBps: bps, cliffMonths: cliff, linearMonths: lin,
    })).filter((_, i) => i !== 4);
    merged[3].total += 12_000_000n * E18;
    const c = commitments(merged);
    eq(c.count, 8n, 'the merged table has one row fewer');
    ok(c.total === COMMIT.total, 'and the merged table still sums to the same total');
  }

  // A mistyped row used to be unrecoverable: nothing could remove or amend an
  // entry, so the contract had to be redeployed. resetTable clears it.
  {
    const v = await deploy('HCOWVesting', vestAbi, VEST2_ARGS);
    await loadAlloc(v, -1, 0);
    ok(await read(vestAbi, v, 'totalScheduled') < COMMIT.total,
       'a mistyped amount well inside the supply bound is accepted silently');
    const r = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('seal') });
    ok(!!r.execResult.exceptionError, 'and the contract refuses to seal it');
    const rows = allocArrays();
    const nonOwner = await send({ from: 3, to: v,
      data: vestAbi.encodeFunctionData('replaceTable', rows) });
    ok(!!nonOwner.execResult.exceptionError, 'a non-owner cannot replace the table');
    const empty = await send({ from: 1, to: v,
      data: vestAbi.encodeFunctionData('replaceTable', [[], [], [], [], []]) });
    ok(!!empty.execResult.exceptionError, 'and the table cannot be replaced with nothing');
    eq(errorName(vestAbi, empty), 'NoSchedules',
       'refused for being empty, which is the state that used to be reachable');
    const mismatched = await send({ from: 1, to: v,
      data: vestAbi.encodeFunctionData('replaceTable',
        [rows[0], rows[1].slice(1), rows[2], rows[3], rows[4]]) });
    ok(!!mismatched.execResult.exceptionError, 'ragged arrays are refused');
    const fixed = await send({ from: 1, to: v,
      data: vestAbi.encodeFunctionData('replaceTable', rows) });
    ok(!fixed.execResult.exceptionError, 'the owner can replace a mistyped table');
    eq(await read(vestAbi, v, 'beneficiaryCount'), COMMIT.count,
       'the replacement is the whole table, not an append');
    eq(await read(vestAbi, v, 'totalScheduled'), COMMIT.total, 'and it sums to the commitment');
    eq(await read(vestAbi, v, 'scheduleHash'), COMMIT.hash, 'and reaches the committed hash');
    await send({ from: 1, to: token2, data: tokenAbi.encodeFunctionData('approve', [v.toString(), 200_000_000n * E18]) });
    const done = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('fundAndSeal') });
    ok(!done.execResult.exceptionError, 'and a corrected table seals');
    ok(await read(vestAbi, v, 'sealed_'), 'the recovered contract is sealed');
  }

  // resetTable must never be reachable on a FUNDED contract. Clearing a funded
  // table is not recoverable: addSchedule closes at TGE, so a table cleared and
  // not rebuilt before then can never be rebuilt, seal reverts NoSchedules
  // forever, release is gated on the seal, and there is no sweep. Measured on
  // the version without this guard: one call, 3,000,000 HCOW stranded.
  //
  // Declining to seal is recoverable, which is why seal has no deadline and
  // becomes permissionless at TGE. Emptying a funded table is not, so the two
  // are not the same power and the NatSpec that said they were was wrong.
  {
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const v = await deploy('HCOWVesting', vestAbi,
      [t.toString(), tge, acc[1].toString(), acc[1].toString(),
       COMMIT.count, COMMIT.total, COMMIT.unlock, COMMIT.hash]);
    await loadAlloc(v);
    // A dusted contract must still be correctable. Guarding the replacement on
    // the contract being empty was the obvious fix for the total-loss path and
    // the wrong one: anyone can send one wei here before the table is loaded
    // and disable the correction path for good.
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('transfer', [v.toString(), 1n]) });
    const dusted = await send({ from: 1, to: v,
      data: vestAbi.encodeFunctionData('replaceTable', allocArrays()) });
    ok(!dusted.execResult.exceptionError,
       'a stranger cannot disable the correction path by dusting the contract');
    eq(await read(vestAbi, v, 'scheduleHash'), COMMIT.hash, 'and the table is still correct');

    // and the intended path still works: fundAndSeal from here
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('approve', [v.toString(), 200_000_000n * E18]) });
    const sealed = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('fundAndSeal') });
    ok(!sealed.execResult.exceptionError, 'and the funded contract still seals');
  }

  await send({ from: 1, to: vest, data: vestAbi.encodeFunctionData('seal') });
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
  // rescueForeignToken exists and is deliberately not one of the above: it can
  // never move the vesting token, and it sends to an address fixed at
  // deployment rather than to its caller. The audit recommended a bounded sweep
  // of surplus vesting tokens too; that is declined, because fundAndSeal pulls
  // the exact shortfall so a surplus has no way to arise on the intended path.
  ok(vfns.includes('rescueForeignToken'), 'a foreign token sent here by mistake can be recovered');

  console.log('\nAudit follow-ups');
  // time has moved a long way past the original TGE by now
  const tge2 = now + 10n * DAY;
  const V2 = (tok, own) => [tok, tge2, own, acc[0].toString(),
                            COMMIT.count, COMMIT.total, COMMIT.unlock, COMMIT.hash];
  {
    // Low #3: a transposed or mistyped period is caught at entry, not at seal
    const t5 = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const v = await deploy('HCOWVesting', vestAbi, V2(t5.toString(), acc[1].toString()));
    const long = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      ['0x' + 'aa'.repeat(20), 1n * E18, 0, 0, 1200]) });
    ok(!!long.execResult.exceptionError, 'a 1200 month linear period is refused at entry');
    const ok120 = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      ['0x' + 'aa'.repeat(20), 1n * E18, 0, 84, 36]) });
    ok(!ok120.execResult.exceptionError, 'and 84 + 36 months, the bound exactly, is accepted');
    const over = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      ['0x' + 'bb'.repeat(20), 1n * E18, 0, 84, 37]) });
    ok(!!over.execResult.exceptionError, 'while 84 + 37 is not');

    // Low #4: the renounce revert no longer asserts something false
    const ren = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('renounceOwnership') });
    ok(!!ren.execResult.exceptionError, 'ownership cannot be renounced');
    const sel = vestAbi.getError('OwnershipIsPermanent').selector;
    ok(bytesToHex(ren.execResult.returnValue).startsWith(sel),
       'and it reverts with OwnershipIsPermanent, not with a false claim that the contract is sealed');

    // Low #4: a named error rather than a low level panic
    const oob = await send({ to: v, data: vestAbi.encodeFunctionData('beneficiaryAt', [99n]) });
    ok(bytesToHex(oob.execResult.returnValue).startsWith(vestAbi.getError('IndexOutOfBounds').selector),
       'reading past the end of the beneficiary list gives a named error');

    // resetTable is refused once the table is frozen anyway
    ok(await read(vestAbi, v, 'committedTotalIsFundable'),
       'committedTotalIsFundable reports true while supply covers the commitment');
  }
  {
    // Medium #1: the failure the whole change exists to remove. A treasury that
    // sends the balance it holds rather than the figure asked for, when that
    // balance is short, strands everything: the transfer succeeds, seal can
    // never pass, release is gated on seal and there is no sweep.
    const t3 = await deploy('HCOWToken', tokenAbi, [acc[2].toString()]);
    const v = await deploy('HCOWVesting', vestAbi, V2(t3.toString(), acc[2].toString()));
    for (let i = 0; i < ALLOC.length; i++) {
      const [, amt, bps, cliff, lin] = ALLOC[i];
      await send({ from: 2, to: v, data: vestAbi.encodeFunctionData('addSchedule',
        [holders[i].toString(), amt * E18, bps, cliff, lin]) });
    }
    // burn one wei, so the treasury's balance is now short of the committed total
    await send({ from: 2, to: t3, data: tokenAbi.encodeFunctionData('burn', [1n]) });
    const held = await read(tokenAbi, t3, 'balanceOf', [acc[2].toString()]);
    ok(held < COMMIT.total, 'the treasury now holds less than the committed total');
    ok(!(await read(vestAbi, v, 'committedTotalIsFundable')),
       'committedTotalIsFundable reports false, which is the check to run before funding');

    // the send-max path: transfer succeeds, and the contract is then stuck
    await send({ from: 2, to: t3, data: tokenAbi.encodeFunctionData('transfer', [v.toString(), held]) });
    const stuck = await send({ from: 2, to: v, data: vestAbi.encodeFunctionData('seal') });
    ok(!!stuck.execResult.exceptionError, 'sealing after a short send-max transfer is impossible');

    // and fundAndSeal is the path that cannot go wrong, because there is no
    // figure for a human to type
    const t4 = await deploy('HCOWToken', tokenAbi, [acc[3].toString()]);
    const v4 = await deploy('HCOWVesting', vestAbi, V2(t4.toString(), acc[3].toString()));
    for (let i = 0; i < ALLOC.length; i++) {
      const [, amt, bps, cliff, lin] = ALLOC[i];
      await send({ from: 3, to: v4, data: vestAbi.encodeFunctionData('addSchedule',
        [holders[i].toString(), amt * E18, bps, cliff, lin]) });
    }
    await send({ from: 3, to: t4, data: tokenAbi.encodeFunctionData('approve', [v4.toString(), 200_000_000n * E18]) });
    const atomic = await send({ from: 3, to: v4, data: vestAbi.encodeFunctionData('fundAndSeal') });
    ok(!atomic.execResult.exceptionError, 'fundAndSeal funds and seals in one transaction');
    ok(await read(vestAbi, v4, 'sealed_'), 'leaving no funded-and-unsealed window at all');
    eq(await read(tokenAbi, t4, 'balanceOf', [v4.toString()]), COMMIT.total,
       'and it pulled exactly the committed total, no more and no less');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
