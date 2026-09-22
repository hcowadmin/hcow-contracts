/* scripts/build-merkle.cjs — the seven checks of spec v0.1 section 6.
 *
 * Each one is asserted the only way a guard can honestly be asserted: by
 * feeding it the input it exists to reject and requiring it to stop. A
 * generator that silently accepts bad input produces a root that is wrong in a
 * way nothing downstream can detect, because on-chain every root looks alike.
 */
const { getAddress, solidityPackedKeccak256 } = require('ethers');
const { buildDistribution } = require('../scripts/build-merkle.cjs');
const { buildRound, verifyProof, leafB } = require('../scripts/merkle.cjs');

const E18 = 10n ** 18n;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const eq = (a, b, m) => ok(a === b, a === b ? m : `${m}   got ${a} want ${b}`);

/** Runs the builder and returns the error message, or '' if it did not stop. */
function rejects(rows, policy, opts) {
  try { buildDistribution(rows, policy, opts); return ''; }
  catch (e) { return e.message; }
}
const stops = (rows, policy, needle, m, opts) => {
  const msg = rejects(rows, policy, opts);
  ok(msg.includes(needle), msg ? m : `${m}   IT DID NOT STOP`);
};

const TGE = 1900000000;
const POLICY = {
  monthSeconds: 2592000,
  tgeTime: TGE,
  dustThreshold: '0',
  categories: {
    miniapp: { tgeBps: 3300, tailRounds: 2 },
    taskon: { tgeBps: 2000, tailRounds: 4 },
    other: { tgeBps: 10000, tailRounds: 0 },
  },
  bucket: { total: (8_000_000n * E18).toString(), tgeBps: 3750, cliffMonths: 0, linearMonths: 6 },
};
const addr = (n) => getAddress('0x' + (0xbee000 + n).toString(16).padStart(40, '0'));
const row = (n, category = 'miniapp', totalAmount = (100n * E18 + 7n).toString()) =>
  ({ line: n, account: addr(n), category, totalAmount });

const base = [row(1), row(2, 'taskon'), row(3, 'other'), row(4, 'taskon'), row(5, 'miniapp')];

console.log('\nbuild-merkle, the seven checks');

// 1  addresses are valid and checksummed
stops([{ ...row(1), account: addr(1).toLowerCase() }], POLICY, 'not checksummed',
      '1  a lowercase address is refused rather than quietly normalised');
stops([{ ...row(1), account: '0xdeadbeef' }], POLICY, 'not a 20-byte address',
      '1  and so is something that is not an address at all');
{
  // a real address with one hex digit changed keeps the length and loses the checksum
  const a = addr(1);
  const broken = a.slice(0, -1) + (a.slice(-1) === '0' ? '1' : '0');
  const msg = rejects([{ ...row(1), account: broken }], POLICY);
  ok(msg.includes('checksum') || msg.includes('not checksummed'),
     '1  a single mistyped character fails the checksum instead of paying a stranger');
}

// 2  no duplicate addresses
stops([row(1), { ...row(2), account: addr(1) }], POLICY, 'already appeared',
      '2  the same address twice is refused, because it would be two claims against one entitlement');

// 3  zero amounts are excluded
{
  const d = buildDistribution([...base, row(9, 'other', '0')], POLICY, { tgeTime: TGE });
  eq(d.dropped.length, 1, '3  a zero-total row is dropped');
  const zero = addr(9);
  ok(d.rounds.filter(Boolean).every((r) => r.claims[zero] === undefined),
     '3  and appears in no round');
  ok(d.rounds.filter(Boolean).every((r) => Object.values(r.claims).every((c) => BigInt(c.amount) > 0n)),
     '3  no leaf in any round carries a zero amount');
}
stops([{ ...row(1), totalAmount: '1.5' }], POLICY, 'integer number of wei',
      '3  a decimal amount is refused rather than truncated');

// 4  each account's round amounts sum to its total
{
  const d = buildDistribution(base, POLICY, { tgeTime: TGE });
  let worst = 0n;
  for (const r of base) {
    const parts = d.rounds.filter(Boolean)
      .map((x) => x.claims[r.account]).filter(Boolean)
      .reduce((a, c) => a + BigInt(c.amount), 0n);
    const diff = parts - BigInt(r.totalAmount);
    if (diff !== 0n) worst = diff;
  }
  eq(worst, 0n, '4  every account receives its exact total across its rounds, remainder included');

  const last = d.rounds.filter(Boolean).map((x) => x.claims[addr(1)]).filter(Boolean);
  ok(last.length === 3, '4  the miniapp account is split over three rounds');
  ok(BigInt(last[2].amount) >= BigInt(last[1].amount),
     '4  and the last round carries the remainder, so it is never the short one');
}

// 5  the grand total is preserved
{
  const d = buildDistribution(base, POLICY, { tgeTime: TGE });
  const total = base.reduce((a, r) => a + BigInt(r.totalAmount), 0n);
  const out = d.rounds.filter(Boolean).reduce((a, r) => a + BigInt(r.total), 0n);
  eq(out, total, '5  the rounds distribute exactly the input total, nothing created and nothing lost');
}

// 6  no round opens on tokens the vesting contract has not released yet
{
  // The whole bucket demanded at TGE, when vesting has released 37.5% of it.
  const greedy = [{ line: 1, account: addr(1), category: 'other', totalAmount: (8_000_000n * E18).toString() }];
  stops(greedy, POLICY, 'money that does not exist',
        '6  a round that opens on more than vesting has released is refused');

  // the same demand paid out over the tail rounds fits
  const ok1 = rejects([{ line: 1, account: addr(1), category: 'taskon', totalAmount: (2_000_000n * E18).toString() }],
                      POLICY, { tgeTime: TGE });
  eq(ok1, '', '6  and a schedule that stays inside the released amount is accepted');

  stops([{ line: 1, account: addr(1), category: 'other', totalAmount: (9_000_000n * E18).toString() }], POLICY,
        'more than the whole', '6  demanding more than the bucket holds is refused outright');
}

// 7  two independent root computations, and every proof replayed
{
  const entries = base.map((r, i) => ({ account: r.account, amount: BigInt(i + 1) * E18 }));
  const t = buildRound(3, entries);
  eq(t.root.toLowerCase(), t.rootSecondPath.toLowerCase(),
     '7  js-sha3/iterative and ethers/recursive agree on the root');
  ok(Object.entries(t.claims).every(([a, c]) => verifyProof(leafB(3, c.index, a, c.amount), c.proof, t.root)),
     '7  and every proof replays from its leaf to that root');

  // the leaf the generator hashes is the leaf the contract hashes
  const [a0, c0] = Object.entries(t.claims)[0];
  eq(leafB(3, c0.index, a0, c0.amount),
     solidityPackedKeccak256(['uint256', 'uint256', 'address', 'uint256'], [3n, BigInt(c0.index), a0, BigInt(c0.amount)]),
     '7  the leaf preimage is abi.encodePacked(roundId, index, account, amount), as in HCOWClaim._claim');

  // a leaf from another round does not verify: roots are per round and so are leaves
  ok(!verifyProof(leafB(4, c0.index, a0, c0.amount), c0.proof, t.root),
     '7  the same entry in a different round produces a different leaf');
}

console.log('\npolicy guards');
{
  const { loadPolicy } = require('../scripts/build-merkle.cjs');
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcow-'));
  const viaFile = (obj) => {
    const p = path.join(dir, 'policy.json');
    fs.writeFileSync(p, JSON.stringify(obj));
    try { loadPolicy(p); return ''; } catch (e) { return e.message; }
  };

  // Months are 30 days, in the policy file and in HCOWVesting. A calendar
  // month puts every round start off the grid the tokens actually vest on.
  stops(base, { ...POLICY, monthSeconds: 2678400 }, '2592000',
        'a calendar month is refused by the builder');
  ok(viaFile({ ...POLICY, monthSeconds: 2678400 }).includes('2592000'),
     'and by the policy loader, naming the 30-day month HCOWVesting uses');

  ok(viaFile({ ...POLICY, categories: { ...POLICY.categories, other: { tgeBps: 5000, tailRounds: 0 } } }).includes('strands'),
     'a category paying under 100% at TGE with no tail rounds is refused: the rest would reach no round at all');
  ok(viaFile({ ...POLICY, categories: { ...POLICY.categories, other: { tgeBps: 10001, tailRounds: 0 } } }).includes('0..10000'),
     'a ratio above 100% is refused');
  ok(viaFile({ ...POLICY, bucket: { ...POLICY.bucket, total: undefined } }).includes('bucket.total'),
     'a policy with no bucket figure is refused, because check 6 would have nothing to measure against');

  stops(base, POLICY, 'unix SECONDS', 'a missing TGE time stops the run', { tgeTime: 0 });
  stops([{ ...row(1), category: 'nope' }], POLICY, 'unknown category', 'an unknown category stops the run');
}

console.log('\ndust consolidation (spec 4-3, option 1)');
{
  const dusty = { ...POLICY, dustThreshold: (50n * E18).toString() };
  const d = buildDistribution([row(1, 'miniapp', (60n * E18).toString()), ...base.slice(1)], dusty, { tgeTime: TGE });
  const who = addr(1);
  const inRounds = d.rounds.filter(Boolean).filter((r) => r.claims[who]);
  eq(inRounds.length, 1, 'an account whose split would fall below the threshold is paid once');
  eq(inRounds[0].roundId, 0, 'in round 0');
  eq(BigInt(inRounds[0].claims[who].amount), 60n * E18, 'and in full');
  eq(BigInt(d.rounds[0].claims[addr(5)] ? d.rounds[0].claims[addr(5)].amount : 0n) > 0n, true,
     'while accounts above the threshold keep their normal split');
  eq(BigInt(POLICY.dustThreshold), 0n, 'the default threshold is zero, so none of this happens unless it is set');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
