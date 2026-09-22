/* HCOWAnchor and scripts/anchor-merkle.cjs.
 *
 * Same in-process EVM harness as the other suites: no network, no hardhat,
 * artifacts straight off disk, time is the `now` variable.
 *
 * The trees under test are built by scripts/anchor-merkle.cjs, not by a
 * fixture written here. A contract tested against proofs from a generator that
 * is not the production generator has tested nothing about production.
 *
 * Every guard is asserted the only way a guard can honestly be asserted: by
 * feeding it the input it exists to reject and requiring it to stop, by name.
 * "It reverted" is satisfied by any of the five guards on anchor(), so
 * deleting the one under test would leave a looser assertion green.
 */
const fs = require('fs');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, privateToAddress } = require('@ethereumjs/util');
const { Interface, getAddress, keccak256, solidityPackedKeccak256 } = require('ethers');
const { buildBatch, leafA, leafB, orderRecords, PERIOD,
        assertRootsAgree, assertProofVerifies } = require('../scripts/anchor-merkle.cjs');

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

function errorName(iface, r) {
  const data = bytesToHex(r.execResult.returnValue || new Uint8Array());
  if (!data || data.length < 10) return '';
  try { return iface.parseError(data)?.name ?? ''; } catch (_) { return ''; }
}

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

const H = (s) => keccak256(Buffer.from(s, 'utf8')).slice(2); // 64 lowercase hex
const EPOCH_A = H('epoch-a');
const EPOCH_B = H('epoch-b');

/** n rounds across two epochs, shaped like what the engine actually emits. */
function fixture(n, tag = '') {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      roundHash: H(`round-${tag}-${i}`),
      epochKey: i % 2 === 0 ? EPOCH_A : EPOCH_B,
      nonce: i >> 1,
    });
  }
  return out;
}

const OWNER = 0, PUBLISHER = 1, STRANGER = 2, NEW_PUB = 3;

(async () => {
  common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Paris });
  vm = await VM.create({ common });
  for (const a of acc) await vm.stateManager.modifyAccountFields(a, { balance: 10n ** 22n });

  const anchorIface = new Interface(load('HCOWAnchor').abi);
  const anchor = await deploy('HCOWAnchor', anchorIface, [A(OWNER), A(PUBLISHER)]);
  const at = (fn, args = []) => read(anchorIface, anchor, fn, args);
  const tx = (from, fn, args) =>
    send({ from, to: anchor, data: anchorIface.encodeFunctionData(fn, args) });

  // 컨트랙트 상수를 먼저 확인한다. 아래의 모든 시간 산술이 빌더의 PERIOD 에서
  // 나오므로, 둘이 갈라지면 시간 관련 단언이 엉뚱한 이유로 실패한다.
  eq(Number(await at('PERIOD')), PERIOD, 'the contract PERIOD must equal the builder PERIOD (3600)');
  eq(Number(await at('PERIOD')), 3600, 'and PERIOD is one hour');

  console.log('\n--- 1. builder: the guards ---');

  const stops = (fn, needle, m) => {
    let msg = '';
    try { fn(); } catch (e) { msg = e.message; }
    ok(msg.includes(needle), msg ? m : `${m}   IT DID NOT STOP`);
  };

  // aligned AND already over. anchor() rejects a period that has not started
  // and, since the 2026-09-16 audit (A-H1), one that has not ended either.
  const P0 = Number(now) - (Number(now) % PERIOD) - PERIOD;

  stops(() => buildBatch(P0, []), 'empty batch', 'empty batch is rejected');
  stops(() => buildBatch(P0 + 1, fixture(4)), 'not aligned', 'unaligned periodStart is rejected');
  stops(() => buildBatch(0, fixture(4)), 'positive safe integer', 'zero periodStart is rejected');
  stops(() => buildBatch(P0, [{ roundHash: 'zz', epochKey: EPOCH_A, nonce: 0 }]),
    'roundHash must be', 'malformed roundHash is rejected');
  stops(() => buildBatch(P0, [{ roundHash: H('a').toUpperCase(), epochKey: EPOCH_A, nonce: 0 }]),
    'roundHash must be', 'uppercase roundHash is rejected');
  stops(() => buildBatch(P0, [{ roundHash: H('a'), epochKey: 'nope', nonce: 0 }]),
    'epochKey must be', 'malformed epochKey is rejected');
  stops(() => buildBatch(P0, [{ roundHash: H('a'), epochKey: EPOCH_A, nonce: -1 }]),
    'nonce must be', 'negative nonce is rejected');
  stops(() => buildBatch(P0, [{ roundHash: H('a'), epochKey: EPOCH_A, nonce: 1.5 }]),
    'nonce must be', 'fractional nonce is rejected');
  stops(() => buildBatch(P0, [
    { roundHash: H('a'), epochKey: EPOCH_A, nonce: 0 },
    { roundHash: H('a'), epochKey: EPOCH_A, nonce: 1 },
  ]), 'duplicate roundHash', 'duplicate roundHash is rejected');
  stops(() => buildBatch(P0, [
    { roundHash: H('a'), epochKey: EPOCH_A, nonce: 0 },
    { roundHash: H('b'), epochKey: EPOCH_A, nonce: 0 },
  ]), 'duplicate epoch slot', 'two roundHashes for one epoch slot are rejected');

  console.log('\n--- 2. builder: determinism and the two paths ---');

  const recs = fixture(9);
  const b1 = buildBatch(P0, recs);
  const b2 = buildBatch(P0, recs.slice().reverse());
  eq(b1.root, b2.root, 'input order does not change the root');
  eq(b1.root, b1.rootSecondPath, 'both independent paths agree');
  eq(b1.leafCount, 9, 'leafCount is the number of rounds');
  ok(/^0x[0-9a-f]{64}$/.test(b1.root), 'root is 32 bytes of hex');

  const single = buildBatch(P0, fixture(1));
  eq(single.root, '0x' + leafA(single.rounds[0].roundHash).toString('hex'),
    'a one-leaf tree roots at its leaf');
  eq(single.rounds[0].proof.length, 0, 'a one-leaf tree needs no proof');

  ok(orderRecords(recs)[0].epochKey <= orderRecords(recs)[1].epochKey, 'ordering groups by epoch');

  // The two self-checks below only fire when something else is already broken,
  // so correct input cannot tell "check present" from "check absent". They are
  // handed the inconsistency they exist to catch.
  const R1 = '0x' + '11'.repeat(32), R2 = '0x' + '22'.repeat(32);
  stops(() => assertRootsAgree(R1, R2), 'root mismatch', 'a root mismatch between the two paths stops the build');
  ok((() => { try { assertRootsAgree(R1, R1.toUpperCase()); return true; } catch (_) { return false; } })(),
    'and case alone is not a mismatch');
  stops(() => assertRootsAgree(R1, null), 'hex strings', 'a non-string root stops the build');
  stops(() => assertProofVerifies(leafB(b1.rounds[0].roundHash), b1.rounds[1].proof, b1.root, 'x'),
    'does not verify', 'a proof that does not replay to the root stops the build');
  stops(() => assertProofVerifies(leafB(H('never')), [], b1.root, 'y'),
    'does not verify', 'a leaf that is not in the tree stops the build');

  const changed = recs.slice();
  changed[3] = { ...changed[3], roundHash: H('tampered') };
  ok(buildBatch(P0, changed).root !== b1.root, 'changing one roundHash changes the root');

  console.log('\n--- 3. builder matches the contract leaf ---');

  const rh = b1.rounds[0].roundHash;
  eq(await at('leafOf', ['0x' + rh]), '0x' + leafA(rh).toString('hex'),
    'contract leafOf equals builder path A');
  eq(leafB(rh), '0x' + leafA(rh).toString('hex'), 'builder path B equals path A');
  eq(solidityPackedKeccak256(['bytes32'], ['0x' + rh]), leafB(rh),
    'leaf is keccak256(abi.encodePacked(bytes32))');

  console.log('\n--- 4. anchor(): access and validation ---');

  let r = await tx(STRANGER, 'anchor', [b1.root, b1.leafCount, P0]);
  eq(errorName(anchorIface, r), 'NotPublisher', 'a stranger cannot anchor');
  r = await tx(OWNER, 'anchor', [b1.root, b1.leafCount, P0]);
  eq(errorName(anchorIface, r), 'NotPublisher', 'the owner cannot anchor either');

  r = await tx(PUBLISHER, 'anchor', ['0x' + '00'.repeat(32), 1, P0]);
  eq(errorName(anchorIface, r), 'EmptyRoot', 'a zero root is rejected');
  r = await tx(PUBLISHER, 'anchor', [b1.root, 0, P0]);
  eq(errorName(anchorIface, r), 'EmptyBatch', 'a zero leafCount is rejected');
  r = await tx(PUBLISHER, 'anchor', [b1.root, b1.leafCount, P0 + 1]);
  eq(errorName(anchorIface, r), 'PeriodNotAligned', 'an unaligned period is rejected');
  r = await tx(PUBLISHER, 'anchor', [b1.root, b1.leafCount, P0 + 100 * PERIOD]);
  eq(errorName(anchorIface, r), 'PeriodInFuture', 'a future period is rejected');

  // A-H1: the hour must be over. periodStart is its START, so without this an
  // operator anchors an hour one second in and it can never be corrected.
  const currentHour = Number(now) - (Number(now) % PERIOD);
  r = await tx(PUBLISHER, 'anchor', [b1.root, b1.leafCount, currentHour]);
  eq(errorName(anchorIface, r), 'PeriodNotEnded', 'the hour in progress is rejected');
  const decoded = anchorIface.parseError(bytesToHex(r.execResult.returnValue));
  eq(Number(decoded.args.endsAt), currentHour + PERIOD, 'the error says when the hour ends');

  // 3차 감사 A-7. 유일한 미정렬 입력이 P0+1 이라 어떤 모듈러스에서도 실패했다.
  // `% PERIOD` 를 `% 60` 으로 바꿔도 84/0 이 통과했고, 그 상태에서 분 정렬이지만
  // 시 미정렬인 periodStart 가 수용됐다. 격자 크기를 실제로 확인한다.
  for (const off of [60, 1800, PERIOD - 1]) {
    r = await tx(PUBLISHER, 'anchor', [b1.root, b1.leafCount, P0 + 10 * PERIOD + off]);
    eq(errorName(anchorIface, r), 'PeriodNotAligned',
      `periodStart offset by ${off}s is not aligned to ${PERIOD}s`);
  }

  console.log('\n--- 5. anchor(): the append ---');

  r = await tx(PUBLISHER, 'anchor', [b1.root, b1.leafCount, P0]);
  ok(!r.execResult.exceptionError, 'the publisher can anchor');
  const e = evt(anchorIface, r, 'BatchAnchored');
  ok(!!e, 'BatchAnchored is emitted');
  eq(e.args.root, b1.root, 'the event carries the root');
  eq(Number(e.args.leafCount), 9, 'the event carries leafCount');
  eq(Number(e.args.periodStart), P0, 'the event carries periodStart');
  eq(Number(e.args.index), 0, 'the first batch is index 0');
  console.log('        anchor() gas used: ' + r.totalGasSpent.toString());

  eq(Number(await at('batchCount')), 1, 'batchCount is 1');
  eq(Number(await at('lastPeriodStart')), P0, 'lastPeriodStart moved');
  ok(await at('hasBatchForPeriod', [P0]), 'hasBatchForPeriod is true for the anchored hour');
  ok(!(await at('hasBatchForPeriod', [P0 + PERIOD])), 'and false for an hour with no batch');

  const stored = anchorIface.decodeFunctionResult('batchAt',
    await call(anchor, anchorIface.encodeFunctionData('batchAt', [0])))[0];
  eq(stored.root, b1.root, 'batchAt returns the root');
  eq(Number(stored.leafCount), 9, 'batchAt returns leafCount');
  eq(Number(stored.periodStart), P0, 'batchAt returns periodStart');
  eq(Number(stored.anchoredAt), Number(now), 'batchAt records when it was anchored');

  console.log('\n--- 6. an anchored root cannot be changed or replayed ---');

  r = await tx(PUBLISHER, 'anchor', [b1.root, b1.leafCount, P0]);
  eq(errorName(anchorIface, r), 'PeriodNotAfterLast', 'the same period cannot be anchored twice');
  r = await tx(PUBLISHER, 'anchor', [buildBatch(P0, fixture(3, 'x')).root, 3, P0]);
  eq(errorName(anchorIface, r), 'PeriodNotAfterLast', 'nor can a different root replace it');
  r = await tx(PUBLISHER, 'anchor', [b1.root, b1.leafCount, P0 - PERIOD]);
  eq(errorName(anchorIface, r), 'PeriodNotAfterLast', 'nor can an earlier period be back-filled');

  const fns = load('HCOWAnchor').abi.filter((x) => x.type === 'function');
  const writers = fns.filter((f) => f.stateMutability !== 'view' && f.stateMutability !== 'pure');
  eq(writers.map((f) => f.name).sort().join(','),
    'acceptOwnership,anchor,setPublisher,transferOwnership',
    'the contract has no other state-writing function');
  // renounceOwnership is declared pure and always reverts, so it is not in the
  // writer list at all. That is the strongest form of "it cannot change state".
  eq(fns.find((f) => f.name === 'renounceOwnership').stateMutability, 'pure',
    'renounceOwnership is pure, matching HCOWClaim and HCOWVesting');

  console.log('\n--- 7. gaps are allowed and visible ---');

  now += BigInt(4 * PERIOD);
  const b3 = buildBatch(P0 + 3 * PERIOD, fixture(5, 'later'));
  r = await tx(PUBLISHER, 'anchor', [b3.root, b3.leafCount, P0 + 3 * PERIOD]);
  ok(!r.execResult.exceptionError, 'a later period anchors after a gap');
  eq(Number(await at('batchCount')), 2, 'two batches');
  ok(!(await at('hasBatchForPeriod', [P0 + PERIOD])), 'the skipped hour is plainly missing');
  ok(!(await at('hasBatchForPeriod', [P0 + 2 * PERIOD])), 'and so is the next one');

  console.log('\n--- 8. proofs verify on chain ---');

  let allOk = true;
  for (const round of b1.rounds) {
    const got = await read(anchorIface, anchor, 'verifyRound', [0, '0x' + round.roundHash, round.proof]);
    if (!got) { allOk = false; break; }
  }
  ok(allOk, 'every one of the 9 proofs verifies against the anchored root');

  ok(!(await read(anchorIface, anchor, 'verifyRound', [0, '0x' + H('never-played'), b1.rounds[0].proof])),
    'a roundHash that was not in the batch does not verify');
  ok(!(await read(anchorIface, anchor, 'verifyRound', [0, '0x' + b1.rounds[0].roundHash, b1.rounds[1].proof])),
    'a proof from another leaf does not verify');
  ok(!(await read(anchorIface, anchor, 'verifyRound', [1, '0x' + b1.rounds[0].roundHash, b1.rounds[0].proof])),
    'a proof against the wrong batch does not verify');

  // An internal node replayed as a leaf. The two preimages differ in length
  // (32 vs 64), so this cannot work without a keccak break.
  //
  // The earlier version of this test used proof[0], which is always a LEAF, not
  // an internal node, and it returned false for every input including random
  // bytes — it carried zero bits of information. Audit 2026-09-16 (A-M2).
  //
  // A real internal node is one the tree actually computed. Take the level-1
  // node over leaves 0 and 1, and ask the contract to treat it as a roundHash.
  const leaves = b1.rounds.map((x) => leafA(x.roundHash));
  const [lo, hi] = leaves[0].compare(leaves[1]) <= 0 ? [leaves[0], leaves[1]] : [leaves[1], leaves[0]];
  const realInternal = '0x' + Buffer.from(
    require('js-sha3').keccak_256.arrayBuffer(Buffer.concat([lo, hi]))).toString('hex');
  ok(b1.rounds[0].proof.includes(realInternal) || b1.rounds[2].proof.includes(realInternal),
    'the value under test is genuinely a node of this tree');
  ok(!leaves.some((l) => '0x' + l.toString('hex') === realInternal),
    'and it is genuinely NOT a leaf');
  ok(!(await read(anchorIface, anchor, 'verifyRound', [0, realInternal, []])),
    'an internal node presented as a leaf does not verify');
  // And it stays false with the proof that would lift it to the root, which is
  // what an attacker would actually try.
  const lift = b1.rounds[0].proof.slice(1);
  ok(!(await read(anchorIface, anchor, 'verifyRound', [0, realInternal, lift])),
    'nor with the proof above it');

  console.log('\n--- 9. publisher rotation reaches nothing already anchored ---');

  r = await tx(STRANGER, 'setPublisher', [A(NEW_PUB)]);
  eq(errorName(anchorIface, r), 'OwnableUnauthorizedAccount', 'a stranger cannot rotate the publisher');
  r = await tx(PUBLISHER, 'setPublisher', [A(NEW_PUB)]);
  eq(errorName(anchorIface, r), 'OwnableUnauthorizedAccount', 'the publisher cannot rotate itself');
  r = await tx(OWNER, 'setPublisher', ['0x' + '00'.repeat(20)]);
  eq(errorName(anchorIface, r), 'ZeroAddress', 'the publisher cannot be set to zero');

  r = await tx(OWNER, 'setPublisher', [A(NEW_PUB)]);
  ok(!r.execResult.exceptionError, 'the owner rotates the publisher');
  eq(evt(anchorIface, r, 'PublisherChanged').args.newPublisher, A(NEW_PUB), 'rotation is an event');
  eq(await at('publisher'), A(NEW_PUB), 'the publisher changed');

  r = await tx(PUBLISHER, 'anchor', [buildBatch(P0 + 4 * PERIOD, fixture(2, 'z')).root, 2, P0 + 4 * PERIOD]);
  eq(errorName(anchorIface, r), 'NotPublisher', 'the old publisher is out');

  const after = anchorIface.decodeFunctionResult('batchAt',
    await call(anchor, anchorIface.encodeFunctionData('batchAt', [0])))[0];
  eq(after.root, b1.root, 'batch 0 is untouched by the rotation');

  console.log('\n--- 10. ownership is permanent ---');

  r = await tx(OWNER, 'renounceOwnership', []);
  eq(errorName(anchorIface, r), 'OwnershipIsPermanent', 'ownership cannot be renounced');
  eq(await at('owner'), A(OWNER), 'the owner is still the owner');

  console.log('\n--- 11. views reject out-of-range reads ---');

  r = await send({ from: OWNER, to: anchor, data: anchorIface.encodeFunctionData('batchAt', [99]) });
  eq(errorName(anchorIface, r), 'IndexOutOfRange', 'batchAt reverts past the end');
  r = await send({ from: OWNER, to: anchor, data: anchorIface.encodeFunctionData('batchForPeriod', [P0 + PERIOD]) });
  eq(errorName(anchorIface, r), 'NoBatchForPeriod', 'batchForPeriod reverts for an unanchored hour');

  // 3차 감사 A-2.
  //
  // 이전 판에서 batchForPeriod 는 이 두 줄에만 등장했고, **앵커된 시간에 대해
  // 호출한 적도 반환값을 확인한 적도 없었다.** 그래서 이 변형 4건이 전부
  // 84/0 을 통과했다: 엉뚱한 배치 반환 / 항상 배치 0 반환 / periodStart→index
  // 매핑을 index+2 로 쓰기 / batchAt 끝단 off-by-one.
  //
  // 이 함수는 anchor.cjs 의 stale-exporter 검사가 의존하는 것이고,
  // 검증 페이지가 "시간 → 배치" 를 얻는 유일한 경로다.
  {
    const dec = (res) => anchorIface.decodeFunctionResult('batchForPeriod', bytesToHex(res.execResult.returnValue))[0];
    const decAt = (res) => anchorIface.decodeFunctionResult('batchAt', bytesToHex(res.execResult.returnValue))[0];
    const count = Number(anchorIface.decodeFunctionResult('batchCount',
      bytesToHex((await send({ from: OWNER, to: anchor, data: anchorIface.encodeFunctionData('batchCount', []) })).execResult.returnValue))[0]);
    ok(count >= 2, 'this section needs at least two anchored batches');

    // 앵커된 모든 시간에 대해 batchForPeriod 와 batchAt 이 같은 것을 가리켜야 한다
    let allAgree = true;
    const roots = [];
    for (let i = 0; i < count; i++) {
      const byIndex = decAt(await send({ from: OWNER, to: anchor, data: anchorIface.encodeFunctionData('batchAt', [i]) }));
      const byPeriod = dec(await send({ from: OWNER, to: anchor, data: anchorIface.encodeFunctionData('batchForPeriod', [byIndex.periodStart]) }));
      roots.push(byIndex.root);
      if (byPeriod.root !== byIndex.root ||
          String(byPeriod.periodStart) !== String(byIndex.periodStart) ||
          String(byPeriod.leafCount) !== String(byIndex.leafCount)) allAgree = false;
    }
    ok(allAgree, 'batchForPeriod(periodStart) returns exactly the batch batchAt(index) returns');
    // 항상 배치 0 을 돌려주는 구현을 잡으려면 배치들이 서로 구별되어야 한다
    eq(new Set(roots).size, roots.length, 'the anchored batches are distinguishable by root');

    r = await send({ from: OWNER, to: anchor, data: anchorIface.encodeFunctionData('batchAt', [count]) });
    eq(errorName(anchorIface, r), 'IndexOutOfRange', 'batchAt(batchCount()) is out of range');
  }

  console.log('\n--- 12. a realistic hour ---');

  now += BigInt(2 * PERIOD);
  const big = fixture(500, 'hour');
  const bb = buildBatch(P0 + 5 * PERIOD, big);
  eq(bb.leafCount, 500, '500 rounds in one batch');
  r = await tx(NEW_PUB, 'anchor', [bb.root, bb.leafCount, P0 + 5 * PERIOD]);
  ok(!r.execResult.exceptionError, '500 rounds anchor in one transaction');
  console.log('        anchor() gas used with 500 rounds: ' + r.totalGasSpent.toString() +
    '   (the tree is off chain, so the cost does not move)');
  const idx = Number(await at('batchCount')) - 1;
  ok(await read(anchorIface, anchor, 'verifyRound', [idx, '0x' + bb.rounds[250].roundHash, bb.rounds[250].proof]),
    'a proof from the middle of 500 verifies');
  eq(bb.rounds[250].proof.length, 9, 'a 500-leaf tree gives a 9-step proof');

  console.log('\n--- 13. PeriodNotEnded: the exact boundary (audit A-1) ---');
  // 3차 감사 A-1.
  //
  // 이전 판의 마지막 줄은 `ok(Number(now) >= currentHour, 'sanity')` 였다.
  // currentHour 는 now - now%PERIOD 로 정의되므로 **항상 참** 이다. 주석은
  // "끝난 마지막 시간은 받아들여진다" 고 말하는데 그걸 확인하는 코드가 없었다.
  // 그래서 가드를 1초/60초 일찍 열거나 정확한 경계를 닫는 변형 3건이 전부
  // 84/0 을 통과했다. 스위트가 앵커하는 타임스탬프의 최소 여유가 2,800초라
  // 경계 근처를 한 번도 지나가지 않았다.
  //
  // 이제 block.timestamp 를 endsAt-1 / endsAt / endsAt+1 세 지점에 정확히 놓고
  // 각각을 단언한다. 경계는 **포함** 이다 (endsAt 에서 앵커할 수 있다).
  {
    const probe = P0 + 900 * PERIOD;     // 이 스위트가 쓰는 어떤 시간보다 뒤. 여기서 앵커해도 앞을 막지 않는다
    const endsAt = probe + PERIOD;
    const saved = now;
    const bp = buildBatch(probe, fixture(2, 'boundary'));

    now = BigInt(endsAt - 1);
    r = await tx(NEW_PUB, 'anchor', [bp.root, bp.leafCount, probe]);
    eq(errorName(anchorIface, r), 'PeriodNotEnded', 'one second before the hour ends is rejected');

    now = BigInt(endsAt);
    r = await tx(NEW_PUB, 'anchor', [bp.root, bp.leafCount, probe]);
    ok(errorName(anchorIface, r) !== 'PeriodNotEnded', 'the exact boundary is accepted (inclusive)');

    now = BigInt(endsAt + 1);
    r = await tx(NEW_PUB, 'anchor', [bp.root, bp.leafCount, probe]);
    ok(errorName(anchorIface, r) !== 'PeriodNotEnded', 'one second after the hour ends is accepted');

    now = saved;
  }



  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
