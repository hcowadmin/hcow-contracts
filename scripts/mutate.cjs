'use strict';
/**
 * Mutation runner for hcow-contracts. See the sibling file in hcow-protocol.
 *
 * A guard that no test notices is not a guard. Each entry deletes one guard,
 * runs the suite that is supposed to catch it, restores the file, and reports
 * whether the suite failed on the named assertion rather than merely failing.
 *
 * Usage: npm run test:mutate   (or: node scripts/mutate.cjs [substring])
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
 * Crash safety.
 *
 * This runner edits the real sources and restores them afterwards. If it is
 * killed between the two - a timeout, a Ctrl-C, an OOM - a mutated guard stays
 * on disk. Signal handlers do not help: execSync blocks the event loop, so the
 * handler does not run until the child returns, which is exactly when the
 * process is being killed. It happened twice on 2026-09-16.
 *
 * So: before touching anything, every source is copied to .mutate-backup and a
 * sentinel is written. The sentinel is removed only on a clean finish. A run
 * that finds a sentinel restores from the backup and says so, instead of
 * layering a second mutation on top of a first.
 * ------------------------------------------------------------------ */
const BACKUP = path.join(ROOT, '.mutate-backup');
const SENTINEL = path.join(BACKUP, 'IN_PROGRESS');

function guardedFiles() {
  return Array.from(new Set(MUTATIONS.map((m) => m.file)));
}

function recoverIfNeeded() {
  if (!fs.existsSync(SENTINEL)) return;
  console.error('a previous run did not finish - restoring sources from .mutate-backup');
  for (const f of guardedFiles()) {
    const b = path.join(BACKUP, path.basename(f));
    if (fs.existsSync(b)) {
      fs.copyFileSync(b, path.join(ROOT, f));
      console.error('  restored ' + f);
    }
  }
  fs.rmSync(SENTINEL, { force: true });
  try { execSync('node compile.cjs', { cwd: ROOT, stdio: 'ignore' }); } catch (_) {}
  console.error('recovered. re-run to continue.');
  process.exit(2);
}

function takeBackup() {
  fs.mkdirSync(BACKUP, { recursive: true });
  for (const f of guardedFiles()) {
    fs.copyFileSync(path.join(ROOT, f), path.join(BACKUP, path.basename(f)));
  }
  fs.writeFileSync(SENTINEL, new Date().toISOString());
}
const V = 'contracts/HCOWVesting.sol';
const T = 'contracts/HCOWToken.sol';
const C = 'contracts/HCOWClaim.sol';
const AN = 'contracts/HCOWAnchor.sol';
const AM = 'scripts/anchor-merkle.cjs';
const CJS = (f) => `node compile.cjs >/dev/null && node ${f}`;

const MUTATIONS = [
  {
    // expectedTgeUnlock_ was named by the CommitmentMismatch error and
    // constrained by nothing, so a decimal slip produced a contract that could
    // never be sealed and any HCOW sent to it was stranded permanently.
    name: 'the TGE unlock commitment is unconstrained at deployment again',
    file: V,
    from: '            expectedTgeUnlock_ > expectedScheduled_ ||\n',
    to:   '',
    run: CJS('test.cjs'),
    expect: 'a TGE unlock larger than the scheduled total is refused at deployment',
  },
  {
    name: 'the rescue recipient may be the vesting token again',
    file: V,
    from: '        if (rescueRecipient_ == address(this) || rescueRecipient_ == token_) {\n            revert InvalidRescueRecipient();\n        }',
    to:   '        if (false) {\n            revert InvalidRescueRecipient();\n        }',
    run: CJS('test.cjs'),
    expect: 'a rescue recipient set to the vesting token is refused at deployment',
  },
  {
    name: 'fundAndSeal no longer funds: the seal can be reached unfunded',
    file: V,
    from: '        if (held < owed) {\n            token.safeTransferFrom(msg.sender, address(this), owed - held);\n        }',
    to:   '        if (false) {\n            token.safeTransferFrom(msg.sender, address(this), owed - held);\n        }',
    run: CJS('test.cjs'),
    expect: 'leaving no funded-and-unsealed window at all',
  },
  {
    name: 'the live-supply bound at seal removed',
    file: V,
    from: '            revert CommittedTotalExceedsLiveSupply(totalScheduled, liveSupply);',
    to:   '            {}',
    run: CJS('audit.cjs'),
    expect: 'and it names the committed total against live supply, not merely underfunding',
  },
  {
    name: 'the vesting token itself becomes rescuable',
    file: V,
    from: '        if (foreign == address(token)) revert CannotRescueVestingToken();',
    to:   '        if (false) revert CannotRescueVestingToken();',
    run: CJS('audit.cjs'),
    expect: 'and it is refused for being the vesting token, not for the balance being empty',
  },
  {
    name: 'replaceTable can leave the table empty again',
    file: V,
    from: '        if (n == 0) revert NoSchedules();\n        if (\n            totals.length != n ||',
    to:   '        if (false) revert NoSchedules();\n        if (\n            totals.length != n ||',
    run: CJS('test.cjs'),
    expect: 'and the table cannot be replaced with nothing',
  },
  {
    name: 'the vesting period bound removed',
    file: V,
    from: '            if (span > MAX_VESTING_MONTHS) revert VestingTooLong(span);',
    to:   '            if (false) revert VestingTooLong(span);',
    run: CJS('test.cjs'),
    expect: 'a 1200 month linear period is refused at entry',
  },
  {
    name: 'renounceOwnership becomes possible again',
    file: V,
    from: '        revert OwnershipIsPermanent();',
    to:   '        return;',
    run: CJS('test.cjs'),
    expect: 'ownership cannot be renounced',
  },
  {
    name: 'getOwner removed from the token',
    file: T,
    from: '    function getOwner() external pure returns (address) {',
    to:   '    function getOwner_disabled() external pure returns (address) {',
    run: CJS('test.cjs'),
    expect: 'getOwner reports the zero address',
  },
  // ---------------------------------------------------------- HCOWClaim
  {
    // The one the spec calls the most important test in the suite. Without the
    // balance check the transfer still reverts, so the bitmap bit is still
    // rolled back and the contract is still safe - but it reverts with the
    // token's error rather than this contract's, and the test that proves the
    // entry survives an underfunded round no longer knows what it is proving.
    name: 'the pre-transfer balance check on claim removed',
    file: C,
    from: '        if (held < amount) revert InsufficientBalance(amount, held);',
    to:   '        held;',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '9  a claim the contract cannot pay reverts with InsufficientBalance',
  },
  {
    name: 'the already-claimed guard removed: a round pays twice',
    file: C,
    from: '        if (isClaimed(roundId, index)) revert AlreadyClaimed(roundId, index);',
    to:   '',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '1  the second claim of the same round reverts with AlreadyClaimed',
  },
  {
    name: 'the round start time no longer gates claiming',
    file: C,
    from: '        if (block.timestamp < r.startTime) revert RoundNotStarted(roundId, r.startTime);',
    to:   '',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '6  a claim before the round opens reverts with RoundNotStarted',
  },
  {
    // The guard the whole contract exists to make credible: an operator who can
    // rewrite a live root can pay any address any amount.
    name: 'an open round\'s root becomes changeable again',
    file: C,
    from: '        if (r.merkleRoot != bytes32(0) && block.timestamp >= r.startTime) {',
    to:   '        if (false) {',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '7  the root of an open round cannot be changed',
  },
  {
    name: 'the claim deadline becomes shortenable',
    file: C,
    from: '        if (newDeadline <= old) revert DeadlineNotExtended(old, newDeadline);',
    to:   '        if (newDeadline == 0) revert DeadlineNotExtended(old, newDeadline);',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '13 shortening the deadline reverts with DeadlineNotExtended',
  },
  {
    name: 'sweep no longer waits for the deadline',
    file: C,
    from: '        if (block.timestamp < deadline) revert DeadlineNotReached(deadline);',
    to:   '        deadline;',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '11 sweep before claimDeadline reverts with DeadlineNotReached',
  },
  {
    // The floor was the one owner power here that ran both ways. Raising it
    // over a live distribution excludes the smallest recipients, which is
    // shortening the deadline by another route.
    name: 'the claim floor becomes raisable again after a round has opened',
    file: C,
    from: '        if (newMinClaimAmount > old && block.timestamp >= opensAt) {',
    to:   '        if (false) {',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '18 raising the floor after a round has opened reverts with MinClaimAmountRaiseClosed',
  },
  {
    // The gate reads one variable, and that variable is written in one place.
    // Dropping the write leaves the gate intact and permanently open.
    name: 'setRoot stops recording the earliest round start',
    file: C,
    from: '        if (startTime < earliestRoundStart) earliestRoundStart = startTime;\n',
    to:   '',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '17 earliestRoundStart is the first registered round, not the last',
  },
  {
    // The leaf the contract hashes and the leaf build-merkle.cjs hashes are one
    // definition in two files. Nothing but a test holds them together.
    name: 'the leaf loses its round: the contract and the generator disagree',
    file: C,
    from: 'keccak256(abi.encodePacked(roundId, index, account, amount))',
    to:   'keccak256(abi.encodePacked(index, account, amount))',
    run: CJS('test/HCOWClaim.test.cjs'),
    expect: '1  the first claim of a round succeeds',
  },
  // ---------------------------------------------------------------- anchor
  {
    // An anchored root that can be replaced is not an anchor. This is the
    // guard the whole contract exists for.
    name: 'an anchored period can be re-anchored with a different root again',
    file: AN,
    from: '        if (periodStart <= lastPeriodStart) revert PeriodNotAfterLast(periodStart, lastPeriodStart);',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'nor can a different root replace it',
  },
  {
    name: 'anyone can anchor again',
    file: AN,
    from: '        if (msg.sender != publisher) revert NotPublisher(msg.sender);',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'a stranger cannot anchor',
  },
  {
    name: 'an hour that has not ended can be anchored again (audit A-H1)',
    file: AN,
    from: '        uint64 endsAt = periodStart + PERIOD;\n        if (endsAt > block.timestamp) revert PeriodNotEnded(periodStart, endsAt, block.timestamp);',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'the hour in progress is rejected',
  },
  {
    name: 'PERIOD is no longer one hour',
    file: AN,
    from: '    uint64 public constant PERIOD = 1 hours;',
    to:   '    uint64 public constant PERIOD = 60;',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'the contract PERIOD must equal the builder PERIOD (3600)',
  },
  {
    name: 'the leaf is no longer hashed, so a roundHash is its own leaf',
    file: AN,
    from: '        return keccak256(abi.encodePacked(roundHash));',
    to:   '        return roundHash;',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'contract leafOf equals builder path A',
  },
  {
    name: 'a batch can be anchored for a period that has not begun again',
    file: AN,
    from: '        if (periodStart > block.timestamp) revert PeriodInFuture(periodStart, block.timestamp);',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'a future period is rejected',
  },
  {
    name: 'periods need not be aligned again',
    file: AN,
    from: '        if (periodStart % PERIOD != 0) revert PeriodNotAligned(periodStart, PERIOD);',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'an unaligned period is rejected',
  },
  {
    name: 'an empty root can be anchored again',
    file: AN,
    from: '        if (root == bytes32(0)) revert EmptyRoot();',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'a zero root is rejected',
  },
  {
    name: 'a zero leafCount can be anchored again',
    file: AN,
    from: '        if (leafCount == 0) revert EmptyBatch();',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'a zero leafCount is rejected',
  },
  {
    name: 'ownership can be renounced again, stranding the publisher key',
    file: AN,
    from: `    /// @inheritdoc Ownable
    /// @dev pure, matching HCOWClaim and HCOWVesting. A contract whose
    ///      publisher key can never be rotated again stops working the first
    ///      time that key is lost.
    function renounceOwnership() public pure override {
        revert OwnershipIsPermanent();
    }`,
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'ownership cannot be renounced',
  },
  {
    // The leaf must hash a 32-byte preimage while nodes hash 64. Hashing the
    // roundHash twice keeps the lengths apart but changes every leaf, so the
    // builder and the contract stop agreeing.
    name: 'the contract leaf no longer matches the builder leaf',
    file: AN,
    from: '        return keccak256(abi.encodePacked(roundHash));',
    to:   '        return keccak256(abi.encodePacked(roundHash, roundHash));',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'contract leafOf equals builder path A',
  },
  // ------------------------------------------------------- anchor-merkle.cjs
  {
    name: 'the builder accepts a duplicate roundHash again, inflating leafCount',
    file: AM,
    from: "    if (seenRound.has(r.roundHash)) throw new Error(`duplicate roundHash ${r.roundHash}`);",
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'duplicate roundHash is rejected',
  },
  {
    name: 'the builder accepts two roundHashes for one epoch slot again',
    file: AM,
    from: '    if (seenSlot.has(slot)) throw new Error(`duplicate epoch slot ${slot}`);',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'two roundHashes for one epoch slot are rejected',
  },
  {
    name: 'the builder no longer sorts, so the root depends on arrival order',
    file: AM,
    from: '  const ordered = orderRecords(records);',
    to:   '  const ordered = records.slice();',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'input order does not change the root',
  },
  {
    name: 'the builder stops comparing its two independent roots',
    file: AM,
    from: '  if (rA.toLowerCase() !== rB.toLowerCase()) {\n    throw new Error(`root mismatch between independent paths: ${rA} vs ${rB}`);\n  }',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'a root mismatch between the two paths stops the build',
  },
  {
    name: 'the builder stops replaying every proof before publishing',
    file: AM,
    from: '  if (!verifyProof(leafHex, proof, root)) {\n    throw new Error(`proof for ${label} does not verify against the root`);\n  }',
    to:   '',
    run: CJS('test/HCOWAnchor.test.cjs'),
    expect: 'a proof that does not replay to the root stops the build',
  },
];
function run(m) {
  const p = path.join(ROOT, m.file);
  const original = fs.readFileSync(p, 'utf8');
  if (!original.includes(m.from)) {
    return { name: m.name, status: 'SKIP', detail: 'anchor text not found; the mutation is stale' };
  }
  fs.writeFileSync(p, original.replace(m.from, m.to));
  let out = '', failed = false;
  try {
    out = execSync(m.run, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  } finally {
    fs.writeFileSync(p, original);
  }
  // The assertion name must appear on a FAILURE line, not merely somewhere in
  // the output: the same name is printed in the suite's PASS report, so a
  // substring match made "the suite failed somehow" indistinguishable from
  // "the named assertion failed".
  // `XX name` and `FAIL  name` from the hand-written suites, `[FAIL: name]`
  // from forge. All three are failure markers; nothing else in either output
  // puts one of these immediately before an assertion's own text.
  const named = new RegExp('(XX|FAIL:?)\\s+' + m.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(out);
  return {
    name: m.name,
    status: failed && named ? 'CAUGHT' : failed ? 'FAILED ELSEWHERE' : 'SURVIVED',
    detail: failed && named ? m.expect
      : (out.split('\n').filter((l) => /FAIL|XX |rror/.test(l)).slice(0, 2).join(' | ') || out.slice(-200)).slice(0, 240),
  };
}

recoverIfNeeded();
takeBackup();

const filter = process.argv[2];
const chosen = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS;
const results = chosen.map((m) => { process.stdout.write(`... ${m.name}\n`); const r = run(m); console.log(`    ${r.status}  ${r.detail}`); return r; });
console.log('');
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.status.padEnd(17)} ${r.name.padEnd(w)}`);
const bad = results.filter((r) => r.status !== 'CAUGHT');
console.log(`\n${results.length - bad.length} of ${results.length} mutations caught`);
for (const f of [V, T, C, AN, AM]) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of MUTATIONS) {
    if (m.file === f && !src.includes(m.from)) {
      console.error(`RESTORE FAILED: ${f}`); process.exit(2);
    }
  }
}
// Rebuild from the restored sources. The artifacts on disk are otherwise those
// of the last mutation, and the next thing anyone runs - checkflat, which gates
// BscScan verification - reports a false mismatch against them.
try { execSync('node compile.cjs', { cwd: ROOT, stdio: 'ignore' }); } catch (_) {}
fs.rmSync(SENTINEL, { force: true });
console.log('all sources restored and rebuilt');
process.exit(bad.length ? 1 : 0);
