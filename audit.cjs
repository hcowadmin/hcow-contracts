/* HCOW — adversarial and property tests. The checks an audit actually runs. */
const fs = require('fs');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, privateToAddress } = require('@ethereumjs/util');
const { Interface } = require('ethers');

const E18 = 10n ** 18n, DAY = 86400n, MONTH = 30n * DAY;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const eq = (a, b, m) => ok(a === b, a === b ? m : `${m}   got ${a} want ${b}`);
const load = n => JSON.parse(fs.readFileSync(`artifacts/${n}.json`, 'utf8'));
const keys = Array.from({length: 6}, (_, i) => '0x' + (i + 17).toString(16).padStart(2, '0').repeat(32));
const acc = keys.map(k => new Address(privateToAddress(hexToBytes(k))));

let vm, common, now = 1900000000n;
const blk = () => Block.fromBlockData({ header: { timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n, number: 1n } },
  { common, skipConsensusFormatValidation: true });

async function send({ from = 0, to = null, data }) {
  const a = acc[from], account = await vm.stateManager.getAccount(a);
  const tx = LegacyTransaction.fromTxData({ nonce: account.nonce, gasPrice: 10n, gasLimit: 29_000_000n,
    to: to ?? undefined, value: 0n, data: hexToBytes(data) }, { common }).sign(hexToBytes(keys[from]));
  return vm.runTx({ tx, block: blk(), skipBalance: true, skipBlockGasLimitValidation: true });
}
async function call(to, data) {
  const r = await vm.evm.runCall({ to, caller: acc[0], origin: acc[0], data: hexToBytes(data), gasLimit: 29_000_000n, block: blk() });
  if (r.execResult.exceptionError) throw new Error('reverted');
  return bytesToHex(r.execResult.returnValue);
}
const read = (i, to, fn, a = []) => call(to, i.encodeFunctionData(fn, a)).then(r => i.decodeFunctionResult(fn, r)[0]);
async function deploy(name, iface, args) {
  const r = await send({ data: load(name).bytecode + (args.length ? iface.encodeDeploy(args).slice(2) : '') });
  if (r.execResult.exceptionError) throw new Error(name + ' deploy: ' + r.execResult.exceptionError.error);
  return r.createdAddress;
}

/** Seal with the commitment the contract has actually been loaded with. */
async function sealNow(vestAbi, v) {
  const n = await read(vestAbi, v, 'beneficiaryCount');
  const t = await read(vestAbi, v, 'totalScheduled');
  const g = await read(vestAbi, v, 'totalTgeUnlock');
  const h = await read(vestAbi, v, 'scheduleHash');
  return send({ to: v, data: vestAbi.encodeFunctionData('seal', [n, t, g, h]) });
}

async function main() {
  common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
  vm = await VM.create({ common });
  for (const a of acc) await vm.stateManager.modifyAccountFields(a, { balance: 10n ** 22n });

  const tokenAbi = new Interface(load('HCOWToken').abi);
  const vestAbi = new Interface(load('HCOWVesting').abi);
  const reAbi = new Interface(load('ReentrantToken').abi);
  const sfAbi = new Interface(load('SilentFailToken').abi);

  // ==================== A. Reentrancy ====================
  console.log('\nA. 재진입');
  {
    const rt = await deploy('ReentrantToken', reAbi, []);
    const tge = now + 1n;
    // Mint before the vesting contract is deployed. HCOWVesting snapshots the
    // token supply in its constructor rather than reading it live, so a token
    // whose supply appears afterwards leaves the bound at zero. HCOWToken mints
    // its whole supply in its own constructor, so this ordering is the real one.
    await send({ to: rt, data: reAbi.encodeFunctionData('mint', [acc[0].toString(), 10_000n * E18]) });
    const v = await deploy('HCOWVesting', vestAbi, [rt.toString(), tge, acc[0].toString()]);
    // Fund well above one schedule's total, and add a second schedule, so a
    // successful re-entrant payout would actually be fundable. Minting exactly
    // one schedule's worth makes the mock's own balance check do the work, and
    // the test then passes against a contract with no ordering discipline at
    // all: an interaction-first release() double-pays here and the assertion
    // below still reads clean.
    await send({ to: rt, data: reAbi.encodeFunctionData('mint', [v.toString(), 10_000n * E18]) });
    await send({ to: v, data: vestAbi.encodeFunctionData('addSchedule', [acc[1].toString(), 1_000n * E18, 5000, 0, 12]) });
    await send({ to: v, data: vestAbi.encodeFunctionData('addSchedule', [acc[2].toString(), 9_000n * E18, 5000, 0, 12]) });
    await sealNow(vestAbi, v);
    await send({ to: rt, data: reAbi.encodeFunctionData('arm', [v.toString(), acc[1].toString()]) });
    now = tge + 6n * MONTH;
    const r = await send({ to: v, data: vestAbi.encodeFunctionData('release', [acc[1].toString()]) });
    const reenters = await read(reAbi, rt, 'reenterCount');
    const succeeded = await read(reAbi, rt, 'reentrySucceeded');
    const bal = await read(reAbi, rt, 'balanceOf', [acc[1].toString()]);
    ok(!r.execResult.exceptionError, 'the outer release completed');
    eq(reenters, 1n, 'a hostile token really did re-enter release() during the transfer');
    ok(succeeded === false, 'the re-entrant call reverted: state is written before the transfer, so nothing was left to release');
    // vested at 6 of 12 linear months on a 50% TGE schedule = 500 + 250 = 750
    eq(bal, 750n * E18, 'the beneficiary received exactly the vested amount and not a wei more');
  }

  // ==================== B. Non-standard tokens ====================
  console.log('\nB. 비표준 토큰');
  {
    const sf = await deploy('SilentFailToken', sfAbi, []);
    const tge = now + 1n;
    await send({ to: sf, data: sfAbi.encodeFunctionData('mint', [acc[0].toString(), 100n * E18]) });
    const v = await deploy('HCOWVesting', vestAbi, [sf.toString(), tge, acc[0].toString()]);
    await send({ to: sf, data: sfAbi.encodeFunctionData('mint', [v.toString(), 100n * E18]) });
    await send({ to: v, data: vestAbi.encodeFunctionData('addSchedule', [acc[2].toString(), 100n * E18, 10000, 0, 0]) });
    // Seal, or release() stops at the NotSealed gate and the assertion below
    // never reaches SafeERC20 at all.
    await sealNow(vestAbi, v);
    now = tge + 1n;
    const r = await send({ to: v, data: vestAbi.encodeFunctionData('release', [acc[2].toString()]) });
    ok(!!r.execResult.exceptionError, 'a token that returns false instead of reverting causes release to revert, not to silently mark tokens released');
  }

  // ==================== C. Access control ====================
  console.log('\nC. 접근 제어');
  {
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
    for (const [fn, args] of [
      ['addSchedule', [acc[3].toString(), 1n * E18, 0, 0, 1]],
      // seal is owner-only until TGE; `now` is ten days before it here.
      ['seal', [1n, 1n, 0n, '0x' + '00'.repeat(32)]],
    ]) {
      const r = await send({ from: 4, to: v, data: vestAbi.encodeFunctionData(fn, args) });
      ok(!!r.execResult.exceptionError, `a stranger cannot call ${fn}()`);
    }
    // Ownable2Step: a one-step transfer must not take effect
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('transferOwnership', [acc[4].toString()]) });
    eq((await read(vestAbi, v, 'owner')).toLowerCase(), acc[1].toString().toLowerCase(), 'transferOwnership alone does not change the owner (two-step)');
    const r2 = await send({ from: 4, to: v, data: vestAbi.encodeFunctionData('addSchedule', [acc[3].toString(), 1n * E18, 0, 0, 1]) });
    ok(!!r2.execResult.exceptionError, 'the pending owner has no power before accepting');
    await send({ from: 4, to: v, data: vestAbi.encodeFunctionData('acceptOwnership') });
    eq((await read(vestAbi, v, 'owner')).toLowerCase(), acc[4].toString().toLowerCase(), 'ownership moves only after acceptOwnership');
  }

  // ==================== D. Vesting maths, property based ====================
  console.log('\nD. 베스팅 수학 (속성 검증)');
  {
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);

    // pseudo-random but deterministic parameter sweep
    const cases = [];
    let seed = 12345n;
    const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (2n ** 64n); return seed % n; };
    for (let i = 0; i < 24; i++) {
      cases.push({
        who: new Address(privateToAddress(hexToBytes('0x' + (0x40 + i).toString(16).padStart(2, '0').repeat(32)))),
        total: (1n + rnd(5_000_000n)) * E18,
        bps: Number(rnd(10001n)),
        cliff: Number(rnd(25n)),
        lin: Number(rnd(49n)),
      });
    }
    for (const c of cases) {
      const r = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
        [c.who.toString(), c.total, c.bps, c.cliff, c.lin]) });
      if (r.execResult.exceptionError) throw new Error('addSchedule failed: ' + JSON.stringify(c));
    }

    let monotonic = true, neverOver = true, tgeExact = true, endsExact = true, zeroBefore = true;
    const marks = [-1n, 0n, 1n, 3n, 6n, 12n, 18n, 24n, 36n, 48n, 72n, 120n];
    for (const c of cases) {
      let prev = -1n;
      for (const m of marks) {
        now = m < 0n ? tge - 1n : tge + m * MONTH;
        const vested = await read(vestAbi, v, 'vestedAmount', [c.who.toString()]);
        if (m < 0n && vested !== 0n) zeroBefore = false;
        if (vested < prev) monotonic = false;
        if (vested > c.total) neverOver = false;
        prev = vested;
      }
      now = tge;
      const atTge = await read(vestAbi, v, 'vestedAmount', [c.who.toString()]);
      if (atTge !== (c.total * BigInt(c.bps)) / 10000n) tgeExact = false;
      now = tge + BigInt(c.cliff + c.lin) * MONTH;
      const atEnd = await read(vestAbi, v, 'vestedAmount', [c.who.toString()]);
      if (atEnd !== c.total) endsExact = false;
    }
    ok(zeroBefore, '24개 무작위 스케줄 전부 TGE 이전에는 0');
    ok(monotonic, 'vestedAmount never decreases as time moves forward');
    ok(neverOver, 'vestedAmount never exceeds the schedule total');
    ok(tgeExact, 'the TGE amount is exactly total * tgeBps / 10000 for every schedule');
    ok(endsExact, 'every schedule reaches exactly its total at cliff + linear');
  }

  // ==================== E. Edge cases ====================
  console.log('\nE. 경계 조건');
  {
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
    const A = acc[2], B = acc[3], C = acc[5];
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule', [A.toString(), 100n * E18, 10000, 0, 0]) });
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule', [B.toString(), 100n * E18, 0, 6, 0]) });
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule', [C.toString(), 3n, 1, 0, 7]) });

    now = tge;
    eq(await read(vestAbi, v, 'vestedAmount', [A.toString()]), 100n * E18, '100% TGE with no cliff releases everything immediately');
    eq(await read(vestAbi, v, 'vestedAmount', [B.toString()]), 0n, '0% TGE with a cliff and zero linear months releases nothing before the cliff');
    now = tge + 6n * MONTH;
    eq(await read(vestAbi, v, 'vestedAmount', [B.toString()]), 100n * E18, 'zero linear months makes the cliff a full unlock (documented behaviour)');
    now = tge + 3n * MONTH;
    const dust = await read(vestAbi, v, 'vestedAmount', [C.toString()]);
    ok(dust >= 0n && dust <= 3n, 'a 3 wei schedule rounds down and never over-releases');
    now = tge + 7n * MONTH;
    eq(await read(vestAbi, v, 'vestedAmount', [C.toString()]), 3n, 'rounding dust is fully paid out by the end of the schedule');

    const r = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule', [acc[4].toString(), 1n * E18, 10001, 0, 1]) });
    ok(!!r.execResult.exceptionError, 'tgeBps above 10000 reverts');
    const r2 = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule', [acc[4].toString(), 0n, 0, 0, 1]) });
    ok(!!r2.execResult.exceptionError, 'a zero-amount schedule reverts');
    const r3 = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule', ['0x' + '00'.repeat(20), 1n * E18, 0, 0, 1]) });
    ok(!!r3.execResult.exceptionError, 'the zero address cannot be a beneficiary');
    try { await read(vestAbi, v, 'releasable', [acc[4].toString()]); ok(true, 'releasable on an unknown address returns 0 rather than reverting'); }
    catch { ok(false, 'releasable on an unknown address should not revert'); }
    const r4 = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[4].toString(), 200_000_001n * E18, 0, 0, 12]) });
    ok(!!r4.execResult.exceptionError, 'scheduling more than the token supply reverts');
  }

  // ==================== F. Token invariants ====================
  console.log('\nF. 토큰 불변식');
  {
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const before = await read(tokenAbi, t, 'totalSupply');
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('transfer', [acc[2].toString(), 10n * E18]) });
    const after = await read(tokenAbi, t, 'totalSupply');
    eq(after, before, 'a transfer never changes total supply, so there is no hidden mint');
    const r = await send({ from: 2, to: t, data: tokenAbi.encodeFunctionData('transfer', [acc[3].toString(), 11n * E18]) });
    ok(!!r.execResult.exceptionError, 'transferring more than the balance reverts');
    const r2 = await send({ from: 2, to: t, data: tokenAbi.encodeFunctionData('transferFrom', [acc[1].toString(), acc[2].toString(), 1n * E18]) });
    ok(!!r2.execResult.exceptionError, 'transferFrom without an allowance reverts');
    const r3 = await send({ from: 2, to: t, data: tokenAbi.encodeFunctionData('burn', [11n * E18]) });
    ok(!!r3.execResult.exceptionError, 'burning more than the balance reverts');
    const sel = new Set(load('HCOWToken').abi.filter(x => x.type === 'function').map(x => x.name));
    ok(!sel.has('increaseAllowance') && !sel.has('decreaseAllowance'),
       'no non-standard allowance helpers (removed in OpenZeppelin 5, matches current ERC20)');
    // DOMAIN_SEPARATOR is chain-bound
    const ds = await read(tokenAbi, t, 'DOMAIN_SEPARATOR');
    ok(typeof ds === 'string' && ds.length === 66, 'EIP-712 domain separator is present for permit');
  }

  // ============ G. Regressions from the 2026-08-25 system review ============
  console.log('\nG. 2026-08-25 시스템 검수 회귀');
  {
    // G-1  A schedule with no cliff and no linear period unlocks everything at
    //      TGE whatever tgeBps says, so the figure seal() commits to would not
    //      be the figure that happens. A dropped fifth argument produces it.
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
    const bad = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[3].toString(), 60_000_000n * E18, 1500, 0, 0]) });
    ok(!!bad.execResult.exceptionError,
       'a schedule with a partial TGE unlock but no cliff and no linear period is refused');
    const full = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[3].toString(), 100n * E18, 10000, 0, 0]) });
    ok(!full.execResult.exceptionError,
       'a deliberate full unlock at TGE is still allowed, since it says what it does');

    // G-2  totalTgeUnlock reports what will actually be released at tgeTime,
    //      not the sum of tgeBps.
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[4].toString(), 100n * E18, 0, 3, 0]) });
    eq(await read(vestAbi, v, 'totalTgeUnlock'), 100n * E18,
       'a cliff-drop schedule contributes nothing to the TGE unlock figure');
  }
  {
    // G-3  Transposing cliffMonths and linearMonths leaves the count, the
    //      scheduled total and the TGE unlock all correct. Only the schedule
    //      hash moves, and seal() checks it.
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const rows = [[20_000_000n, 2500, 0, 3], [10_000_000n, 0, 12, 36]];
    const load2 = async (swap) => {
      const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
      for (let i = 0; i < rows.length; i++) {
        const [amt, bps, c, l] = rows[i];
        await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
          [acc[2 + i].toString(), amt * E18, bps, swap ? l : c, swap ? c : l]) });
      }
      return v;
    };
    const good = await load2(false), swapped = await load2(true);
    eq(await read(vestAbi, swapped, 'beneficiaryCount'), await read(vestAbi, good, 'beneficiaryCount'),
       'a transposed cliff and linear leaves the beneficiary count identical');
    eq(await read(vestAbi, swapped, 'totalScheduled'), await read(vestAbi, good, 'totalScheduled'),
       'and the scheduled total identical');
    eq(await read(vestAbi, swapped, 'totalTgeUnlock'), await read(vestAbi, good, 'totalTgeUnlock'),
       'and the TGE unlock identical');
    ok(await read(vestAbi, swapped, 'scheduleHash') !== await read(vestAbi, good, 'scheduleHash'),
       'but the schedule hash differs, which is the only thing that catches it');
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('transfer',
      [swapped.toString(), 30_000_000n * E18]) });
    const r = await send({ from: 1, to: swapped, data: vestAbi.encodeFunctionData('seal',
      [await read(vestAbi, good, 'beneficiaryCount'), await read(vestAbi, good, 'totalScheduled'),
       await read(vestAbi, good, 'totalTgeUnlock'), await read(vestAbi, good, 'scheduleHash')]) });
    ok(!!r.execResult.exceptionError,
       'sealing a transposed load against the published commitment is refused');
  }
  {
    // G-4  Missing the TGE date must not lock the balance forever. seal() has
    //      no deadline; addSchedule is what closes at TGE.
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
    // A one month cliff so the assertion below is not chasing a second of linear.
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[3].toString(), 1_000n * E18, 2500, 1, 12]) });
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('transfer', [v.toString(), 1_000n * E18]) });
    const saved = now;
    now = tge + 1n;
    const late = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[4].toString(), 1n * E18, 10000, 0, 0]) });
    ok(!!late.execResult.exceptionError, 'a schedule cannot be added at or after TGE');
    const sealLate = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('seal',
      [1n, 1_000n * E18, 250n * E18, await read(vestAbi, v, 'scheduleHash')]) });
    ok(!sealLate.execResult.exceptionError, 'but the contract can still be sealed after TGE');
    ok(await read(vestAbi, v, 'sealed_'), 'so a missed date is a delay, not a permanent loss');
    const rel = await send({ from: 0, to: v, data: vestAbi.encodeFunctionData('release', [acc[3].toString()]) });
    ok(!rel.execResult.exceptionError, 'and the beneficiary is paid');
    eq(await read(tokenAbi, t, 'balanceOf', [acc[3].toString()]), 250n * E18,
       'exactly the TGE unlock, so nothing extra was released by sealing late');
    now = saved;
  }
  {
    // G-5  The supply bound is snapshotted at construction, so a burn by any
    //      holder cannot block the published table from being loaded.
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('transfer', [acc[5].toString(), 1n]) });
    await send({ from: 5, to: t, data: tokenAbi.encodeFunctionData('burn', [1n]) });
    ok(await read(tokenAbi, t, 'totalSupply') < 200_000_000n * E18, 'a holder burned one wei');
    const r = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[3].toString(), 200_000_000n * E18, 0, 0, 12]) });
    ok(!r.execResult.exceptionError, 'the full published total still loads after a burn');
    const over = await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[4].toString(), 1n * E18, 0, 0, 12]) });
    ok(!!over.execResult.exceptionError, 'and scheduling past the snapshot is still refused');
  }
  {
    // G-6  Ownership really is frozen by the seal, including a transfer that
    //      was started before it.
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[3].toString(), 1_000n * E18, 2500, 0, 12]) });
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('transfer', [v.toString(), 1_000n * E18]) });
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('transferOwnership', [acc[4].toString()]) });
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('seal',
      [1n, 1_000n * E18, 250n * E18, await read(vestAbi, v, 'scheduleHash')]) });
    const acc4 = await send({ from: 4, to: v, data: vestAbi.encodeFunctionData('acceptOwnership', []) });
    ok(!!acc4.execResult.exceptionError, 'a transfer pending at the seal cannot be accepted afterwards');
    eq((await read(vestAbi, v, 'owner')).toLowerCase(), acc[1].toString().toLowerCase(),
       'the owner is unchanged');
    eq((await read(vestAbi, v, 'pendingOwner')).toLowerCase(), '0x' + '00'.repeat(20),
       'and seal() cleared the pending owner, so an explorer shows no live administrator');
  }
  {
    // G-7  A TGE further out than a year is a typo, not a plan.
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const r = await send({ to: null, data: load('HCOWVesting').bytecode +
      vestAbi.encodeDeploy([t.toString(), now + 400n * DAY, acc[1].toString()]).slice(2) });
    ok(!!r.execResult.exceptionError, 'a TGE more than a year out is refused at construction');
  }

  {
    // G-8  Sealing must not be owner-only forever. A lost, frozen or simply
    //      unwilling owner key otherwise holds every beneficiary's tokens with
    //      no sweep and no recovery, which is the same total loss the seal
    //      deadline used to cause, arriving by a different road.
    const t = await deploy('HCOWToken', tokenAbi, [acc[1].toString()]);
    const tge = now + 10n * DAY;
    const v = await deploy('HCOWVesting', vestAbi, [t.toString(), tge, acc[1].toString()]);
    await send({ from: 1, to: v, data: vestAbi.encodeFunctionData('addSchedule',
      [acc[3].toString(), 1_000n * E18, 2500, 1, 12]) });
    await send({ from: 1, to: t, data: tokenAbi.encodeFunctionData('transfer', [v.toString(), 1_000n * E18]) });
    const commit = [1n, 1_000n * E18, 250n * E18, await read(vestAbi, v, 'scheduleHash')];

    const early = await send({ from: 4, to: v, data: vestAbi.encodeFunctionData('seal', commit) });
    ok(!!early.execResult.exceptionError, 'before TGE only the owner can seal');

    const saved = now;
    now = tge + 1n;
    const late = await send({ from: 4, to: v, data: vestAbi.encodeFunctionData('seal', commit) });
    ok(!late.execResult.exceptionError, 'at or after TGE anyone can seal');
    ok(await read(vestAbi, v, 'sealed_'), 'so a lost owner key is not a total loss');
    const wrong = await send({ from: 4, to: v, data: vestAbi.encodeFunctionData('seal',
      [2n, 1_000n * E18, 250n * E18, commit[3]]) });
    ok(!!wrong.execResult.exceptionError, 'and a stranger still cannot seal against wrong figures');
    now = saved;
  }
  {
    // G-9  A token with nothing minted yet gives a zero supply cap, which
    //      refuses every addSchedule and leaves a contract that can never be
    //      finished, added to, or renounced.
    const rt = await deploy('ReentrantToken', reAbi, []);
    const r = await send({ to: null, data: load('HCOWVesting').bytecode +
      vestAbi.encodeDeploy([rt.toString(), now + 10n * DAY, acc[1].toString()]).slice(2) });
    ok(!!r.execResult.exceptionError, 'deploying against a token with zero supply is refused');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
