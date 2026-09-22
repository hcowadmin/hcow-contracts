'use strict';
/* The builder guards added after the fourth adversarial audit (2026-09-18).
 *
 * These live in their own file because they work by loading build-merkle.cjs
 * against a DELIBERATELY BROKEN merkle.cjs, which means clearing the module
 * cache. Doing that inside build-merkle.test.cjs would leave the rest of that
 * file holding two different copies of the same module.
 *
 * What is being defended: check 4 used to compare split()'s output with
 * split()'s own input, four lines apart, and so proved only that split()
 * agreed with itself. Nothing compared the amounts that actually reached a
 * leaf against the input file. The audit swapped two accounts' amounts on the
 * way into the tree -- totals preserved, so check 5 saw nothing, and both
 * roots agreed with each other because both were built from the same swapped
 * data -- and all seven checks passed on a tree that paid one account 900,000
 * HCOW instead of 1.
 */
const path = require('path');
const { ethers } = require('ethers');

const E = 10n ** 18n;
const MERKLE = require.resolve('../scripts/merkle.cjs');
const BUILD = require.resolve('../scripts/build-merkle.cjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

const POLICY = {
  monthSeconds: 2592000,
  bucket: { label: 'Community / Airdrop', total: (8_000_000n * E).toString(), tgeBps: 3750, cliffMonths: 0, linearMonths: 6 },
  dustThreshold: '0',
  categories: { flat: { tgeBps: 10000, tailRounds: 0 }, split3: { tgeBps: 3300, tailRounds: 2 } },
};
const A = (i) => ethers.getAddress('0x' + (BigInt('0x4000000000000000000000000000000000000000') + BigInt(i)).toString(16).padStart(40, '0'));
const ROWS = [
  { account: A(1), category: 'split3', totalAmount: (1n * E).toString() },
  { account: A(2), category: 'split3', totalAmount: (900000n * E).toString() },
  { account: A(3), category: 'flat', totalAmount: (5n * E).toString() },
];
const TGE = 1900000000;

/** Load build-merkle.cjs fresh, optionally against a tampered buildRound. */
function loadBuilder(tamper) {
  delete require.cache[BUILD];
  delete require.cache[MERKLE];
  const merkle = require(MERKLE);
  if (tamper) {
    const real = merkle.buildRound;
    merkle.buildRound = (roundId, entries) => real(roundId, tamper(entries.map((e) => ({ ...e }))));
  }
  return require(BUILD);
}

function build(tamper) {
  const { buildDistribution } = loadBuilder(tamper);
  try {
    const d = buildDistribution(ROWS, POLICY, { tgeTime: TGE });
    return { ok: true, d };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

(async () => {
  console.log('\nbuild-merkle.cjs — the trees pay what the input says (audit 4, B-1)\n');

  {
    const clean = build(null);
    ok(clean.ok, 'an untampered build still succeeds');
    if (clean.ok) {
      const paid = new Map();
      for (const r of clean.d.rounds.filter(Boolean)) {
        for (const [acct, c] of Object.entries(r.claims)) paid.set(acct, (paid.get(acct) || 0n) + BigInt(c.amount));
      }
      ok(paid.get(A(1)) === 1n * E && paid.get(A(2)) === 900000n * E && paid.get(A(3)) === 5n * E,
        'and every account is paid its exact input total across the rounds');
    }
  }

  {
    // The audit's defect, verbatim: swap the first two entries' amounts on the
    // way into the tree. The grand total is preserved.
    const swapped = build((entries) => {
      if (entries.length >= 2) { const t = entries[0].amount; entries[0].amount = entries[1].amount; entries[1].amount = t; }
      return entries;
    });
    ok(!swapped.ok, 'two accounts swapped between split() and the tree is refused');
    ok(!swapped.ok && swapped.msg.includes('the trees do not pay what the input says'),
      'and the message says the trees disagree with the input, not something vaguer');
    ok(!swapped.ok && swapped.msg.includes('900000'), 'and names the amount actually reaching the leaf');
  }

  {
    // An account in the trees that is in no input row at all.
    const extra = build((entries) => entries.concat([{ account: A(999), amount: (7n * E).toString() }]));
    ok(!extra.ok, 'an account in a tree with no input row is refused');
    ok(!extra.ok && extra.msg.includes('no row in the input at all'), 'and is named as exactly that');
  }

  {
    // An account dropped from a tree. Its total goes missing, which check 5
    // would also catch, but this names the account rather than a wei figure.
    const dropped = build((entries) => entries.filter((e, i) => i !== 0));
    ok(!dropped.ok, 'an account dropped from a tree is refused');
    ok(!dropped.ok && dropped.msg.includes('the trees pay 0 wei') || (!dropped.ok && dropped.msg.includes('the trees do not pay')),
      'and the account is named');
  }

  console.log('\nbuild-merkle.cjs — the second root survives into the output (audit 4, B-2)\n');
  {
    const clean = build(null);
    ok(clean.ok && clean.d.rounds.filter(Boolean).every((r) => typeof r.rootSecondPath === 'string' && /^0x[0-9a-f]{64}$/i.test(r.rootSecondPath)),
      'every round carries rootSecondPath');

    // Said plainly, because the sabotage sweep proved it: replacing
    // `rootSecondPath: t.rootSecondPath` with `rootSecondPath: t.root`
    // survives every test here and always will. The builder refuses to write
    // anything unless the two roots are equal, so in any file that exists the
    // field equals merkleRoot whichever path produced it. That makes it an
    // equivalent mutation, not an untested guard, and the field records that
    // a second path ran rather than proving it.
    //
    // What IS testable is that the comparison itself is live.
    // buildRound calls rootB through a module-internal binding, so patching
    // the export does nothing. Wrapping buildRound is what reaches it.
    const broken = (() => {
      delete require.cache[BUILD]; delete require.cache[MERKLE];
      const merkle = require(MERKLE);
      const real = merkle.buildRound;
      merkle.buildRound = (roundId, entries) => ({ ...real(roundId, entries), rootSecondPath: '0x' + '11'.repeat(32) });
      const { buildDistribution } = require(BUILD);
      try { buildDistribution(ROWS, POLICY, { tgeTime: TGE }); return null; }
      catch (e) { return e.message; }
      finally { merkle.buildRound = real; delete require.cache[BUILD]; delete require.cache[MERKLE]; }
    })();
    ok(!!broken && broken.includes('the two independent root computations disagree'),
      'a path B that returns a different root stops the build, so the comparison is live');
  }

  console.log('\nscripts/merkle.cjs — one tree walk, not one per leaf (audit 4, B-3)\n');
  {
    delete require.cache[MERKLE];
    const { buildRound, levelsA, proofFromLevels, leafA, verifyProof, leafB } = require(MERKLE);
    ok(typeof levelsA === 'function' && typeof proofFromLevels === 'function',
      'levelsA and proofFromLevels are exported');

    // Correctness first: every proof of every tree size 1..40 replays.
    let bad = 0, checked = 0;
    for (let n = 1; n <= 40; n++) {
      const entries = Array.from({ length: n }, (_, i) => ({ account: A(i + 1), amount: String(BigInt(i + 1) * 10n ** 15n) }));
      const t = buildRound(5, entries);
      for (const [acct, c] of Object.entries(t.claims)) {
        checked++;
        if (!verifyProof(leafB(5, c.index, acct, c.amount), c.proof, t.root)) bad++;
      }
    }
    ok(bad === 0, `every proof replays for tree sizes 1..40 (${checked} proofs, ${bad} bad)`);

    // Then the scaling claim. Quadratic would put n=8000 at roughly sixteen
    // times n=2000; this asserts it is under four, which linear-plus-hashing
    // clears comfortably and quadratic cannot.
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ account: A(i + 1), amount: String(BigInt(i + 1) * 10n ** 13n) }));
    const time = (n) => { const e = mk(n); const t0 = Date.now(); buildRound(0, e); return Date.now() - t0; };
    time(500);
    const t2 = Math.max(time(2000), 1);
    const t8 = time(8000);
    ok(t8 / t2 < 6, `quadrupling the input does not multiply the time by sixteen (${t2}ms -> ${t8}ms, x${(t8 / t2).toFixed(1)})`);
  }

  console.log('\nbuild-merkle.cjs — the dust rule and the remainder  (audit 4, E1/E2/E3)\n');
  {
    const { buildDistribution } = loadBuilder(null);
    const paidPerRound = (d, acct) => d.rounds.filter(Boolean).map((r) => BigInt(r.claims[acct]?.amount ?? 0n));

    // E1: the default threshold. The existing assertion read the test file's
    // own constant, so changing the code's `?? 0` to 1e30 changed nothing.
    // This reads the behaviour instead: with no dustThreshold in the policy,
    // a small account is still split.
    const noDust = { ...POLICY };
    delete noDust.dustThreshold;
    const d1 = buildDistribution(ROWS, noDust, { tgeTime: TGE });
    ok(paidPerRound(d1, A(1)).filter((x) => x > 0n).length > 1,
      'with no dustThreshold in the policy, a 1 HCOW account is still split across rounds');
    ok(d1.consolidated.length === 0, 'and nothing is consolidated');

    // E2: the threshold applies to accounts BELOW it and to no others. The
    // old assertion only checked that a large account got something in round
    // 0, which is true whether or not it was wrongly consolidated.
    const withDust = { ...POLICY, dustThreshold: (10n * E).toString() };
    const d2 = buildDistribution(ROWS, withDust, { tgeTime: TGE });
    const small = paidPerRound(d2, A(1)).filter((x) => x > 0n);
    const large = paidPerRound(d2, A(2)).filter((x) => x > 0n);
    ok(small.length === 1, 'an account under the threshold is paid in exactly one round');
    ok(paidPerRound(d2, A(1))[0] === 1n * E, 'and that round is round 0, in full');
    ok(large.length > 1, 'while an account ABOVE the threshold keeps its normal split');
    ok(large.reduce((a, b) => a + b, 0n) === 900000n * E, 'and still receives its whole total');

    // E3: the remainder lands on the LAST round. The old assertion used >=,
    // which a remainder moved to round 0 satisfies by making the last two
    // rounds equal.
    const rows = [{ account: A(1), category: 'split3', totalAmount: '100' }];
    const d3 = buildDistribution(rows, { ...POLICY, dustThreshold: '0' }, { tgeTime: TGE });
    const parts = paidPerRound(d3, A(1));
    ok(parts.reduce((a, b) => a + b, 0n) === 100n, '100 wei over three rounds still sums to 100');
    ok(parts[parts.length - 1] > parts[1],
      `the last round is strictly the largest, so it is carrying the remainder (${parts.join(' / ')})`);
  }

  console.log('\nbuild-merkle.cjs — a round cannot open on more than vesting has released  (audit 4, P06)\n');
  {
    const { buildDistribution } = loadBuilder(null);
    // Everything at TGE, so round 0 alone must fit inside the TGE unlock.
    const atTge = (n) => [{ account: A(1), category: 'flat', totalAmount: n.toString() }];
    const unlock = (8_000_000n * E * 3750n) / 10000n;   // bucket.tgeBps of the bucket
    const exact = (() => { try { buildDistribution(atTge(unlock), POLICY, { tgeTime: TGE }); return null; } catch (e) { return e.message; } })();
    ok(exact === null, 'a round 0 demanding exactly the TGE unlock is accepted');
    const over = (() => { try { buildDistribution(atTge(unlock + 1n), POLICY, { tgeTime: TGE }); return null; } catch (e) { return e.message; } })();
    ok(!!over && /round 0/.test(over), 'one wei more is refused, and the message names the round');
  }

  console.log('\nbuild-merkle.cjs — the grand total guard is live  (audit 4, P07)\n');
  {
    // Deleting check 5 outright left 31 passed, 0 failed. Here the trees are
    // made to distribute more than the input, with the per-account check
    // satisfied, so check 5 is the only thing standing.
    const inflated = build((entries) => entries.map((e) => ({ ...e, amount: (BigInt(e.amount) * 2n).toString() })));
    ok(!inflated.ok, 'trees that pay double the input are refused');
    ok(!inflated.ok && /do not pay what the input says|distribute/.test(inflated.msg),
      'and the message says so');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
