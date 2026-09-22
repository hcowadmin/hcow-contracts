/* HCOWClaim — the sixteen tests of spec v0.1 section 7, in order.
 *
 * Same in-process EVM harness as test.cjs and audit.cjs: no network, no
 * hardhat, artifacts straight off disk. Time is the `now` variable, and the
 * tests run in chronological order because the contract's whole shape is
 * "what is allowed before and after which instant".
 *
 * The trees under test are built by scripts/build-merkle.cjs rather than by a
 * fixture written here. A distributor tested against proofs from a generator
 * that is not the generator used in production has tested nothing about
 * production.
 */
const fs = require('fs');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, privateToAddress } = require('@ethereumjs/util');
const { Interface, getAddress } = require('ethers');
const { buildDistribution } = require('../scripts/build-merkle.cjs');

const E18 = 10n ** 18n;
const DAY = 86400n, MONTH = 30n * DAY;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const eq = (a, b, m) => ok(a === b, a === b ? m : `${m}   got ${a} want ${b}`);

const load = (n) => JSON.parse(fs.readFileSync(`artifacts/${n}.json`, 'utf8'));
const keys = Array.from({ length: 6 }, (_, i) => '0x' + (i + 17).toString(16).padStart(2, '0').repeat(32));
const acc = keys.map((k) => new Address(privateToAddress(hexToBytes(k))));
const A = (i) => getAddress(acc[i].toString());

let vm, common, now = 1900000000n;

const mkBlock = () => Block.fromBlockData(
  { header: { timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n, number: 1n } },
  { common, skipConsensusFormatValidation: true },
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
  call(to, iface.encodeFunctionData(fn, args)).then((r) => iface.decodeFunctionResult(fn, r)[0]);

/**
 * The custom error a reverted call returned, by name.
 *
 * Asserting only that something reverted is how a guard passes its own test
 * for the wrong reason: several guards stand on the claim path and "it
 * reverted" is satisfied by any of them, so deleting the one under test leaves
 * the assertion green. Name the error.
 */
function errorName(iface, r) {
  const data = bytesToHex(r.execResult.returnValue || new Uint8Array());
  if (!data || data.length < 10) return '';
  try { return iface.parseError(data)?.name ?? ''; } catch (_) { return ''; }
}

/** Decoded events from a transaction, in order. */
function events(iface, r) {
  const raw = r.execResult?.logs || [];
  const out = [];
  for (const [, topics, data] of raw) {
    try {
      const p = iface.parseLog({ topics: topics.map(bytesToHex), data: bytesToHex(data) });
      if (p) out.push(p);
    } catch (_) { /* a log from another contract */ }
  }
  return out;
}
const evt = (iface, r, name) => events(iface, r).find((e) => e.name === name);

async function deploy(name, iface, args) {
  const art = load(name);
  const r = await send({ data: art.bytecode + (args.length ? iface.encodeDeploy(args).slice(2) : '') });
  if (r.execResult.exceptionError) throw new Error(name + ' deploy failed: ' + r.execResult.exceptionError.error);
  return r.createdAddress;
}

// ----------------------------------------------------------------- fixture

const TGE = Number(now + 10n * DAY);
// 4차 감사 A-1 의 고지 기간. 이 스위트의 회차는 전부 TGE 이후에 열리고
// 등록은 그보다 열흘 앞이라 하한(1시간)이면 충분하다.
const NOTICE = 3600n;
const WINDOW = 3600n;

/**
 * Deliberately not the published ratios. Those are not final (spec section 3
 * says so twice) and a test that asserts them turns a policy change into a red
 * suite. What is asserted here is the shape: several rounds, a remainder that
 * does not divide evenly, and one category that pays out entirely at TGE.
 */
const POLICY = {
  monthSeconds: 2592000,
  tgeTime: TGE,
  dustThreshold: '0',
  categories: {
    miniapp: { tgeBps: 3300, tailRounds: 2 },
    taskon: { tgeBps: 2000, tailRounds: 4 },
    other: { tgeBps: 10000, tailRounds: 0 },
  },
  bucket: { label: 'Community / Airdrop', total: (8_000_000n * E18).toString(), tgeBps: 3750, cliffMonths: 0, linearMonths: 6 },
};

const filler = (n) => getAddress('0x' + (0xc0de00 + n).toString(16).padStart(40, '0'));

async function main() {
  common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
  vm = await VM.create({ common });
  for (const a of acc) await vm.stateManager.modifyAccountFields(a, { balance: 10n ** 22n });

  const tokenAbi = new Interface(load('HCOWToken').abi);
  const claimAbi = new Interface(load('HCOWClaim').abi);

  // ---- the distribution, built by the production generator ---------------
  const ZERO_ROW = filler(99);
  const rows = [
    { line: 1, account: A(2), category: 'miniapp', totalAmount: (1_000n * E18).toString() },
    { line: 2, account: A(3), category: 'taskon', totalAmount: (500n * E18).toString() },
    { line: 3, account: A(4), category: 'other', totalAmount: (250n * E18).toString() },
    { line: 4, account: ZERO_ROW, category: 'other', totalAmount: '0' },
    ...Array.from({ length: 9 }, (_, i) => ({
      line: 5 + i,
      account: filler(i),
      category: ['miniapp', 'taskon', 'other'][i % 3],
      // 7 wei on the end so nothing divides evenly and the last round carries
      // a remainder in every category that has one
      totalAmount: (BigInt(i + 1) * 111n * E18 + 7n).toString(),
    })),
  ];
  const dist = buildDistribution(rows, POLICY, { tgeTime: TGE });
  const R = dist.rounds;
  const proofFor = (roundId, account) => {
    const c = R[roundId]?.claims[getAddress(account)];
    if (!c) throw new Error(`no entry for ${account} in round ${roundId}`);
    return c;
  };
  const claimCall = (roundId, account, over = {}) => {
    const c = proofFor(roundId, account);
    return claimAbi.encodeFunctionData('claim', [
      over.roundId ?? roundId, over.index ?? c.index, over.account ?? account,
      over.amount ?? c.amount, over.proof ?? c.proof,
    ]);
  };

  console.log('\nfixture');
  eq(R.filter(Boolean).length, 5, 'the generator produced five rounds from the test policy');
  eq(dist.dropped.length, 1, 'and dropped the one row whose total was zero');

  // ---- deployment --------------------------------------------------------
  const treasury = acc[1];
  const token = await deploy('HCOWToken', tokenAbi, [treasury.toString()]);
  const DEADLINE = BigInt(TGE) + 180n * DAY;
  const FLOOR = 100n * E18;
  const claim = await deploy('HCOWClaim', claimAbi, [token.toString(), treasury.toString(), DEADLINE, NOTICE, WINDOW]);

  const fund = (amount, to = claim) =>
    send({ from: 1, to: token, data: tokenAbi.encodeFunctionData('transfer', [String(to), amount]) });
  const bal = (who) => read(tokenAbi, token, 'balanceOf', [String(who)]);

  await fund(20_000n * E18);
  eq(await read(claimAbi, claim, 'owner'), A(1), 'the treasury Safe owns the contract, not the deployer');
  eq(await read(claimAbi, claim, 'claimDeadline'), DEADLINE, 'claimDeadline is what was passed at deployment');
  eq(await read(claimAbi, claim, 'minClaimAmount'), 0n, 'minClaimAmount starts at zero, meaning no floor (spec 4-3)');

  let floored;   // 17 에서 만들어 18/19 가 쓴다 (7차 H-2 조치)
  const setRoot = (roundId, from = 1, over = {}) => send({
    from, to: claim,
    data: claimAbi.encodeFunctionData('setRoot', [
      roundId, over.root ?? R[roundId].merkleRoot, over.startTime ?? R[roundId].startTime,
    ]),
  });
  for (const r of R.filter(Boolean)) {
    const rc = await setRoot(r.roundId);
    if (rc.execResult.exceptionError) throw new Error(`setRoot ${r.roundId} failed`);
  }
  console.log(`  registered ${R.filter(Boolean).length} rounds, first opens in 10 days`);

  // =================================================================
  // Before TGE. Nothing is claimable and nothing is sweepable.
  // =================================================================
  console.log('\nbefore the first round opens');

  { // 6  개시 시각 전 청구 → revert
    const r = await send({ from: 0, to: claim, data: claimCall(0, A(2)) });
    eq(errorName(claimAbi, r), 'RoundNotStarted', '6  a claim before the round opens reverts with RoundNotStarted');
    eq(await read(claimAbi, claim, 'isClaimed', [0, proofFor(0, A(2)).index]), false,
       '6  and the entry is still unclaimed');
  }

  { // 8  개시 전 회차의 루트 변경 → 성공 + 이벤트
    const newRoot = '0x' + 'ab'.repeat(32);
    const r = await setRoot(0, 1, { root: newRoot });
    ok(!r.execResult.exceptionError, '8  the root of a round that has not opened can still be corrected');
    const e = evt(claimAbi, r, 'RoundSet');
    ok(!!e, '8  and the correction emits RoundSet');
    if (e) {
      eq(e.args[0], 0n, '8  RoundSet names the round');
      eq(e.args[1].toLowerCase(), newRoot, '8  RoundSet carries the new root, so a rewrite cannot happen quietly');
    }
    const stored = await call(claim, claimAbi.encodeFunctionData('rounds', [0]));
    eq(claimAbi.decodeFunctionResult('rounds', stored)[0].toLowerCase(), newRoot, '8  and the new root is what is stored');
    await setRoot(0); // put the real root back
  }

  { // 15  owner 아닌 주소의 setRoot / sweep → revert
    const r1 = await setRoot(1, 0, { root: '0x' + 'cd'.repeat(32) });
    eq(errorName(claimAbi, r1), 'OwnableUnauthorizedAccount', '15 setRoot from a non-owner reverts');
    const r2 = await send({ from: 0, to: claim, data: claimAbi.encodeFunctionData('sweep', [acc[0].toString(), 1n]) });
    eq(errorName(claimAbi, r2), 'OwnableUnauthorizedAccount', '15 sweep from a non-owner reverts');
    const r3 = await send({ from: 0, to: claim, data: claimAbi.encodeFunctionData('extendDeadline', [DEADLINE + 1n]) });
    eq(errorName(claimAbi, r3), 'OwnableUnauthorizedAccount', '15 extendDeadline from a non-owner reverts too');
    const stored = await call(claim, claimAbi.encodeFunctionData('rounds', [1]));
    eq(claimAbi.decodeFunctionResult('rounds', stored)[0].toLowerCase(), R[1].merkleRoot.toLowerCase(),
       '15 and round 1 still holds the root the owner set');
  }

  { // 11  claimDeadline 전 sweep → revert
    const r = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('sweep', [treasury.toString(), 1n * E18]) });
    eq(errorName(claimAbi, r), 'DeadlineNotReached', '11 sweep before claimDeadline reverts with DeadlineNotReached');
    eq(await bal(claim), 20_000n * E18, '11 and not one wei left the contract');
  }

  { // 13  deadline 단축 시도 → revert
    const shorter = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('extendDeadline', [DEADLINE - 1n]) });
    eq(errorName(claimAbi, shorter), 'DeadlineNotExtended', '13 shortening the deadline reverts with DeadlineNotExtended');
    const same = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('extendDeadline', [DEADLINE]) });
    eq(errorName(claimAbi, same), 'DeadlineNotExtended', '13 and so does setting it to the value it already has');
    eq(await read(claimAbi, claim, 'claimDeadline'), DEADLINE, '13 the deadline is unchanged');
  }

  { // 14  deadline 연장 → 성공 + 이벤트
    const extended = DEADLINE + 30n * DAY;
    const r = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('extendDeadline', [extended]) });
    ok(!r.execResult.exceptionError, '14 the deadline extends');
    const e = evt(claimAbi, r, 'DeadlineExtended');
    ok(!!e, '14 and emits DeadlineExtended');
    if (e) {
      eq(e.args[0], DEADLINE, '14 the event carries the old deadline');
      eq(e.args[1], extended, '14 and the new one');
    }
    eq(await read(claimAbi, claim, 'claimDeadline'), extended, '14 the stored deadline moved later');
  }

  { // 17  minClaimAmount 인상 창은 첫 회차 "등록" 에서 닫힌다
    //
    // 사양 v0.1 은 "첫 회차가 개시되기 전" 이라고 적었고 이 테스트도 그 문장을
    // 따라 "the floor can be raised while no round has opened" 를 단언했다.
    // 7차 감사(2026-09-22)가 그 간격의 비용을 재현했다: 명단과 금액은 setRoot
    // 에서 확정·공개되고 개시는 minRoundNotice 뒤다. 그 사이에 owner 는 고지
    // 0초로 바닥값을 올려 이미 커밋된 리프를 배제할 수 있었고, 같은 효과를
    // 루트 재작성으로 내려면 고지가 강제됐다. 대표 결정으로 게이트를 등록
    // 시점으로 옮겼고, 이 절은 그 새 규칙을 잰다.
    eq(await read(claimAbi, claim, 'earliestRoundStart'), BigInt(R[0].startTime),
       '17 earliestRoundStart is the first registered round, not the last');

    // 이 스위트는 여기 오기 전에 이미 회차를 등록했다. 그러므로 인상은 닫혀 있다.
    const tooLate = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR]) });
    eq(errorName(claimAbi, tooLate), 'MinClaimAmountRaiseClosed',
       '17 rounds are registered, so the raise window is already shut — before any of them opens');
    eq(await read(claimAbi, claim, 'minClaimAmount'), 0n, '17 and the floor did not move');

    // 인상이 실제로 가능한 창은 등록 전이다. 새 컨트랙트로 그것을 잰다.
    const fresh = await deploy('HCOWClaim', claimAbi,
      [token.toString(), treasury.toString(), DEADLINE, NOTICE, WINDOW]);

    // 18/19 가 쓸 컨트랙트도 여기서 만든다. 바닥값을 등록 전에 세우고 회차를
    // 등록해야 하는데, 두 가지 다 회차가 열리기 전에만 가능하기 때문이다.
    // 리프는 컨트랙트 주소를 포함하지 않으므로 같은 트리와 증명을 그대로 쓴다.
    floored = await deploy('HCOWClaim', claimAbi,
      [token.toString(), treasury.toString(), DEADLINE, NOTICE, WINDOW]);
    await send({ from: 1, to: token, data: tokenAbi.encodeFunctionData('transfer', [floored.toString(), 1000000n * E18]) });
    const setFloor = await send({ from: 1, to: floored, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR]) });
    ok(!setFloor.execResult.exceptionError, '17 a floor can be set on it before any round is registered');
    const regF = await send({ from: 1, to: floored, data: claimAbi.encodeFunctionData('setRoot',
      [0, R[0].merkleRoot, R[0].startTime]) });
    ok(!regF.execResult.exceptionError, '17 and round 0 registers against it, with the floor already standing');
    const r = await send({ from: 1, to: fresh, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR]) });
    ok(!r.execResult.exceptionError, '17 on a contract with no round registered, the floor can be raised');
    const e = evt(claimAbi, r, 'MinClaimAmountSet');
    ok(!!e, '17 and the change emits MinClaimAmountSet');
    if (e) {
      eq(e.args[0], 0n, '17 the event carries the old floor');
      eq(e.args[1], FLOOR, '17 and the new one');
    }
    eq(await read(claimAbi, fresh, 'minClaimAmount'), FLOOR, '17 the stored floor moved up');
    const notOwner = await send({ from: 0, to: fresh, data: claimAbi.encodeFunctionData('setMinClaimAmount', [1n]) });
    eq(errorName(claimAbi, notOwner), 'OwnableUnauthorizedAccount', '17 and only the owner may set it at all');
  }

  // =================================================================
  // Round 0 is open.
  // =================================================================
  now = BigInt(TGE) + 1n;
  console.log('\nround 0 open');

  { // 18  회차 개시 후 인상 → revert,  19  개시 후 인하 → 성공
    //
    // A floor raised over a live distribution excludes the smallest
    // recipients, which is what shortening the deadline would do by another
    // route. So after the first round opens the floor moves one way.
    const small = filler(0);
    const c = proofFor(0, small);
    ok(BigInt(c.amount) < FLOOR, '18 there is a recipient whose round 0 entry sits under the floor');

    // 7차 조치 이후 주 컨트랙트의 바닥값은 0 이고 다시 올릴 수 없다 — 회차가
    // 이미 등록돼 있기 때문이다. 그래서 "바닥값이 서 있는 동안" 과 "개시 뒤
    // 인하" 는 바닥값을 등록 전에 세워 둔 별도 컨트랙트에서 잰다. 리프는
    // 컨트랙트 주소를 포함하지 않으므로 같은 트리와 같은 증명을 그대로 쓴다.
    const blocked = await send({ from: 0, to: floored, data: claimCall(0, small) });
    eq(errorName(claimAbi, blocked), 'BelowMinimum',
       '18 and while that floor stands, the under-floor claim reverts with BelowMinimum');
    const upF = await send({ from: 1, to: floored, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR + 1n]) });
    eq(errorName(claimAbi, upF), 'MinClaimAmountRaiseClosed', '18 raising it there is refused too');

    const downF = await send({ from: 1, to: floored, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR / 2n]) });
    ok(!downF.execResult.exceptionError, '19 lowering it after the round opened succeeds');
    const eF = evt(claimAbi, downF, 'MinClaimAmountSet');
    ok(!!eF, '19 and emits MinClaimAmountSet');
    if (eF) {
      eq(eF.args[0], FLOOR, '19 the event carries the old floor');
      eq(eF.args[1], FLOOR / 2n, '19 and the lower one');
    }
    eq(await read(claimAbi, floored, 'minClaimAmount'), FLOOR / 2n, '19 the stored floor moved down');
    const backF = await send({ from: 1, to: floored, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR]) });
    eq(errorName(claimAbi, backF), 'MinClaimAmountRaiseClosed',
       '19 and it cannot be put back: down is the only direction that remains');
    await send({ from: 1, to: floored, data: claimAbi.encodeFunctionData('setMinClaimAmount', [0n]) });
    const paidF = await send({ from: 0, to: floored, data: claimCall(0, small) });
    ok(!paidF.execResult.exceptionError, '19 and with the floor gone the blocked claim goes through');
    eq(await bal(small), BigInt(c.amount), '19 paying the full entry');

    const up = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR + 1n]) });
    eq(errorName(claimAbi, up), 'MinClaimAmountRaiseClosed',
       '18 raising the floor after a round has opened reverts with MinClaimAmountRaiseClosed');
    const wayUp = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('setMinClaimAmount', [FLOOR * 100n]) });
    eq(errorName(claimAbi, wayUp), 'MinClaimAmountRaiseClosed', '18 by one wei or by a hundredfold, the same');
    eq(await read(claimAbi, claim, 'minClaimAmount'), 0n, '18 the floor is unchanged');

    // 주 컨트랙트는 바닥값이 0 이고 올릴 수 없다. 인하(0 으로) 는 여전히 통과한다.
    const toZero = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('setMinClaimAmount', [0n]) });
    ok(!toZero.execResult.exceptionError, '19 on the main contract, setting zero over zero is not a raise');
    eq(await read(claimAbi, claim, 'minClaimAmount'), 0n, '19 which is where the rest of this suite needs it');

    const paid = await send({ from: 0, to: claim, data: claimCall(0, small) });
    ok(!paid.execResult.exceptionError, '19 and the same entry claims cleanly against the main contract');
  }

  { // 7  이미 개시된 회차의 루트 변경 → revert
    const r = await setRoot(0, 1, { root: '0x' + 'ef'.repeat(32) });
    eq(errorName(claimAbi, r), 'RoundAlreadyStarted', '7  the root of an open round cannot be changed');
    const same = await setRoot(0);
    eq(errorName(claimAbi, same), 'RoundAlreadyStarted', '7  not even to the value it already holds');
    const stored = await call(claim, claimAbi.encodeFunctionData('rounds', [0]));
    eq(claimAbi.decodeFunctionResult('rounds', stored)[0].toLowerCase(), R[0].merkleRoot.toLowerCase(),
       '7  and the round still holds the root it opened with');
  }

  { // 3  잘못된 proof → revert
    const c = proofFor(0, A(2));
    const forged = [...c.proof.slice(0, -1), '0x' + '11'.repeat(32)];
    const r = await send({ from: 0, to: claim, data: claimCall(0, A(2), { proof: forged }) });
    eq(errorName(claimAbi, r), 'InvalidProof', '3  a forged proof reverts with InvalidProof');
    const empty = await send({ from: 0, to: claim, data: claimCall(0, A(2), { proof: [] }) });
    eq(errorName(claimAbi, empty), 'InvalidProof', '3  and so does an empty one');
  }

  { // 4  올바른 proof에 다른 금액 → revert
    const c = proofFor(0, A(2));
    const more = await send({ from: 0, to: claim, data: claimCall(0, A(2), { amount: BigInt(c.amount) + 1n }) });
    eq(errorName(claimAbi, more), 'InvalidProof', '4  a real proof with the amount raised by one wei reverts');
    const less = await send({ from: 0, to: claim, data: claimCall(0, A(2), { amount: BigInt(c.amount) - 1n }) });
    eq(errorName(claimAbi, less), 'InvalidProof', '4  and lowering it does not help either');
  }

  { // 5  다른 계정의 proof로 청구 → revert
    const victim = proofFor(0, A(2));
    const r = await send({ from: 3, to: claim, data: claimAbi.encodeFunctionData('claim', [
      0, victim.index, A(3), victim.amount, victim.proof]) });
    eq(errorName(claimAbi, r), 'InvalidProof', "5  claiming someone else's entry against your own address reverts");
    // and the other direction: the thief's own index, the victim's address
    const thief = proofFor(0, A(3));
    const r2 = await send({ from: 3, to: claim, data: claimAbi.encodeFunctionData('claim', [
      0, thief.index, A(3), victim.amount, victim.proof]) });
    eq(errorName(claimAbi, r2), 'InvalidProof', '5  and so does mixing an index from one entry with a proof from another');
  }

  { // 10  amount 0 항목 → 트리에 없어야 함
    const inAnyRound = R.filter(Boolean).some((r) => r.claims[ZERO_ROW] !== undefined);
    ok(!inAnyRound, '10 the zero-amount row appears in no round of the generated tree');
    ok(R.filter(Boolean).every((r) => Object.values(r.claims).every((c) => BigInt(c.amount) > 0n)),
       '10 and no leaf anywhere carries a zero amount');
    // there is no proof to forge with, so the on-chain half of this is that an
    // invented entry for that address cannot be claimed
    // An index no entry in this round uses, so the already-claimed guard
    // cannot answer this call before the proof check does.
    const r = await send({ from: 0, to: claim, data: claimAbi.encodeFunctionData('claim', [
      0, 999, ZERO_ROW, 1n, proofFor(0, A(2)).proof]) });
    eq(errorName(claimAbi, r), 'InvalidProof', '10 and an invented entry for it does not verify against the root');
    const zeroAmt = await send({ from: 0, to: claim, data: claimCall(0, A(2), { amount: 0n }) });
    eq(errorName(claimAbi, zeroAmt), 'ZeroAmount', '10 a claim for zero is refused before the proof is even checked');
  }

  { // 9  잔액 부족 상태에서 청구 → revert, claimed가 남지 않을 것
    //
    // The most important test in the spec. A distributor that writes the
    // bitmap bit and then fails to transfer has burned that account's
    // entitlement permanently, and the failure is silent.
    const poor = await deploy('HCOWClaim', claimAbi, [token.toString(), treasury.toString(), DEADLINE, NOTICE, WINDOW]);
    // 4차 감사 A-1 이후 회차는 고지 기간만큼 앞서 등록해야 하므로, 이 사본에서는
    // 지금으로부터 NOTICE 뒤에 여는 회차를 쓰고 시계를 그만큼 넘긴다.
    // 본 스위트의 R[0] 은 TGE 에 열렸고 지금은 그보다 뒤다.
    const poorOpens = now + NOTICE;
    await send({ from: 1, to: poor, data: claimAbi.encodeFunctionData('setRoot', [0, R[0].merkleRoot, poorOpens]) });
    const savedNow = now;
    now = poorOpens;
    const c = proofFor(0, A(2));
    await fund(BigInt(c.amount) - 1n, poor); // one wei short of the claim

    const r = await send({ from: 0, to: poor, data: claimCall(0, A(2)) });
    eq(errorName(claimAbi, r), 'InsufficientBalance', '9  a claim the contract cannot pay reverts with InsufficientBalance');
    eq(await read(claimAbi, poor, 'isClaimed', [0, c.index]), false,
       '9  and the entry is NOT marked claimed, which is the whole point');
    eq(await bal(A(2)), 0n, '9  the account received nothing');

    await fund(1n, poor); // the vesting release arrives
    const r2 = await send({ from: 0, to: poor, data: claimCall(0, A(2)) });
    ok(!r2.execResult.exceptionError, '9  once the tokens arrive the same claim succeeds');
    eq(await bal(A(2)), BigInt(c.amount), '9  and pays the full amount, so nothing was lost by the failed attempt');
    eq(await read(claimAbi, poor, 'isClaimed', [0, c.index]), true, '9  now it is marked claimed');
    now = savedNow;
    // send the proceeds somewhere harmless so later balance assertions stay clean
    await send({ from: 2, to: token, data: tokenAbi.encodeFunctionData('transfer', [acc[5].toString(), BigInt(c.amount)]) });
  }

  { // 1  같은 회차 두 번 청구 → revert
    const c = proofFor(0, A(2));
    const first = await send({ from: 0, to: claim, data: claimCall(0, A(2)) });
    ok(!first.execResult.exceptionError, '1  the first claim of a round succeeds');
    const e = evt(claimAbi, first, 'Claimed');
    ok(!!e, '1  and emits Claimed');
    if (e) {
      eq(e.args[0], 0n, '1  Claimed names the round');
      eq(e.args[2], A(2), '1  and the account');
      eq(e.args[3], BigInt(c.amount), '1  and the amount');
    }
    eq(await bal(A(2)), BigInt(c.amount), '1  the tokens arrived');
    eq(await read(claimAbi, claim, 'isClaimed', [0, c.index]), true, '1  the entry is marked claimed');

    const second = await send({ from: 0, to: claim, data: claimCall(0, A(2)) });
    eq(errorName(claimAbi, second), 'AlreadyClaimed', '1  the second claim of the same round reverts with AlreadyClaimed');
    eq(await bal(A(2)), BigInt(c.amount), '1  and paid nothing further');
  }

  // =================================================================
  // Round 1 opens a 30-day month later.
  // =================================================================
  now = BigInt(TGE) + MONTH + 1n;
  console.log('\nround 1 open');

  { // 2  1회차 청구 후 2회차 청구 → 성공, 회차 간 간섭 없을 것
    const c0 = proofFor(0, A(2)), c1 = proofFor(1, A(2));
    eq(await read(claimAbi, claim, 'isClaimed', [0, c0.index]), true, '2  round 0 is claimed for this account');
    eq(await read(claimAbi, claim, 'isClaimed', [1, c1.index]), false, '2  round 1 is not, even at the same index');

    const before = await bal(A(2));
    const r = await send({ from: 0, to: claim, data: claimCall(1, A(2)) });
    ok(!r.execResult.exceptionError, '2  claiming round 1 after round 0 succeeds');
    eq(await bal(A(2)), before + BigInt(c1.amount), '2  and pays round 1 exactly, on top of round 0');
    eq(await read(claimAbi, claim, 'isClaimed', [0, c0.index]), true, '2  round 0 is untouched');
    const again = await send({ from: 0, to: claim, data: claimCall(0, A(2)) });
    eq(errorName(claimAbi, again), 'AlreadyClaimed', '2  and still closed, so the rounds do not share a bitmap');
  }

  // =================================================================
  // Round 2 opens. An account that has let three rounds pile up.
  // =================================================================
  now = BigInt(TGE) + 2n * MONTH + 1n;
  console.log('\nrounds 0-2 open');

  { // 16  claimMany로 밀린 3개 회차 일괄 청구 → 성공, 합계 정확
    const who = A(3);
    const cs = [0, 1, 2].map((i) => ({ roundId: i, ...proofFor(i, who) }));
    const expected = cs.reduce((a, c) => a + BigInt(c.amount), 0n);
    ok(expected > 0n, '16 the account really does have three rounds outstanding');
    eq(await bal(who), 0n, '16 and has claimed none of them');

    const r = await send({ from: 3, to: claim, data: claimAbi.encodeFunctionData('claimMany', [
      cs.map((c) => c.roundId), cs.map((c) => c.index), cs.map(() => who),
      cs.map((c) => c.amount), cs.map((c) => c.proof)]) });
    ok(!r.execResult.exceptionError, '16 claimMany over three rounds succeeds');
    eq(await bal(who), expected, '16 and pays exactly the sum of the three rounds');
    eq(events(claimAbi, r).filter((e) => e.name === 'Claimed').length, 3, '16 with one Claimed event per round');
    for (const c of cs) {
      eq(await read(claimAbi, claim, 'isClaimed', [c.roundId, c.index]), true, `16 round ${c.roundId} is marked claimed`);
    }
    const again = await send({ from: 3, to: claim, data: claimAbi.encodeFunctionData('claimMany', [
      cs.map((c) => c.roundId), cs.map((c) => c.index), cs.map(() => who),
      cs.map((c) => c.amount), cs.map((c) => c.proof)]) });
    eq(errorName(claimAbi, again), 'AlreadyClaimed', '16 and running the same batch twice reverts');

    const mismatch = await send({ from: 3, to: claim, data: claimAbi.encodeFunctionData('claimMany', [
      [0, 1], [0], [who, who], ['1', '1'], [[], []]] ) });
    eq(errorName(claimAbi, mismatch), 'LengthMismatch', '16 mismatched array lengths revert rather than reading past the end');
  }

  // =================================================================
  // After the extended deadline.
  // =================================================================
  now = BigInt(TGE) + 211n * DAY;
  console.log('\nafter the claim deadline');

  { // 12  claimDeadline 후 sweep → 성공 + 이벤트
    const held = await bal(claim);
    ok(held > 0n, '12 there is an unclaimed balance to recover');
    const dest = acc[5].toString();
    const before = await bal(dest);

    const r = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('sweep', [dest, held]) });
    ok(!r.execResult.exceptionError, '12 sweep after the deadline succeeds');
    const e = evt(claimAbi, r, 'Swept');
    ok(!!e, '12 and emits Swept');
    if (e) {
      eq(e.args[0], getAddress(dest), '12 the event names the destination');
      eq(e.args[1], held, '12 and the amount');
    }
    eq(await bal(claim), 0n, '12 the contract is empty');
    eq(await bal(dest), before + held, '12 and the recipient holds exactly what it held');

    const zero = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('sweep', ['0x' + '00'.repeat(20), 1n]) });
    eq(errorName(claimAbi, zero), 'ZeroAddress', '12 sweeping to the zero address is refused');
  }

  // ------------------------------------------------- beyond the sixteen
  console.log('\nproperties the sixteen imply');

  eq(await read(claimAbi, claim, 'MAX_DEADLINE_HORIZON'), 3650n * DAY,
     'the deadline horizon is a deploy-time bound only');
  {
    // With no round registered there is nothing to open, so the floor is still
    // free to move in both directions.
    const fresh = await deploy('HCOWClaim', claimAbi, [token.toString(), treasury.toString(), now + 90n * DAY, NOTICE, WINDOW]);
    eq(await read(claimAbi, fresh, 'earliestRoundStart'), (1n << 256n) - 1n,
       'a contract with no rounds reports no earliest start at all');
    const r = await send({ from: 1, to: fresh, data: claimAbi.encodeFunctionData('setMinClaimAmount', [7n * E18]) });
    ok(!r.execResult.exceptionError, 'and its floor can still be raised');
  }
  {
    const r = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('renounceOwnership') });
    eq(errorName(claimAbi, r), 'OwnershipIsPermanent',
       'ownership cannot be renounced: it would end setRoot and strand every later round');
  }
  {
    const r = await send({ from: 1, to: claim, data: claimAbi.encodeFunctionData('setRoot', [9, '0x' + '00'.repeat(32), 0]) });
    eq(errorName(claimAbi, r), 'EmptyRoot', 'a zero root is refused, so an unset round can never look open');
  }
  {
    const r = await send({ from: 0, to: claim, data: claimAbi.encodeFunctionData('claim', [
      99, 0, A(2), 1n, []]) });
    eq(errorName(claimAbi, r), 'RoundNotFound', 'claiming a round that was never registered reverts with RoundNotFound');
  }
  {
    // A deadline already past at deployment would make sweep callable in the
    // same block the contract exists.
    const art = load('HCOWClaim');
    const r = await send({ data: art.bytecode + claimAbi.encodeDeploy([token.toString(), treasury.toString(), now - 1n, NOTICE, WINDOW]).slice(2) });
    ok(!!r.execResult.exceptionError, 'deploying with a deadline already in the past fails');
    eq(errorName(claimAbi, r), 'DeadlineInThePast', 'and says so by name');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
