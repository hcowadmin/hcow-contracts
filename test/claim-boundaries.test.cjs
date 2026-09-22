'use strict';
/* HCOWClaim, at the boundaries and in the gaps that the spec-section-7 suite
 * leaves open.
 *
 * WHY THIS FILE EXISTS
 *
 * test/HCOWClaim.test.cjs implements the sixteen tests spec v0.1 section 7
 * asks for, and it implements them well: it names the revert it expects rather
 * than accepting any revert, and it builds its trees with the production
 * generator. What it does not do is go near an edge. Every timestamp it uses
 * sits hundreds of seconds or hundreds of days from the guard it is testing,
 * and its largest leaf index is 11.
 *
 * The fourth adversarial audit (2026-09-18) measured what that costs: of 58
 * hand-written mutations, 29 survived with the suite still reporting 108
 * passed, 0 failed. Two of the survivors were not cosmetic --
 *
 *   - replacing `bitMap[w] |= 1<<bit` with `bitMap[w] = 1<<bit` pays the same
 *     account twice, because claiming a second index in the same 256-index
 *     word clears the first one's bit. The suite claims one index twice in a
 *     row and never claims a DIFFERENT index in between, which is the only
 *     order in which a bitmap can fail.
 *   - moving setRoot's freeze from `>=` to `>` lets the owner rewrite the root
 *     of a round in the very block it opens, which design note 3 says the
 *     project cannot defend.
 *
 * The contract is correct today. Every case below passes against it unchanged.
 * What this file buys is that the next edit cannot quietly undo any of it.
 *
 * Each case names the mutation it kills, so that a future reader can check the
 * claim rather than trust it.
 */
const fs = require('fs');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, privateToAddress } = require('@ethereumjs/util');
const { Interface, getAddress, solidityPackedKeccak256, keccak256, concat } = require('ethers');

const E = 10n ** 18n, DAY = 86400n;
// 4차 감사 A-1 의 고지 기간. 이 파일의 대부분은 고지 자체가 아니라 다른 경계를
// 재므로 하한(1시간)을 쓰고, 회차를 등록한 뒤 시계를 그만큼 넘긴다.
const NOTICE = 3600n;
const WINDOW = 3600n;   // minClaimWindow: 1h floor, same rehearsal reason as NOTICE
const load = (n) => JSON.parse(fs.readFileSync(`artifacts/${n}.json`, 'utf8'));
const keys = Array.from({ length: 6 }, (_, i) => '0x' + (i + 17).toString(16).padStart(2, '0').repeat(32));
const acc = keys.map((k) => new Address(privateToAddress(hexToBytes(k))));
const A = (i) => getAddress(acc[i].toString());

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const eq = (a, b, m) => ok(a === b, a === b ? m : `${m}   got ${a} want ${b}`);

let vm, common, now = 1900000000n;
const mkBlock = () => Block.fromBlockData(
  { header: { timestamp: now, gasLimit: 30000000n, baseFeePerGas: 0n, number: 1n } },
  { common, skipConsensusFormatValidation: true });

async function send({ from = 0, to = null, data }) {
  const a = acc[from];
  const account = await vm.stateManager.getAccount(a);
  const tx = LegacyTransaction.fromTxData({
    nonce: account.nonce, gasPrice: 10n, gasLimit: 29000000n,
    to: to ?? undefined, value: 0n, data: hexToBytes(data),
  }, { common }).sign(hexToBytes(keys[from]));
  return vm.runTx({ tx, block: mkBlock(), skipBalance: true, skipBlockGasLimitValidation: true });
}
async function call(to, data) {
  const r = await vm.evm.runCall({ to, caller: acc[0], origin: acc[0], data: hexToBytes(data), gasLimit: 29000000n, block: mkBlock() });
  if (r.execResult.exceptionError) throw new Error('call reverted');
  return bytesToHex(r.execResult.returnValue);
}
const read = (i, to, fn, args = []) => call(to, i.encodeFunctionData(fn, args)).then((r) => i.decodeFunctionResult(fn, r)[0]);
function errName(iface, r) {
  const d = bytesToHex(r.execResult.returnValue || new Uint8Array());
  if (!r.execResult.exceptionError) return null;
  if (!d || d.length < 10) return r.execResult.exceptionError.error;
  try { return iface.parseError(d)?.name ?? 'unknown'; } catch (_) { return 'unknown'; }
}
async function deployC(name, iface, args) {
  const art = load(name);
  const r = await send({ data: art.bytecode + (args.length ? iface.encodeDeploy(args).slice(2) : '') });
  if (r.execResult.exceptionError) throw new Error(name + ' deploy failed');
  return r.createdAddress;
}

// ---------------------------------------------------- hand-built two-leaf tree
const leafOf = (round, index, account, amount) =>
  solidityPackedKeccak256(['uint256', 'uint256', 'address', 'uint256'], [round, index, account, amount]);
const pair = (a, b) => (BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
/** Two entries, so that two DIFFERENT indexes exist in one round. */
function twoLeaf(round, e0, e1) {
  const l0 = leafOf(round, e0.index, e0.account, e0.amount);
  const l1 = leafOf(round, e1.index, e1.account, e1.amount);
  return { root: pair(l0, l1), proofs: { [e0.index]: [l1], [e1.index]: [l0] } };
}

async function main() {
  common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
  vm = await VM.create({ common });
  for (const a of acc) await vm.stateManager.modifyAccountFields(a, { balance: 10n ** 22n });

  const ti = new Interface(load('HCOWToken').abi);
  const ci = new Interface(load('HCOWClaim').abi);

  const token = await deployC('HCOWToken', ti, [A(0)]);
  const DEADLINE = now + 500n * DAY;
  const claim = await deployC('HCOWClaim', ci, [token.toString(), A(0), DEADLINE, NOTICE, WINDOW]);
  await send({ to: token, data: ti.encodeFunctionData('transfer', [claim.toString(), 100000n * E]) });

  const bal = (who) => read(ti, token, 'balanceOf', [who]);
  const isClaimed = (r, i) => read(ci, claim, 'isClaimed', [r, i]);

  // ------------------------------------------------------------------ bitmap
  console.log('\n1. the bitmap, with more than one index in play  (kills M08, M09)\n');
  {
    // Two indexes in the SAME 256-index word. This is the arrangement the
    // existing suite never builds, and the only one in which `=` instead of
    // `|=` is visible.
    const AMT = 10n * E;
    const t = twoLeaf(1n, { index: 0n, account: A(1), amount: AMT }, { index: 1n, account: A(2), amount: AMT });
    await send({ to: claim, data: ci.encodeFunctionData('setRoot', [1n, t.root, now + NOTICE]) });
    now += NOTICE;

    const before1 = await bal(A(1));
    await send({ to: claim, data: ci.encodeFunctionData('claim', [1n, 0n, A(1), AMT, t.proofs[0]]) });
    ok(await isClaimed(1n, 0n), 'index 0 is marked claimed');

    await send({ to: claim, data: ci.encodeFunctionData('claim', [1n, 1n, A(2), AMT, t.proofs[1]]) });
    ok(await isClaimed(1n, 1n), 'index 1 is marked claimed');
    ok(await isClaimed(1n, 0n), 'AND index 0 is STILL marked claimed afterwards');

    const again = await send({ to: claim, data: ci.encodeFunctionData('claim', [1n, 0n, A(1), AMT, t.proofs[0]]) });
    eq(errName(ci, again), 'AlreadyClaimed', 'so index 0 cannot be claimed a second time');
    eq(await bal(A(1)), before1 + AMT, 'and the account was paid exactly once');
  }
  {
    // Word boundary. 255 and 256 are in different words; 255 and 254 are not.
    const AMT = 3n * E;
    const t = twoLeaf(2n, { index: 255n, account: A(3), amount: AMT }, { index: 256n, account: A(4), amount: AMT });
    await send({ to: claim, data: ci.encodeFunctionData('setRoot', [2n, t.root, now + NOTICE]) });
    now += NOTICE;
    await send({ to: claim, data: ci.encodeFunctionData('claim', [2n, 255n, A(3), AMT, t.proofs[255]]) });
    ok(await isClaimed(2n, 255n), 'index 255 claims (the high bit of word 0)');
    ok(!(await isClaimed(2n, 256n)), 'and index 256, the first bit of word 1, is untouched');
    ok(!(await isClaimed(2n, 254n)) && !(await isClaimed(2n, 0n)), 'and so are 254 and 0');
    await send({ to: claim, data: ci.encodeFunctionData('claim', [2n, 256n, A(4), AMT, t.proofs[256]]) });
    ok(await isClaimed(2n, 256n) && await isClaimed(2n, 255n), 'index 256 claims and 255 survives it');
  }

  // ------------------------------------------------------------ setRoot freeze
  console.log('\n2. setRoot freezes AT startTime, not after it  (kills M01)\n');
  {
    const OPENS = now + NOTICE + 100n;
    const t = twoLeaf(3n, { index: 0n, account: A(1), amount: 1n * E }, { index: 1n, account: A(2), amount: 1n * E });
    await send({ to: claim, data: ci.encodeFunctionData('setRoot', [3n, t.root, OPENS]) });

    // 고지 기간이 들어오면서 "개시 1초 전 정정" 은 더 이상 가능하지 않다.
    // 정정도 고지를 다시 채워야 하므로, 회차는 개시보다 NOTICE 이상 앞에서만
    // 고칠 수 있다. 동결 경계보다 강한 조건이고 그것이 의도다.
    now = OPENS - NOTICE;
    const early = await send({ to: claim, data: ci.encodeFunctionData('setRoot', [3n, t.root, OPENS]) });
    ok(!early.execResult.exceptionError, 'while the notice period still fits, the root can be corrected');

    now = OPENS - 1n;
    const tooLate = await send({ to: claim, data: ci.encodeFunctionData('setRoot', [3n, t.root, OPENS]) });
    eq(errName(ci, tooLate), 'NoticeTooShort',
      'one second before it opens the window has already closed — correcting needs a fresh notice');

    now = OPENS;                    // the exact boundary, never visited before
    const atBoundary = await send({ to: claim, data: ci.encodeFunctionData('setRoot', [3n, t.root, OPENS]) });
    eq(errName(ci, atBoundary), 'RoundAlreadyStarted', 'in the block it opens, setRoot already reverts');

    now = OPENS + 1n;
    const after = await send({ to: claim, data: ci.encodeFunctionData('setRoot', [3n, t.root, OPENS]) });
    eq(errName(ci, after), 'RoundAlreadyStarted', 'and afterwards');
  }
  console.log('\n3. a round opens AT startTime, not a second either side  (kills M02, M03)\n');
  {
    const OPENS = now + NOTICE + 1000n;
    const AMT = 2n * E;
    const t = twoLeaf(4n, { index: 0n, account: A(1), amount: AMT }, { index: 1n, account: A(2), amount: AMT });
    await send({ to: claim, data: ci.encodeFunctionData('setRoot', [4n, t.root, OPENS]) });

    now = OPENS - 1n;
    const early = await send({ to: claim, data: ci.encodeFunctionData('claim', [4n, 0n, A(1), AMT, t.proofs[0]]) });
    eq(errName(ci, early), 'RoundNotStarted', 'one second early it reverts by name');
    ok(!(await isClaimed(4n, 0n)), 'and leaves no bit behind');

    now = OPENS;
    const atBoundary = await send({ to: claim, data: ci.encodeFunctionData('claim', [4n, 0n, A(1), AMT, t.proofs[0]]) });
    ok(!atBoundary.execResult.exceptionError, 'at exactly startTime it is claimable');
  }

  // ---------------------------------------------------------- minClaimAmount
  console.log('\n4. the floor, at its own boundary and at the round boundary  (kills M05, M06, M13)\n');
  {
    // A fresh contract: the raise window shuts the moment the earliest round
    // is REGISTERED (audit 7, H-2), and rounds have been registered on `claim`
    // since case 1.
    const FLOOR = 5n * E;
    const c2 = await deployC('HCOWClaim', ci, [token.toString(), A(0), now + 400n * DAY, NOTICE, WINDOW]);
    await send({ to: token, data: ti.encodeFunctionData('transfer', [c2.toString(), 1000n * E]) });

    await send({ to: c2, data: ci.encodeFunctionData('setMinClaimAmount', [FLOOR]) });
    eq(await read(ci, c2, 'minClaimAmount'), FLOOR, 'with no round yet open, the floor can be raised');

    const OPENS = now + NOTICE + 50n;
    const t = twoLeaf(5n, { index: 0n, account: A(1), amount: FLOOR }, { index: 1n, account: A(2), amount: FLOOR - 1n });
    await send({ to: c2, data: ci.encodeFunctionData('setRoot', [5n, t.root, OPENS]) });

    // 이 자리에는 원래 정반대의 단언이 있었다:
    //   "one second before the round opens, a raise is still allowed"
    // 게이트가 개시 시점이었기 때문에 그게 사실이었고, 이 테스트는 그 동작을
    // 정상으로 못박고 있었다. 7차 감사가 그 간격에서 고지 0초로 확정된 리프를
    // 배제할 수 있음을 재현했고, 대표 결정으로 게이트를 등록 시점으로 옮겼다.
    // 테스트가 결함을 정답으로 고정하고 있던 사례라 그대로 남겨둘 수 없었다.
    now = OPENS - 1n;
    const shutAlready = await send({ to: c2, data: ci.encodeFunctionData('setMinClaimAmount', [FLOOR + 1n]) });
    eq(errName(ci, shutAlready), 'MinClaimAmountRaiseClosed',
      'one second before the round opens, the raise window is ALREADY shut — it shut at registration');

    now = OPENS;   // the exact boundary
    const atBoundary = await send({ to: c2, data: ci.encodeFunctionData('setMinClaimAmount', [FLOOR + 1n]) });
    eq(errName(ci, atBoundary), 'MinClaimAmountRaiseClosed', 'and it is still shut in the block it opens');

    const exact = await send({ to: c2, data: ci.encodeFunctionData('claim', [5n, 0n, A(1), FLOOR, t.proofs[0]]) });
    ok(!exact.execResult.exceptionError, 'an amount EQUAL to the floor is allowed, not refused');
    const under = await send({ to: c2, data: ci.encodeFunctionData('claim', [5n, 1n, A(2), FLOOR - 1n, t.proofs[1]]) });
    eq(errName(ci, under), 'BelowMinimum', 'one wei under the floor is refused by name');

    const same = await send({ to: c2, data: ci.encodeFunctionData('setMinClaimAmount', [FLOOR]) });
    ok(!same.execResult.exceptionError, 'setting the same value again is not a raise and is allowed');
    const down = await send({ to: c2, data: ci.encodeFunctionData('setMinClaimAmount', [0n]) });
    ok(!down.execResult.exceptionError, 'and down to zero is always allowed, even now');
  }

  // ------------------------------------------------------------ claimMany
  console.log('\n5. claimMany checks every array, and refuses an empty batch  (kills M15, M16)\n');
  {
    const AMT = 4n * E;
    const t = twoLeaf(6n, { index: 0n, account: A(1), amount: AMT }, { index: 1n, account: A(2), amount: AMT });
    await send({ to: claim, data: ci.encodeFunctionData('setRoot', [6n, t.root, now + NOTICE]) });
    now += NOTICE;

    const empty = await send({ to: claim, data: ci.encodeFunctionData('claimMany', [[], [], [], [], []]) });
    eq(errName(ci, empty), 'EmptyBatch', 'an empty batch is refused by name');

    // One short array at a time. Only `indexes` was ever exercised.
    const full = { r: [6n, 6n], i: [0n, 1n], a: [A(1), A(2)], m: [AMT, AMT], p: [t.proofs[0], t.proofs[1]] };
    const variants = [
      ['indexes', [full.r, [0n], full.a, full.m, full.p]],
      ['accounts', [full.r, full.i, [A(1)], full.m, full.p]],
      ['amounts', [full.r, full.i, full.a, [AMT], full.p]],
      ['merkleProofs', [full.r, full.i, full.a, full.m, [t.proofs[0]]]],
    ];
    for (const [name, args] of variants) {
      const r = await send({ to: claim, data: ci.encodeFunctionData('claimMany', args) });
      eq(errName(ci, r), 'LengthMismatch', `a short ${name} array is caught`);
    }
    const good = await send({ to: claim, data: ci.encodeFunctionData('claimMany', [full.r, full.i, full.a, full.m, full.p]) });
    ok(!good.execResult.exceptionError, 'and the matched batch goes through');
  }

  // -------------------------------------------------------- deadline / sweep
  console.log('\n6. the deadline, at the second it arrives  (kills M10, M14)\n');
  {
    now = DEADLINE - 1n;
    const early = await send({ to: claim, data: ci.encodeFunctionData('sweep', [A(5), 1n * E]) });
    eq(errName(ci, early), 'DeadlineNotReached', 'one second before the deadline, sweep reverts');

    const zero = await send({ to: claim, data: ci.encodeFunctionData('sweep', [A(5), 0n]) });
    eq(errName(ci, zero), 'ZeroAmount', 'a zero-amount sweep is refused by name, before the deadline check');

    now = DEADLINE;
    const before = await bal(A(5));
    const atBoundary = await send({ to: claim, data: ci.encodeFunctionData('sweep', [A(5), 1n * E]) });
    ok(!atBoundary.execResult.exceptionError, 'at exactly the deadline, sweep is allowed');
    eq(await bal(A(5)), before + 1n * E, 'and moves exactly what was asked for');
  }

  // ------------------------------------------------------------- constructor
  console.log('\n7. the constructor bounds, which nothing exercised  (kills M11, M12, M28)\n');
  {
    const t0 = now;
    const past = await send({ data: load('HCOWClaim').bytecode + ci.encodeDeploy([token.toString(), A(0), t0 - 1n, NOTICE, WINDOW]).slice(2) });
    eq(errName(ci, past), 'DeadlineInThePast', 'a deadline in the past is refused');

    // The comment in the spec-section-7 suite calls this case out and then
    // tests `now - 1` instead. `<=` versus `<` lives here.
    const equalNow = await send({ data: load('HCOWClaim').bytecode + ci.encodeDeploy([token.toString(), A(0), t0, NOTICE, WINDOW]).slice(2) });
    eq(errName(ci, equalNow), 'DeadlineInThePast', 'a deadline equal to now is refused too, so sweep can never open at birth');

    const horizon = await read(ci, claim, 'MAX_DEADLINE_HORIZON');
    const justIn = await send({ data: load('HCOWClaim').bytecode + ci.encodeDeploy([token.toString(), A(0), t0 + horizon, NOTICE, WINDOW]).slice(2) });
    ok(!justIn.execResult.exceptionError, 'exactly MAX_DEADLINE_HORIZON out is accepted');
    const justOut = await send({ data: load('HCOWClaim').bytecode + ci.encodeDeploy([token.toString(), A(0), t0 + horizon + 1n, NOTICE, WINDOW]).slice(2) });
    eq(errName(ci, justOut), 'DeadlineTooFar', 'one second past it is refused — the horizon is actually enforced');

    const noToken = await send({ data: load('HCOWClaim').bytecode + ci.encodeDeploy(['0x' + '00'.repeat(20), A(0), t0 + 100n, NOTICE, WINDOW]).slice(2) });
    eq(errName(ci, noToken), 'ZeroAddress', 'a zero token address is refused');
  }

  // --------------------------------------------------------- CEI / reentrancy
  console.log('\n8. checks-effects-interactions and the guard, together  (kills M20/M22 + M25 as a pair)\n');
  {
    // Neither defect is exploitable alone: the audit measured that removing
    // the ordering OR the guard still blocks re-entry, and removing both pays
    // twice. A test of either alone would therefore pass on a contract with
    // the other already broken. This exercises the pair, against a token that
    // actually re-enters.
    const rt = new Interface(load('ReentrantClaimToken').abi);
    const rtok = await deployC('ReentrantClaimToken', rt, []);
    const AMT = 100n * E;
    const rclaim = await deployC('HCOWClaim', ci, [rtok.toString(), A(0), now + 400n * DAY, NOTICE, WINDOW]);

    await send({ to: rtok, data: rt.encodeFunctionData('mint', [rclaim.toString(), AMT * 3n]) });
    const t = twoLeaf(7n, { index: 0n, account: A(1), amount: AMT }, { index: 1n, account: A(2), amount: AMT });
    await send({ to: rclaim, data: ci.encodeFunctionData('setRoot', [7n, t.root, now + NOTICE]) });
    now += NOTICE;

    const claimData = ci.encodeFunctionData('claim', [7n, 0n, A(1), AMT, t.proofs[0]]);
    await send({ to: rtok, data: rt.encodeFunctionData('arm', [rclaim.toString(), claimData]) });

    const before = await read(rt, rtok, 'balanceOf', [A(1)]);
    const outer = await send({ to: rclaim, data: claimData });
    ok(!outer.execResult.exceptionError, 'the outer claim succeeds');
    const after = await read(rt, rtok, 'balanceOf', [A(1)]);
    eq(await read(rt, rtok, 'reenterCount'), 1n, 'the token did attempt to re-enter claim() during the transfer');
    eq(await read(rt, rtok, 'reentrySucceeded'), false, 'and the re-entrant call was rejected');
    eq(after - before, AMT, 'so the entitlement was paid once, not twice');
  }

  console.log('\n9. the notice period  (audit 4, A-1 — the decision taken 2026-09-18)\n');
  {
    // Why this exists. setRoot is the owner's second route to the balance, and
    // it is not time-locked the way sweep() is: the owner can register an
    // unused roundId paying one address the whole balance and claim it in the
    // same block. That route cannot be removed -- a distributor whose operator
    // chooses the root cannot tell an honest recipient list from a dishonest
    // one, because both arrive as a setRoot.
    //
    // What a notice period buys is not prevention. It is that every root is a
    // public RoundSet event for N days before it can pay anyone, and -- the
    // reason it was actually chosen -- that a round can never open in the
    // block it was registered. A startTime already past used to freeze a wrong
    // root instantly, with no way to correct it. Now every setRoot mistake is
    // correctable.
    const NOTICE = 3n * DAY;
    const c3 = await deployC('HCOWClaim', ci, [token.toString(), A(0), now + 600n * DAY, NOTICE, WINDOW]);
    eq(await read(ci, c3, 'minRoundNotice'), NOTICE, 'the notice period is stored as given');

    const past = await send({ to: c3, data: ci.encodeFunctionData('setRoot', [1n, '0x' + '11'.repeat(32), now - 1n]) });
    eq(errName(ci, past), 'NoticeTooShort', 'a startTime in the past is refused outright now');

    const sameBlock = await send({ to: c3, data: ci.encodeFunctionData('setRoot', [1n, '0x' + '11'.repeat(32), now]) });
    eq(errName(ci, sameBlock), 'NoticeTooShort', 'and so is one that opens in this very block');

    const oneShort = await send({ to: c3, data: ci.encodeFunctionData('setRoot', [1n, '0x' + '11'.repeat(32), now + NOTICE - 1n]) });
    eq(errName(ci, oneShort), 'NoticeTooShort', 'one second short of the notice is refused');

    const exact = await send({ to: c3, data: ci.encodeFunctionData('setRoot', [1n, '0x' + '11'.repeat(32), now + NOTICE]) });
    ok(!exact.execResult.exceptionError, 'exactly the notice period ahead is accepted');

    // A correction is still allowed, and must also respect the notice.
    const fix = await send({ to: c3, data: ci.encodeFunctionData('setRoot', [1n, '0x' + '22'.repeat(32), now + NOTICE + 100n]) });
    ok(!fix.execResult.exceptionError, 'an unopened round can still be corrected');
    const fixShort = await send({ to: c3, data: ci.encodeFunctionData('setRoot', [1n, '0x' + '33'.repeat(32), now + 10n]) });
    eq(errName(ci, fixShort), 'NoticeTooShort', 'and the correction cannot smuggle in a short notice');

    // The drain that the audit reproduced, against a contract with notice.
    {
      const FUND = 1000n * E;
      await send({ to: token, data: ti.encodeFunctionData('transfer', [c3.toString(), FUND]) });
      const leaf = solidityPackedKeccak256(['uint256', 'uint256', 'address', 'uint256'], [99n, 0n, A(0), FUND]);
      const instant = await send({ to: c3, data: ci.encodeFunctionData('setRoot', [99n, leaf, now]) });
      eq(errName(ci, instant), 'NoticeTooShort', 'the same-block drain is no longer expressible');
      // It is still possible three days later, and that is the honest limit.
      await send({ to: c3, data: ci.encodeFunctionData('setRoot', [99n, leaf, now + NOTICE]) });
      const before = await bal(A(0));
      now += NOTICE;
      const later = await send({ to: c3, data: ci.encodeFunctionData('claim', [99n, 0n, A(0), FUND, []]) });
      ok(!later.execResult.exceptionError, 'after the notice it does go through — notice is disclosure, not prevention');
      eq(await bal(A(0)), before + FUND, 'and the full balance moves');
      now -= NOTICE;
    }

    // Constructor bounds on the notice itself.
    const bad = async (v) => errName(ci, await send({ data: load('HCOWClaim').bytecode + ci.encodeDeploy([token.toString(), A(0), now + 600n * DAY, v, WINDOW]).slice(2) }));
    eq(await bad(0n), 'NoticeOutOfRange', 'a zero notice is refused');
    eq(await bad(3599n), 'NoticeOutOfRange', 'under an hour is refused');
    eq(await bad(31n * DAY), 'NoticeOutOfRange', 'over thirty days is refused');
    const okLow = await send({ data: load('HCOWClaim').bytecode + ci.encodeDeploy([token.toString(), A(0), now + 600n * DAY, 3600n, WINDOW]).slice(2) });
    ok(!okLow.execResult.exceptionError, 'exactly one hour is accepted, for testnet rehearsal');
  }


  // ------------------------------------------------ the claim window (note 8)
  console.log('\n10. every round is claimable for minClaimWindow before sweep() opens  (design note 8)\n');
  {
    // Constructor bounds on the window itself.
    const W = 30n * DAY;
    const mk = (deadline, notice, window) =>
      send({ data: load('HCOWClaim').bytecode +
        ci.encodeDeploy([token.toString(), A(0), deadline, notice, window]).slice(2) });

    const far = now + 600n * DAY;
    eq(errName(ci, await mk(far, NOTICE, 0n)), 'WindowOutOfRange', 'a zero window is refused');
    eq(errName(ci, await mk(far, NOTICE, 3599n)), 'WindowOutOfRange', 'under an hour is refused');
    eq(errName(ci, await mk(far, NOTICE, 366n * DAY)), 'WindowOutOfRange', 'over 365 days is refused');
    ok(!(await mk(far, NOTICE, 3600n)).execResult.exceptionError, 'exactly one hour is accepted, for testnet rehearsal');
    ok(!(await mk(now + 800n * DAY, NOTICE, 365n * DAY)).execResult.exceptionError, 'exactly 365 days is accepted');

    // The deadline must leave room for one round. Without this check the
    // contract deploys into a state where every setRoot reverts: the earliest
    // startTime the notice allows is later than the latest the window allows.
    const exact = now + NOTICE + W;
    ok(!(await mk(exact, NOTICE, W)).execResult.exceptionError,
      'a deadline exactly notice+window out is accepted — the single usable instant');
    eq(errName(ci, await mk(exact - 1n, NOTICE, W)), 'DeadlineLeavesNoRoom',
      'one second less is refused rather than deployed unusable');

    // setRoot's boundary. latest = claimDeadline - minClaimWindow.
    const D = now + 200n * DAY;
    const c9 = await deployC('HCOWClaim', ci, [token.toString(), A(0), D, NOTICE, W]);
    const leaf = solidityPackedKeccak256(['uint256', 'uint256', 'address', 'uint256'], [7n, 0n, A(1), E]);
    const latest = D - W;

    const atLatest = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [7n, leaf, latest]) });
    ok(!atLatest.execResult.exceptionError, 'a round opening exactly minClaimWindow before the deadline is accepted');

    const overBy1 = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [8n, leaf, latest + 1n]) });
    eq(errName(ci, overBy1), 'ClaimWindowTooShort', 'one second later is refused  (kills >= vs > on the window check)');

    const afterDeadline = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [9n, leaf, D + 1n]) });
    eq(errName(ci, afterDeadline), 'ClaimWindowTooShort',
      'a round scheduled after the deadline is refused — sweep() can no longer open against an unopened round');

    // Order of checks. The freeze answer is more useful than the window answer
    // for a round that already opened, so it must still win.
    now += 1n;
    const openNow = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [10n, leaf, now + NOTICE]) });
    ok(!openNow.execResult.exceptionError, 'a normal round registers');
    now += NOTICE;
    const frozen = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [10n, leaf, D + 1n]) });
    eq(errName(ci, frozen), 'RoundAlreadyStarted', 'a frozen round still answers RoundAlreadyStarted, not ClaimWindowTooShort');

    // Monotonicity. claimDeadline only moves later, so extending can only widen
    // the margin — and a startTime refused before becomes available after.
    const wanted = D + 10n * DAY;
    eq(errName(ci, await send({ to: c9, data: ci.encodeFunctionData('setRoot', [11n, leaf, wanted]) })),
      'ClaimWindowTooShort', 'a startTime past the current deadline is refused');
    await send({ to: c9, data: ci.encodeFunctionData('extendDeadline', [wanted + W]) });
    const afterExtend = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [11n, leaf, wanted]) });
    ok(!afterExtend.execResult.exceptionError, 'after extendDeadline the same startTime is accepted');
    eq(await read(ci, c9, 'minClaimWindow', []), W, 'minClaimWindow is immutable and reads back');

    // The correction to design note 3. It used to say a round could be
    // registered with a startTime already past and claimed in the same block.
    // minRoundNotice ended that; this asserts the comment is now true.
    const inThePast = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [12n, leaf, now - 1n]) });
    eq(errName(ci, inThePast), 'NoticeTooShort', 'a startTime already in the past is refused, as note 3 now says');
    const rightNow = await send({ to: c9, data: ci.encodeFunctionData('setRoot', [13n, leaf, now]) });
    eq(errName(ci, rightNow), 'NoticeTooShort', 'and so is one that opens in this very block');
  }


  // -------------------------------------------- extendDeadline 의 상한 (7차 H-1)
  console.log('\n11. extendDeadline 에 상한이 있다  (7차 감사 H-1)\n');
  {
    // 7차 감사에서 재현한 공격: 상한이 없으면 owner 의 합법 호출 두 번으로
    // 등록·공개된 회차가 영구 청구 불가가 되고 sweep 도 같이 영구 봉쇄된다.
    //   extendDeadline(2^256-1)  →  setRoot(같은 회차, 2^256-1-window)
    // 그 뒤 owner 는 note 4 경로로 잔액 전부를 가져간다.
    const NOTICE2 = 3600n, W = 30n * DAY, D = now + 400n * DAY;
    const c11 = await deployC('HCOWClaim', ci, [token.toString(), A(0), D, NOTICE2, W]);
    const horizon = 3650n * DAY;

    const far = await send({ to: c11, data: ci.encodeFunctionData('extendDeadline', [(1n << 256n) - 1n]) });
    eq(errName(ci, far), 'DeadlineTooFar', '2^256-1 로의 연장은 거부된다  (kills 상한 삭제)');

    const overBy1 = await send({ to: c11, data: ci.encodeFunctionData('extendDeadline', [now + horizon + 1n]) });
    eq(errName(ci, overBy1), 'DeadlineTooFar', '지평선보다 1초 먼 연장도 거부된다  (kills > vs >=)');

    const atMax = await send({ to: c11, data: ci.encodeFunctionData('extendDeadline', [now + horizon]) });
    ok(!atMax.execResult.exceptionError, '정확히 지평선까지는 허용된다');
    eq(await read(ci, c11, 'claimDeadline', []), now + horizon, '그리고 실제로 반영된다');

    // 상한은 "한 번에 얼마나 멀리" 이지 "몇 번" 이 아니다. 시간이 지나면 다시 늘릴 수 있다.
    const before = now;
    now += 100n * DAY;
    const again = await send({ to: c11, data: ci.encodeFunctionData('extendDeadline', [now + horizon]) });
    ok(!again.execResult.exceptionError, '시간이 지나면 다시 지평선까지 늘릴 수 있다 — 연장 횟수는 제한하지 않는다');
    now = before;

    // 단축은 여전히 불가능하다. 공개 약속이다.
    const back = await send({ to: c11, data: ci.encodeFunctionData('extendDeadline', [now + DAY]) });
    eq(errName(ci, back), 'DeadlineNotExtended', '단축은 여전히 거부된다');

    // 그리고 7차 H-1 의 공격 자체가 성립하지 않는다.
    const c12 = await deployC('HCOWClaim', ci, [token.toString(), A(0), D, NOTICE2, W]);
    await send({ to: token, data: ti.encodeFunctionData('transfer', [c12.toString(), 200n * E]) });
    const t12 = twoLeaf(1n, { index: 0n, account: A(1), amount: 100n * E }, { index: 1n, account: A(2), amount: 100n * E });
    await send({ to: c12, data: ci.encodeFunctionData('setRoot', [1n, t12.root, now + 60n * DAY]) });
    const evil = await send({ to: c12, data: ci.encodeFunctionData('extendDeadline', [(1n << 255n)]) });
    eq(errName(ci, evil), 'DeadlineTooFar', '공격의 1단계가 막힌다');
    const push = await send({ to: c12, data: ci.encodeFunctionData('setRoot', [1n, t12.root, (1n << 255n) - W]) });
    eq(errName(ci, push), 'ClaimWindowTooShort', '그리고 2단계도 여전히 막혀 있다');
    now += 60n * DAY;
    const paid = await send({ to: c12, data: ci.encodeFunctionData('claim', [1n, 0n, A(1), 100n * E, t12.p ? t12.p[0] : t12.proofs[0]]) });
    ok(!paid.execResult.exceptionError, '예정대로 개시일에 A1 이 청구한다');
    now -= 60n * DAY;
  }


  // ------------------ 바닥값 인상은 첫 setRoot 에서 닫힌다 (7차 H-2, 대표 결정 (a))
  console.log('\n12. minClaimAmount 인상은 첫 회차가 등록되는 순간 닫힌다  (7차 H-2)\n');
  {
    // 이전 게이트는 "첫 회차가 열리는 순간" 이었다. 명단과 금액이 확정·공개되는
    // 시점은 등록(setRoot)이고 개시는 그보다 minRoundNotice 뒤다. 그 사이에
    // owner 는 고지 0초로 바닥값을 올려 이미 커밋된 리프를 배제할 수 있었다.
    // 같은 효과를 루트 재작성으로 내려면 고지가 강제되는데 이쪽만 아니었다.
    // 7차 감사에서 재현했고 대표 결정으로 게이트를 등록 시점으로 당겼다.
    const NOTICE3 = 30n * DAY, W3 = 3600n, D3 = now + 400n * DAY;
    const c12 = await deployC('HCOWClaim', ci, [token.toString(), A(0), D3, NOTICE3, W3]);
    await send({ to: token, data: ti.encodeFunctionData('transfer', [c12.toString(), 2000n * E]) });

    // 등록 전에는 자유롭게 올릴 수 있다. 그게 이 파라미터의 쓰임이다.
    const up1 = await send({ to: c12, data: ci.encodeFunctionData('setMinClaimAmount', [3n * E]) });
    ok(!up1.execResult.exceptionError, '회차가 하나도 등록되기 전에는 인상이 허용된다');
    eq(await read(ci, c12, 'minClaimAmount', []), 3n * E, '그리고 반영된다');

    const OPEN = now + NOTICE3;
    const t12 = twoLeaf(1n, { index: 0n, account: A(1), amount: 5n * E }, { index: 1n, account: A(2), amount: 900n * E });
    const reg = await send({ to: c12, data: ci.encodeFunctionData('setRoot', [1n, t12.root, OPEN]) });
    ok(!reg.execResult.exceptionError, '회차를 등록한다 — 이 순간 명단과 금액이 확정된다');

    // 여기가 바뀐 부분. 개시까지 30일이 남았지만 인상은 이미 닫혔다.
    const raise = await send({ to: c12, data: ci.encodeFunctionData('setMinClaimAmount', [100n * E]) });
    eq(errName(ci, raise), 'MinClaimAmountRaiseClosed',
      '등록 직후, 개시 30일 전인데도 인상이 거부된다  (kills 게이트를 개시 시점으로 되돌리기)');
    eq(await read(ci, c12, 'minClaimAmount', []), 3n * E, '그리고 값이 바뀌지 않았다');

    // 1 wei 인상도 인상이다.
    const tiny = await send({ to: c12, data: ci.encodeFunctionData('setMinClaimAmount', [3n * E + 1n]) });
    eq(errName(ci, tiny), 'MinClaimAmountRaiseClosed', '1 wei 인상도 거부된다  (kills > vs >=)');

    // 같은 값으로 다시 쓰는 것은 인상이 아니다. 거부하지 않는다.
    const same = await send({ to: c12, data: ci.encodeFunctionData('setMinClaimAmount', [3n * E]) });
    ok(!same.execResult.exceptionError, '같은 값 재설정은 인상이 아니므로 허용된다');

    // 인하는 언제나 열려 있다. 더 많은 사람이 받게 되는 방향이다.
    const down = await send({ to: c12, data: ci.encodeFunctionData('setMinClaimAmount', [E]) });
    ok(!down.execResult.exceptionError, '인하는 등록 뒤에도 허용된다');
    eq(await read(ci, c12, 'minClaimAmount', []), E, '그리고 반영된다');

    // 그래서 7차 H-2 의 공격이 성립하지 않는다.
    now = OPEN;
    const before12 = await bal(A(1));   // A(1) 은 앞선 절에서도 받았다. 증분으로 잰다.
    const paid = await send({ to: c12, data: ci.encodeFunctionData('claim', [1n, 0n, A(1), 5n * E, t12.proofs[0]]) });
    ok(!paid.execResult.exceptionError, '약속된 5 HCOW 수취인이 개시일에 실제로 받는다');
    eq(await bal(A(1)) - before12, 5n * E, '그리고 잔고가 정확히 5 HCOW 늘었다');

    // 개시 뒤에도 인하는 계속 열려 있다. 기한이 지난 뒤에도 그렇다.
    const down2 = await send({ to: c12, data: ci.encodeFunctionData('setMinClaimAmount', [0n]) });
    ok(!down2.execResult.exceptionError, '개시 뒤에도 인하는 허용된다');
    now = D3 + DAY;
    const down3 = await send({ to: c12, data: ci.encodeFunctionData('setMinClaimAmount', [0n]) });
    ok(!down3.execResult.exceptionError, '기한이 지난 뒤에도 인하는 허용된다');
    now = 1900000000n;
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
