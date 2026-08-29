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
const V = 'contracts/HCOWVesting.sol';
const T = 'contracts/HCOWToken.sol';
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

const filter = process.argv[2];
const chosen = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS;
const results = chosen.map((m) => { process.stdout.write(`... ${m.name}\n`); const r = run(m); console.log(`    ${r.status}  ${r.detail}`); return r; });
console.log('');
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.status.padEnd(17)} ${r.name.padEnd(w)}`);
const bad = results.filter((r) => r.status !== 'CAUGHT');
console.log(`\n${results.length - bad.length} of ${results.length} mutations caught`);
for (const f of [V, T]) {
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
console.log('all sources restored and rebuilt');
process.exit(bad.length ? 1 : 0);
