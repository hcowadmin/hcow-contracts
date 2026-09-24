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

// 10차 감사: 백업 이름을 basename 으로 정해서 같은 이름의 파일 두 개가 서로를
// 덮어쓸 수 있었다. 경로 전체를 이름에 넣는다.
function backupName(f) {
  return f.replace(/[\\/]/g, '__');
}

function recoverIfNeeded() {
  if (!fs.existsSync(SENTINEL)) return;
  console.error('a previous run did not finish - restoring sources from .mutate-backup');
  // 11차 감사. 이전 판은 백업이 없는 파일을 경고 없이 건너뛰고 "recovered" 를
  // 출력했다. 10차에 백업 이름 형식이 바뀌어서(경로 포함), 그 전 판이 남긴 백업은
  // 찾지 못했고, 다음 실행의 takeBackup 이 변이된 파일을 원본으로 떠서 마지막
  // 바이트 비교가 그것을 "복원 완료" 로 인증했다 (재현: 봉인 스크립트의 재봉인
  // 가드가 꺼진 채 exit 0). 이제 센티널에 어떤 파일을 떴는지 적고, 복원할 수 없는
  // 파일이 하나라도 있으면 멈춘다. 센티널도 지우지 않는다.
  let files;
  try { files = JSON.parse(fs.readFileSync(SENTINEL, 'utf8')).files; } catch (_) { files = null; }
  if (!Array.isArray(files)) files = guardedFiles();   // 옛 형식 센티널(시각 문자열)
  const missing = [];
  const plan = [];
  for (const f of files) {
    const candidates = [path.join(BACKUP, backupName(f)), path.join(BACKUP, path.basename(f))];
    const b = candidates.find((c) => fs.existsSync(c));
    if (b) plan.push([b, f]); else missing.push(f);
  }
  if (missing.length) {
    console.error('CANNOT RECOVER: no backup was found for these files, so this runner cannot tell');
    console.error('whether a mutation is still in them:');
    for (const f of missing) console.error('  ' + f);
    console.error('Restore them by hand from version control or a known-good copy, then delete');
    console.error(SENTINEL + ' yourself. Nothing has been changed.');
    process.exit(2);
  }
  for (const [b, f] of plan) {
    fs.copyFileSync(b, path.join(ROOT, f));
    console.error('  restored ' + f);
  }
  try {
    execSync('node compile.cjs', { cwd: ROOT, stdio: 'ignore' });
  } catch (_) {
    console.error('sources restored but compile.cjs FAILED; artifacts may still be mutated. Fix that first.');
    process.exit(2);
  }
  fs.rmSync(SENTINEL, { force: true });
  console.error('recovered. re-run to continue.');
  process.exit(2);
}

function takeBackup() {
  fs.mkdirSync(BACKUP, { recursive: true });
  for (const f of guardedFiles()) {
    fs.copyFileSync(path.join(ROOT, f), path.join(BACKUP, backupName(f)));
  }
  fs.writeFileSync(SENTINEL, JSON.stringify({ started: new Date().toISOString(), files: guardedFiles() }));
}
const V = 'contracts/HCOWVesting.sol';
const T = 'contracts/HCOWToken.sol';
const C = 'contracts/HCOWClaim.sol';
const AN = 'contracts/HCOWAnchor.sol';
const AM = 'scripts/anchor-merkle.cjs';
const CB = 'test/claim-boundaries.test.cjs';
const OG = 'test/ops-guards.test.cjs';
const BG = 'test/builder-guards.test.cjs';
// 운영 스크립트 뮤테이션에 쓰는 파일들. 7차 M-13 · 8차 조치.
const DEP = 'scripts/deploy.cjs';
const DCL = 'scripts/deploy-claim.cjs';
const DAN = 'scripts/deploy-anchor.cjs';
const SR = 'scripts/set-root.cjs';
const LD = 'scripts/load.cjs';
const BM = 'scripts/build-merkle.cjs';
const CN = 'scripts/_connect.cjs';
const CC = 'scripts/commitcheck.cjs';
const SL = 'scripts/seal.cjs';
const RL = 'scripts/release.cjs';
const DT = 'scripts/deploy-token.cjs';
const ACH = 'scripts/anchor.cjs';
const DTT = 'test/deploy-token.test.cjs';
const CJS = (f) => `node compile.cjs >/dev/null && node ${f}`;
// 자바스크립트만 바꾸는 뮤테이션은 컴파일이 필요 없다. 뮤테이션마다 20초씩
// 붙는 비용이고, ops-guards 는 한 번 돌 때 6분이 넘으므로 아끼는 편이 낫다.
const JS = (f) => `node ${f}`;

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
    // 8차 감사: 이 뮤테이션은 낡아 있었다. 7차 조치로 게이트가 block.timestamp
    // 기반에서 earliestRoundStart 기반으로 바뀌었는데 앵커 텍스트를 갱신하지
    // 않아서 SKIP("anchor text not found") 으로 조용히 넘어갔다. 뮤테이션 러너의
    // SKIP 은 "가드가 검증됐다" 가 아니라 "아무것도 확인하지 않았다" 다.
    name: 'the claim floor becomes raisable again after the first round is registered',
    file: C,
    from: '        if (newMinClaimAmount > old && firstRound != type(uint256).max) {',
    to:   '        if (false) {',
    run: CJS(CB),
    expect: '등록 직후, 개시 30일 전인데도 인상이 거부된다  (kills 게이트를 개시 시점으로 되돌리기)',
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
  },  // ==================================================================
  // 8차 감사 조치. 7차 M-13 이 지적한 공백: 러너가 claim-boundaries ·
  // ops-guards · builder-guards · deploy-token 네 스위트를 아예 몰랐고,
  // notice · window 파라미터와 운영 스크립트의 가드는 뮤테이션이 하나도
  // 없었다. 가드에 테스트가 있다는 것과 그 테스트가 가드가 사라진 것을
  // 알아챈다는 것은 다른 명제다.
  // ==================================================================
  {
    name: '8차: setRoot 의 청구 창 상한이 사라진다',
    file: C,
    from: '        if (startTime > latest) revert ClaimWindowTooShort(startTime, latest);',
    to:   '        latest;',
    run: CJS(CB),
    expect: 'one second later is refused  (kills >= vs > on the window check)',
  },
  {
    name: '8차: 생성자의 minClaimWindow 범위 검사가 사라진다',
    file: C,
    from: '        if (minClaimWindow_ < MIN_WINDOW_FLOOR || minClaimWindow_ > MIN_WINDOW_CEILING) {',
    to:   '        if (false) {',
    run: CJS(CB),
    expect: 'a zero window is refused',
  },
  {
    name: '8차: 생성자가 회차 하나 들어갈 자리를 확인하지 않는다',
    file: C,
    from: '        if (claimDeadline_ < earliestUsable) {',
    to:   '        if (false) {',
    run: CJS(CB),
    expect: 'one second less is refused rather than deployed unusable',
  },
  {
    name: '8차: extendDeadline 의 지평선 상한이 사라진다',
    file: C,
    from: '        if (newDeadline > maxDeadline) revert DeadlineTooFar(newDeadline, maxDeadline);',
    to:   '        maxDeadline;',
    run: CJS(CB),
    expect: '2^256-1 로의 연장은 거부된다  (kills 상한 삭제)',
  },
  {
    name: '8차: 생성자의 claimDeadline 지평선 상한이 사라진다',
    file: C,
    from: '        if (claimDeadline_ > maxDeadline) revert DeadlineTooFar(claimDeadline_, maxDeadline);',
    to:   '        maxDeadline;',
    run: CJS(CB),
    expect: 'one second past it is refused — the horizon is actually enforced',
  },
  {
    // 8차 H-1. 이 스크립트는 억제 플래그를 아예 몰랐다.
    name: '8차: deploy.cjs 가 다시 DRY_RUN 을 무시한다',
    file: DEP,
    from: '  const dryRun = suppressed();',
    to:   '  const dryRun = false;',
    run: JS(OG),
    expect: 'DRY_RUN=yes 는 exit 0 이고 DRY RUN 이라고 말한다',
  },
  {
    // 8차 H-3. 검사를 껐을 때 토큰이 먼저 배포되는 그 상태로 돌아간다.
    name: '8차: deploy.cjs 의 배포 전 공급량 검사가 사라진다',
    file: DEP,
    from: '  if (c.total > CANONICAL_SUPPLY) {',
    to:   '  if (false) {',
    run: JS(OG),
    expect: '합계가 공급량을 넘으면 거부한다',
  },
  {
    // 8차 L-3. 단축평가로 되돌린다.
    name: '8차: suppressed() 가 두 번째 플래그의 오타를 검증하지 않는다',
    file: CN,
    from: "  const dry = dryFlag('DRY_RUN');\n  const print = dryFlag('PRINT_ONLY');\n  return dry || print;",
    to:   "  return dryFlag('DRY_RUN') || dryFlag('PRINT_ONLY');",
    run: JS(OG),
    expect: 'DRY_RUN=yes 여도 PRINT_ONLY 의 오타는 그냥 지나가지 않는다',
  },
  {
    // 8차 M-9.
    name: '8차: set-root.cjs 가 PRINT_ONLY 에서도 키를 요구한다',
    file: SR,
    from: "needSigner: !noSend });",
    to:   "needSigner: true });",
    run: JS(OG),
    expect: 'PRINT_ONLY=yes 는 TREASURY_KEY 가 환경에 아예 없어도 calldata 를 찍는다',
  },
  {
    // 8차 M-8.
    name: '8차: deploy-anchor.cjs 의 드라이런이 첫 배포에서 다시 막힌다',
    file: DAN,
    from: "  if (!existing && process.env.FIRST_DEPLOY !== '1' && !dryRun) {",
    to:   "  if (!existing && process.env.FIRST_DEPLOY !== '1') {",
    run: JS(OG),
    expect: '레코드가 없어도 DRY_RUN=yes 로 리허설된다',
  },
  {
    // 8차 M-6.
    name: '8차: deploy-claim.cjs 가 과거 TGE 를 받아들인다',
    file: DCL,
    from: '    if (tgeFromEnv <= now) {',
    to:   '    if (false) {',
    run: JS(OG),
    expect: '과거 TGE 는 거부된다',
  },
  {
    name: '8차: deploy-claim.cjs 가 365일을 넘는 TGE 를 받아들인다',
    file: DCL,
    from: '    if (tgeFromEnv > now + 365 * DAY) {',
    to:   '    if (false) {',
    run: JS(OG),
    expect: '365일을 넘는 TGE 는 거부된다',
  },
  {
    // 8차 M-7.
    name: '8차: 메인넷 드라이런이 다시 TGE 필수 검사를 건너뛴다',
    file: DCL,
    from: '  } else if (mainnet) {',
    to:   '  } else if (mainnet && !dryRun) {',
    run: JS(OG),
    expect: '메인넷 DRY_RUN 도 TGE 없이는 통과하지 않는다',
  },
  {
    // 8차 H-4.
    name: '8차: assertBucket 이 linearMonths 0 을 다시 통과시킨다',
    file: BM,
    from: '  if (bps < 10000 && Number(b.linearMonths) === 0) {',
    to:   '  if (false) {',
    run: JS(BG),
    expect: 'tgeBps 가 10000 미만인데 linearMonths 가 0 이면 거부한다',
  },
  {
    // 8차 M-2. 절단 비교를 항상 참으로 만든다.
    name: '8차: check 9 의 자리수 비교가 아무것도 비교하지 않는다',
    file: BM,
    from: '      if (truncated !== want) {',
    to:   '      if (false) {',
    run: JS(BG),
    expect: '0.01 높게 공표하면 거부되고 방향을 말한다',
  },
  {
    // 8차 M-10.
    name: '8차: load.cjs 가 다시 DRY_RUN 을 모른다',
    file: LD,
    from: '  const printOnly = suppressed();',
    to:   "  const printOnly = process.env.PRINT_ONLY === 'yes';",
    run: JS(OG),
    expect: 'load.cjs DRY_RUN=yes 는 키 없이 addSchedules calldata 를 찍는다',
  },
  // ==================================================================
  // 9차 감사 조치. 8차 조치를 적대적으로 재검해서 나온 가드들.
  // ==================================================================
  {
    // 10차: 이 가드는 deploy.cjs 에서 _connect.cjs 의 readRecord 로 옮겨졌다. 같은 명제를 새 위치에 다시 건다.
    name: "9차: deploy.cjs 가 레코드의 주소 값을 다시 보지 않는다",
    file: CN,
    from: "    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "deploy-token.cjs 는 {HCOWToken:\"\"} 레코드를 {} 로도 받아들이지 않는다",
  },
  {
    // 10차: 이 가드는 deploy.cjs 에서 _connect.cjs 의 readRecord 로 옮겨졌다. 같은 명제를 새 위치에 다시 건다.
    name: "9차: deploy.cjs 가 알려진 키를 하나도 요구하지 않는다",
    file: CN,
    from: "  if (keys.length === 0) bad.push('addresses is empty; no script writes a record that names nothing');",
    to:   "",
    run: JS(OG),
    expect: "그리고 addresses:{} 의 이유를 이름으로 말한다",
  },
  {
    name: '9차: deploy.cjs 의 배포 전 생성자 사전 검사가 사라진다',
    file: DEP,
    from: '  if (BigInt(c.count) > MAX_BENEFICIARIES) {',
    to:   '  if (false) {',
    run: JS(OG),
    expect: '201행은 배포 전에 거부된다',
  },
  {
    name: '9차: deploy.cjs 의 메인넷 합계 등식이 사라진다',
    file: DEP,
    from: '  if (mainnet && BigInt(c.total) !== CANONICAL_SUPPLY) {',
    to:   '  if (false) {',
    run: JS(OG),
    expect: '합계가 200,000,000 미만이면 메인넷에서 거부된다',
  },
  {
    name: '9차: deploy.cjs 의 메인넷 9행 등식이 사라진다',
    file: DEP,
    from: '  if (mainnet && Number(c.count) !== 9) {',
    to:   '  if (false) {',
    run: JS(OG),
    expect: '메인넷에서 8행은 거부된다',
  },
  {
    name: '9차: deploy.cjs 가 봉인된 베스팅을 덮어쓸 수 있게 된다',
    file: DEP,
    from: '      if (wasSealed) {',
    to:   '      if (false) {',
    run: JS(OG),
    expect: 'REPLACE_VESTING=1 로도 봉인된 베스팅은 교체되지 않는다',
  },
  {
    // 11차: 10차의 재지정은 가드를 끄지 못했다 — `if (false)` 로 바꾸면 곧바로
    // 아래 else-if 가 "chainId is undefined" 로 여전히 거부했다. 이름이 말하는
    // "받아들인다" 가 실제로 일어나도록 거부 한 줄만 지운다.
    name: "9차: deploy.cjs 가 chainId 없는 레코드를 받아들인다",
    file: CN,
    from: "    bad.push('it has no chainId field, so nothing shows it belongs to this chain');",
    to:   "",
    run: JS(OG),
    expect: "chainId 가 없는 레코드는 거부된다",
  },
  {
    name: '9차: deploy.cjs 의 드라이런이 건너뛴 검사를 숨긴다',
    file: DEP,
    from: "    if (bal === 0n) skipped.push('the deployer has no BNB (checked only on the live run)');",
    to:   '    if (false) skipped.push(0);',
    run: JS(OG),
    expect: '그리고 그 검사를 건너뛴 것을 밝힌다',
  },
  {
    name: '9차: deploy-claim.cjs 의 드라이런이 다시 잔액 0 에서 멈춘다',
    file: DCL,
    from: "  if (bal === 0n && !dryRun) throw new Error('deployer has no BNB');",
    to:   "  if (bal === 0n) throw new Error('deployer has no BNB');",
    run: JS(OG),
    expect: '잔액 0 이어도 deploy-claim.cjs 의 드라이런은 끝까지 돈다 (9차 B-F1)',
  },
  {
    name: '9차: deploy-claim.cjs 가 과거 TGE 를 다시 잣대로 쓴다',
    file: DCL,
    from: '    const past = tge <= now;',
    to:   '    const past = false;',
    run: JS(OG),
    expect: '레코드 tgeTime 이 과거면 기한을 지금부터 재고 짧으면 거부한다',
  },
  {
    name: '9차: deploy-claim.cjs 가 다시 단축평가로 플래그를 읽는다',
    file: DCL,
    from: '  const dryRun = suppressed();',
    to:   "  const dryRun = dryFlag('DRY_RUN') || dryFlag('PRINT_ONLY');",
    run: JS(OG),
    expect: 'deploy-claim.cjs 도 두 번째 플래그의 오타를 잡는다 (9차 B-F3)',
  },
  {
    name: '9차: deploy-token.cjs 가 다시 단축평가로 플래그를 읽는다',
    file: 'scripts/deploy-token.cjs',
    from: '  const dryRun = suppressed();',
    to:   "  const dryRun = dryFlag('DRY_RUN') || dryFlag('PRINT_ONLY');",
    run: JS(OG),
    expect: 'deploy-token.cjs 도 잡는다',
  },
  {
    name: '9차: release.cjs 가 다시 억제 플래그를 무시한다',
    file: 'scripts/release.cjs',
    from: '  if (noSend) {',
    to:   '  if (false) {',
    run: JS(OG),
    // 9차 사보타주: 이 분기를 지우면 signer 가 없어 더 앞에서 죽는다. 그래서
    // "보내지 않는다" 단언이 아니라 "calldata 를 찍는다" 단언이 먼저 깨진다.
    // 그쪽이 이 분기가 실제로 하는 일이므로 그것을 건다.
    expect: 'RELEASE=yes DRY_RUN=yes 는 release() calldata 를 찍는다',
  },
  {
    name: '9차: load.cjs 가 다시 owner 를 레코드에서 읽는다',
    file: LD,
    from: '  const onChainOwner = await vc.owner();',
    to:   '  const onChainOwner = treasury;',
    run: JS(OG),
    expect: '레코드의 treasury 가 체인의 owner 와 다르면 거부한다',
  },
  {
    name: '9차: set-root.cjs 가 --claim 의 코드 존재를 보지 않는다',
    file: SR,
    from: "  if (await provider.getCode(claimAddr) === '0x') {",
    to:   '  if (false) {',
    run: JS(OG),
    expect: '코드 없는 --claim 주소는 문장으로 거부된다',
  },
  {
    name: '9차: deploy-anchor.cjs 가 다시 chainId 를 쓰지 않는다',
    file: DAN,
    from: '  record.chainId = chainId;\n',
    to:   '',
    run: JS(OG),
    expect: '그리고 이제 레코드에 chainId 를 쓴다',
  },

  // ==================================================================
  // 10차 감사 조치. 레코드 검증 통합, 메인넷 새 토큰 경로 폐쇄, 행 사전 검사,
  // claim 교차검사, deploy-claim 순서 강제, seal/release/set-root 보강.
  // seal.cjs 는 이 러너에 처음 들어온다 (이전 0건).
  // ==================================================================
  {
    name: "10차: readRecord 가 손상된 레코드를 다시 통과시킨다",
    file: CN,
    from: "  if (bad.length) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "deploy-token.cjs 는 {{}} 레코드를 {} 로도 받아들이지 않는다",
  },
  {
    name: "10차: 토큰 없이 claim 만 있는 레코드를 받아들인다",
    file: CN,
    from: "  if ((a.HCOWClaim || a.HCOWVesting) && !a.HCOWToken) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "deploy-token.cjs 는 {HCOWClaim 만 (토큰 삭제)} 레코드를 {} 로도 받아들이지 않는다",
  },
  {
    name: "10차: 레코드의 zero address 를 받아들인다",
    file: CN,
    from: "    } else if (/^0x0{40}$/.test(v)) {",
    to:   "    } else if (false) {",
    run: JS(OG),
    expect: "deploy-token.cjs 는 {zero address} 레코드를 {} 로도 받아들이지 않는다",
  },
  {
    name: "10차: 레코드의 알 수 없는 키를 받아들인다",
    file: CN,
    from: "    if (!RECORD_KEYS.includes(k)) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "deploy-token.cjs 는 {알 수 없는 키} 레코드를 {} 로도 받아들이지 않는다",
  },
  {
    name: "10차: readRecord 가 chainId 를 대조하지 않는다 (앵커 세탁)",
    file: CN,
    from: "  } else if (Number(r.chainId) !== Number(chainId)) {",
    to:   "  } else if (false) {",
    run: JS(OG),
    expect: "deploy-anchor.cjs 는 chainId 97 레코드를 거부한다",
  },
  {
    name: "10차: 7702 위임 EOA 를 컨트랙트로 본다",
    file: CN,
    from: "  return code === '0x' || /^0xef0100[0-9a-fA-F]{40}$/.test(code);",
    to:   "  return code === '0x';",
    run: JS(OG),
    expect: "deploy-claim.cjs 는 7702 위임 EOA 오너를 EOA 로 보고 거부한다",
  },
  {
    name: "10차: 메인넷 deploy.cjs 가 다시 토큰을 배포한다",
    file: DEP,
    from: "    if (!process.env.HCOW_ADDRESS) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "메인넷에서 레코드가 없어도 HCOW_ADDRESS 없이는 거부된다",
  },
  {
    name: "10차: 메인넷에서 레코드가 토큰을 부르지 않아도 진행한다",
    file: DEP,
    from: "    if (!recordedToken) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "메인넷에서는 토큰이 기록되지 않은 레코드를 거부한다 (10차)",
  },
  {
    name: "10차: 자금이 든 미봉인 베스팅을 교체할 수 있다",
    file: DEP,
    from: "        if (inside > 0n) {",
    to:   "        if (false) {",
    run: JS(OG),
    expect: "1 wei 라도 든 미봉인 베스팅은 REPLACE_VESTING 으로도 교체되지 않는다",
  },
  {
    name: "10차: 토큰 자신을 수혜자로 둔 행을 받아들인다",
    file: DEP,
    from: "    if (tokenRow) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "토큰 자신을 수혜자로 둔 행은 거부된다",
  },
  {
    name: "10차: 다른 토큰에 묶인 claim 을 받아들인다",
    file: DEP,
    from: "        if (clToken.toLowerCase() !== token.toLowerCase()) {",
    to:   "        if (false) {",
    run: JS(OG),
    expect: "다른 토큰에 묶인 claim 이면 거부된다",
  },
  {
    name: "10차: 테이블에 claim 이 없어도 진행한다",
    file: DEP,
    // 12차: 11차가 이 검사를 claimRows.length === 0 으로 다시 썼는데 앵커를 옮기지
    // 않아 11차 판에서는 SKIP 이었다 (백로그 C-12 재발).
    from: "          if (claimRows.length === 0) {",
    to:   "          if (false) {",
    run: JS(OG),
    expect: "테이블이 claim 을 수혜자로 갖지 않으면 거부된다",
  },
  {
    name: "10차: claim 기한을 이 TGE 에 대고 재지 않는다",
    file: DEP,
    from: "        if (mainnet && months < 12) {",
    to:   "        if (false) {",
    run: JS(OG),
    expect: "기한이 이 TGE 로부터 12개월 미만이면 거부된다",
  },
  {
    name: "10차: rescue 가 예측 주소여도 받아들인다",
    file: DEP,
    from: "    if (r === tokenAt.toLowerCase() || r === vestingAt.toLowerCase()) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "rescue 가 이번 실행의 vesting 주소면 거부된다",
  },
  {
    name: "10차: held 검사를 '죽은 코드' 로 지운다",
    file: DEP,
    from: "    if (held < c.total) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "트레저리가 1 wei 모자라면 메인넷에서 거부된다 (held 검사는 살아 있다)",
  },
  {
    name: "10차: loadSchedule 이 tgeBps 10000 초과를 받아들인다",
    file: CC,
    from: "    const bps = intField('tgeBps', 10000);",
    to:   "    const bps = intField('tgeBps', 65535);",
    run: JS(OG),
    expect: "행 결함 \"tgeBps 10001\" 은 배포 전에 거부된다",
  },
  {
    name: "10차: loadSchedule 이 퇴화 행을 받아들인다",
    file: CC,
    from: "    if (cliff === 0 && linear === 0 && bps !== 10000) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "행 결함 \"cliff 0 · linear 0 · bps 5000\" 은 배포 전에 거부된다",
  },
  {
    name: "10차: loadSchedule 이 120개월 초과를 받아들인다",
    file: CC,
    from: "    if (cliff + linear > 120) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "행 결함 \"cliff 60 + linear 61\" 은 배포 전에 거부된다",
  },
  {
    name: "10차: loadSchedule 이 0x0 수혜자를 받아들인다",
    file: CC,
    from: "    if (/^0x0{40}$/.test(r.beneficiary) && !allowPlaceholders) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "행 결함 \"zero beneficiary\" 은 배포 전에 거부된다",
  },
  {
    name: "10차: deploy-claim 이 베스팅 뒤에 claim 을 배포한다",
    file: DCL,
    from: "  if (vesting) {\n    const v = at('HCOWVesting', vesting, provider);",
    to:   "  if (false) {\n    const v = at('HCOWVesting', vesting, provider);",
    run: JS(OG),
    expect: "베스팅이 이미 있으면 첫 claim 도 배포하지 않는다",
  },
  {
    name: "10차: deploy-claim 의 TGE 2일 하한이 다시 사라진다",
    file: DCL,
    from: "  if (tgeFromEnv !== null && mainnet && tgeFromEnv < now + 2 * DAY) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "TGE 36시간 전 claim 배포는 메인넷에서 거부된다 (10차, 9차 B-F4 되돌림)",
  },
  {
    name: "10차: 체인 시계 상한이 365일이 아니다",
    file: DCL,
    from: "    if (tge > chainNow + 365 * DAY) {",
    to:   "    if (tge > chainNow + 36500 * DAY) {",
    run: JS(OG),
    expect: "레코드 tgeTime 이 체인 시계 +400일이면 거부된다",
  },
  {
    name: "10차: claim 이 묶였는데 REPLACE_TOKEN 을 허용한다",
    file: DT,
    from: "  if (recorded && boundToOld.length) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "claim 이 옛 토큰에 묶였으면 REPLACE_TOKEN=1 도 거부된다",
  },
  {
    name: "10차: seal.cjs 가 treasury 누락에서 TypeError 를 낸다",
    file: SL,
    from: "  if (!rec.treasury || !ethers.isAddress(rec.treasury)) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "seal.cjs 는 treasury 가 없으면 그 이름을 말한다",
  },
  {
    name: "10차: seal.cjs 가 서명자를 트레저리와 대조하지 않는다",
    file: SL,
    from: "  if (from.toLowerCase() !== treasury.toLowerCase()) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "seal.cjs 는 소유자가 아닌 키로 봉인하지 않는다",
  },
  {
    name: "10차: seal.cjs 가 이미 봉인됐는지 보지 않는다",
    file: SL,
    from: "  ok('the contract is not already sealed', isSealed === false);",
    to:   "  ok('the contract is not already sealed', true);",
    run: JS(OG),
    expect: "봉인된 컨트랙트에 대해 seal.cjs 를 다시 돌리면 거부된다",
  },
  {
    name: "10차: seal.cjs 가 행을 대조하지 않는다",
    file: SL,
    from: "  ok('every row on chain matches the file', rowBad === 0,",
    to:   "  ok('every row on chain matches the file', true,",
    run: JS(OG),
    expect: "스케줄 파일이 체인과 1 wei 라도 다르면 seal.cjs 가 거부한다",
  },
  {
    name: "10차: release.cjs 보고 모드가 불일치에 exit 0",
    file: RL,
    from: "  if (!tgeMatch) process.exitCode = 1;",
    to:   "  if (false) process.exitCode = 1;",
    run: JS(OG),
    expect: "보고 모드도 TGE 언락 불일치에 exit 1 이다 (10차)",
  },
  {
    name: "10차: set-root 가 --claim 과 레코드를 대조하지 않는다",
    file: SR,
    from: "  if (o.claim && recordedClaim && o.claim.toLowerCase() !== recordedClaim.toLowerCase()) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "--claim 이 레코드의 HCOWClaim 과 다르면 거부된다",
  },
  {
    name: "10차: check 9 소수 정규식이 끝을 고정하지 않는다",
    file: BM,
    from: "    const m = /^(\\d+)\\.(\\d{1,18})$/.exec(raw);",
    to:   "    const m = /^(\\d+)\\.(\\d{1,18})/.exec(raw);",
    run: JS(BG),
    expect: "소수 뒤에 지수가 붙으면 거부된다 (10차)",
  },
  {
    name: "11차: set-root 가 베스팅이 풀어줄 양을 세지 않는다 (0번 라운드 등록 불가)",
    file: SR,
    from: "  if (held + pending < total) {",
    to:   "  if (held < total) {",
    run: JS(OG),
    expect: "0번 라운드(TGE 개시)가 ALLOW_UNDERFUNDED 없이 등록된다 — 베스팅이 그때 풀어줄 양을 센다 (11차)",
  },
  {
    name: "11차: set-root 가 봉인 전에도 베스팅 몫을 센다",
    file: SR,
    from: "    if (vSealed && sched && sched.exists) {",
    to:   "    if (sched && sched.exists) {",
    run: JS(OG),
    expect: "봉인 전에는 베스팅이 풀어줄 양을 세지 않아 0번 라운드가 거부된다 (11차)",
  },
  {
    name: "11차: deploy-claim 이 notice 와 TGE 간격을 보지 않는다",
    file: DCL,
    from: "    if (mainnet && tge - now < needAhead) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "TGE 3일 전 · notice 72시간이면 0번 라운드를 TGE 에 열 수 없어 거부된다",
  },
  {
    name: "11차: 메인넷 deploy.cjs 가 기록된 claim 없이 진행한다",
    file: DEP,
    from: "    if (mainnet && !recordedClaim) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "메인넷에서 claim 이 기록되지 않았으면 거부된다",
  },
  {
    name: "11차: claim 이 Airdrop 이 아닌 행에 있어도 받아들인다",
    file: DEP,
    from: "          if (claimRows.length !== 1 || !isClaim(airdropRows[0])) {",
    to:   "          if (false) {",
    run: JS(OG),
    expect: "claim 이 Airdrop 이 아닌 행에 있으면 거부된다",
  },
  {
    name: "11차: Airdrop 라벨 행이 둘이어도 받아들인다",
    file: DEP,
    from: "          if (airdropRows.length !== 1) {",
    to:   "          if (false) {",
    run: JS(OG),
    expect: "Airdrop 라벨 행이 둘이면 거부된다",
  },
  {
    name: "11차: deploy.cjs 가 claim notice 와 TGE 간격을 보지 않는다",
    file: DEP,
    from: "        if (mainnet && tge - nowWall < needAhead) {",
    to:   "        if (false) {",
    run: JS(OG),
    expect: "claim 의 notice 가 TGE 까지 남은 시간보다 길면 거부된다",
  },
  {
    name: "11차: deploy.cjs 가 TREASURY_ADDRESS 를 레코드와 대조하지 않는다",
    file: DEP,
    from: "    if (record.treasury && record.treasury.toLowerCase() !== treasury.toLowerCase()) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "TREASURY_ADDRESS 가 레코드의 treasury 와 다르면 거부된다",
  },
  {
    name: "11차: 메인넷에서 코드 없는 claim 을 받아들인다",
    file: DEP,
    from: "      if (claimCode === '0x') {",
    to:   "      if (false) {",
    run: JS(OG),
    expect: "메인넷에서 코드 없는 claim 이 기록돼 있으면 거부된다",
  },
  {
    name: "11차: anchor.cjs 가 ANCHOR_ADDRESS 를 레코드와 대조하지 않는다",
    file: ACH,
    from: "  if (process.env.ANCHOR_ADDRESS && recordedAnchor &&",
    to:   "  if (false && recordedAnchor &&",
    run: JS(OG),
    expect: "anchor.cjs 는 ANCHOR_ADDRESS 가 레코드와 다르면 거부한다",
  },
  {
    name: "11차: REPLACE_ANCHOR 가 레코드 부재 가드를 다시 푼다",
    file: DAN,
    from: "  if (!existing && process.env.FIRST_DEPLOY !== '1' && !dryRun) {",
    to:   "  if (!existing && process.env.REPLACE_ANCHOR !== '1' && process.env.FIRST_DEPLOY !== '1' && !dryRun) {",
    run: JS(OG),
    expect: "REPLACE_ANCHOR=1 은 레코드 부재 가드를 풀지 않는다",
  },
  {
    name: "11차: HCOW_RECORD_DIR 를 실제 체인에서도 받아들인다",
    file: CN,
    from: "  if (!loopback) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "HCOW_RECORD_DIR 는 실제 체인 RPC 와 함께면 거부된다 (11차)",
  },
  {
    name: "11차: release.cjs 보고 모드가 TGE 전에 대조 없이 돌아간다",
    file: RL,
    from: "  // What the table pays at exactly tgeTime, computed from the file.",
    to:   "  if (now < tgeTime) return;\n  // What the table pays at exactly tgeTime, computed from the file.",
    run: JS(OG),
    expect: "TGE 전에도 release.cjs 보고 모드가 TGE 언락을 스케줄과 대조한다 (11차)",
  },
  {
    name: "11차: load.cjs 가 Safe 에서 불가능한 확인 방법을 다시 안내한다",
    file: LD,
    from: "    console.log('then confirm with `DRY_RUN=yes node scripts/seal.cjs`: it compares every row on chain');",
    to:   "    console.log('then re-run without PRINT_ONLY to verify every row on chain');",
    run: JS(OG),
    expect: "load.cjs PRINT_ONLY=yes 는 Safe 에서 실제로 할 수 있는 확인 방법을 안내한다 (11차)",
  },
  {
    name: "12차: deploy-token 이 앵커만 적힌 레코드를 '처음이 아니다' 로 받는다",
    file: DT,
    from: "  if (!recorded && process.env.FIRST_DEPLOY !== '1' && !dryRun) {",
    to:   "  if (!priorRecord && process.env.FIRST_DEPLOY !== '1' && !dryRun) {",
    run: JS(DTT),
    expect: "앵커만 적힌 레코드로는 FIRST_DEPLOY 없이 토큰을 발행하지 않는다 (12차)",
  },
  {
    name: "12차: deploy-token 이 EXPECT_SUPPLY 를 배포 뒤에만 대조한다",
    file: DT,
    from: "  if (expectSupply !== null && expectSupply !== CANONICAL_SUPPLY) {",
    to:   "  if (false) {",
    run: JS(DTT),
    expect: "a supply one token out is caught before deploying (12차)",
  },
  {
    name: "12차: deploy-claim 이 앵커만 적힌 레코드를 '처음이 아니다' 로 받는다",
    file: DCL,
    from: "  if (!recordNamesToken && !dryFlag('FIRST_DEPLOY') && !dryRun) {",
    to:   "  if (!priorRecord && !dryFlag('FIRST_DEPLOY') && !dryRun) {",
    run: JS(OG),
    expect: "deploy-claim 은 앵커만 적힌 레코드로 FIRST_DEPLOY 없이 배포하지 않는다 (12차)",
  },
  {
    name: "12차: deploy.cjs 테스트넷이 앵커만 적힌 레코드로 새 토큰을 발행한다",
    file: DEP,
    from: "  if (!process.env.HCOW_ADDRESS && !recordedToken && priorRecord !== null &&",
    to:   "  if (false &&",
    run: JS(OG),
    expect: "deploy.cjs 도 앵커만 적힌 레코드로 새 토큰을 발행하지 않는다 (12차)",
  },
  {
    name: "12차: deploy.cjs 가 공표 수치와 행 계산값을 대조하지 않는다",
    file: DEP,
    from: "      } else if (BigInt(String(v).trim()) !== BigInt(got)) {",
    to:   "      } else if (false) {",
    run: JS(OG),
    expect: "Airdrop 행 조건이 바뀌었는데 공표 수치가 그대로면 메인넷 배포가 거부된다 (12차)",
  },
  {
    name: "12차: deploy.cjs 가 공표 수치가 없어도 진행한다",
    file: DEP,
    from: "      if (v === undefined || v === null || !/^\\d+$/.test(String(v).trim())) {",
    to:   "      if (false) {",
    run: JS(OG),
    expect: "메인넷에서 공표 TGE 언락 수치가 없으면 거부된다 (12차)",
  },
  {
    name: "12차: deploy.cjs 가 claim 행 종료와 마지막 개시 가능 시점을 비교하지 않는다",
    file: DEP,
    from: "          if (vestEnd > lastStart) {",
    to:   "          if (false) {",
    run: JS(OG),
    expect: "claim 행 종료가 기한 − 창보다 늦으면 메인넷 배포가 거부된다 (12차)",
  },
  {
    name: "12차: deploy-claim 이 기한 − 창과 TGE 를 비교하지 않는다",
    file: DCL,
    from: "  if (mainnet && tge && tge > deadline - window) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "deploy-claim 은 기한 − 창이 TGE 보다 이르면 거부한다 (12차 L-3)",
  },
  {
    name: "12차: deploy-claim 이 코드 없는 기록 claim 을 조용히 덮어쓴다",
    file: DCL,
    from: "  if (recordedClaim) {",
    to:   "  if (recordedClaim && recordedClaimCode !== '0x') {",
    run: JS(OG),
    expect: "코드 없는 기록 claim 은 REPLACE_CLAIM 없이 덮어쓰지 않는다 (12차)",
  },
  {
    name: "12차: deploy-claim 이 교체한 claim 을 abandoned 에 남기지 않는다",
    file: DCL,
    from: "    ...(recordedClaim ? { abandoned:",
    to:   "    ...(false ? { abandoned:",
    run: JS(OG),
    expect: "대조군: REPLACE_CLAIM=yes 면 교체하고 옛 주소를 abandoned 에 남긴다 (12차)",
  },
  {
    name: "12차: HCOW_RECORD_DIR 를 하네스가 아닌 루프백 노드에서도 받는다",
    file: CN,
    from: "    if (!harness) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "루프백이지만 하네스가 아닌 노드에서는 HCOW_RECORD_DIR 를 받지 않는다 (12차)",
  },
  {
    name: "12차: set-root 가 라운드 누계를 보지 않는다",
    file: SR,
    from: "    if (have < need) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "앞 라운드와 합친 누계가 넘치면 1번 라운드가 거부된다 (12차)",
  },
  {
    name: "12차: set-root 가 앞 라운드 합계를 누계에 더하지 않는다",
    file: SR,
    from: "    included.push({ roundId: r.roundId, start, total: rTotal, registered });",
    to:   "    included.push({ roundId: r.roundId, start, total: 0n, registered });",
    run: JS(OG),
    expect: "앞 라운드와 합친 누계가 넘치면 1번 라운드가 거부된다 (12차)",
  },
  {
    name: "12차: set-root 가 직접 송금 하한을 부풀린다",
    file: SR,
    from: "      directFloor = held > sched.released ? held - sched.released : 0n;",
    to:   "      directFloor = 10n ** 24n;",
    run: JS(OG),
    expect: "앞 라운드와 합친 누계가 넘치면 1번 라운드가 거부된다 (12차)",
  },
  {
    name: "12차: set-root 가 등록된 앞 라운드 루트를 체인과 대조하지 않는다",
    file: SR,
    from: "    if (registered && onRoot !== fileRoot) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "이미 열린 앞 라운드의 루트가 파일과 다르면 거부된다 (14차)",
  },
  {
    name: "13차: deploy-anchor 가 토큰만 적힌 레코드를 '처음이 아니다' 로 받는다",
    file: DAN,
    from: "  if (!existing && process.env.FIRST_DEPLOY !== '1' && !dryRun) {",
    to:   "  if (!priorRecord && process.env.FIRST_DEPLOY !== '1' && !dryRun) {",
    run: JS(OG),
    expect: "deploy-anchor 는 토큰만 적힌 레코드로 FIRST_DEPLOY 없이 배포하지 않는다 (13차)",
  },
  {
    name: "13차: set-root 가 뒤에 이미 등록된 라운드 시점을 보지 않는다",
    file: SR,
    from: "  const checkpoints = included.filter((x) => x.start >= tree.startTime && (x.self || x.registered));",
    to:   "  const checkpoints = included.filter((x) => x.self);",
    run: JS(OG),
    expect: "끼운 라운드 때문에 뒤에 이미 등록된 라운드가 넘치면 거부된다 (13차)",
  },
  {
    name: "13차: set-root 가 등록된 라운드의 시각을 파일에서 읽는다",
    file: SR,
    from: "      start = Number(oc.startTime);",
    to:   "      start = Number(r.startTime);",
    run: JS(OG),
    expect: "파일과 다른 시각으로 등록된 라운드는 체인의 시각으로 센다 (13차)",
  },
  {
    name: "13차: set-root 가 베스팅 수치 없을 때 누계를 무시한다",
    file: SR,
    from: "      need = upTo.filter((x) => x.start > nowTs).reduce((a, x) => a + x.total, 0n);",
    to:   "      need = 0n;",
    run: JS(OG),
    expect: "베스팅 수치가 없으면 잔고가 아직 열리지 않은 라운드 합계를 덮는지 본다 (13차)",
  },
  {
    name: "13차: set-root 가 등록할 수 없게 된 라운드도 빚으로 센다",
    file: SR,
    from: "      if (start <= nowTs + notice) {",
    to:   "      if (false) {",
    run: JS(OG),
    expect: "등록할 수 없게 된 미등록 라운드는 누계에 넣지 않는다 (13차)",
  },
  {
    name: "14차: set-root 가 이미 열린 라운드의 루트 불일치도 경고로 넘긴다",
    file: SR,
    from: "      if (Number(oc.startTime) <= nowTs) {",
    to:   "      if (false) {",
    run: JS(OG),
    expect: "이미 열린 앞 라운드의 루트가 파일과 다르면 거부된다 (14차)",
  },
  {
    name: "14차: set-root 가 교체 전 라운드를 경고하지 않는다",
    file: SR,
    from: "  if (staleRounds.length) {",
    to:   "  if (false) {",
    run: JS(OG),
    expect: "대조군: 아직 열리지 않은 0번의 루트가 다르면 경고하고 파일 판으로 센다 (14차)",
  },
  {
    name: "14차: set-root 가 다른 라운드 파일의 claims 를 루트와 대조하지 않는다",
    file: SR,
    from: "    if (rb.root.toLowerCase() !== fileRoot) {",
    to:   "    if (false) {",
    run: JS(OG),
    expect: "다른 라운드 파일의 claims 가 루트와 맞지 않으면 거부된다 (14차)",
  },
  {
    name: "15차: set-root 가 교체할 수 없게 된 라운드를 파일 판으로 센다",
    file: SR,
    from: "      if (Number(oc.startTime) - nowTs < LEAD || Number(r.startTime) - nowTs < LEAD) {",
    to:   "      if (false) {",
    run: JS(OG),
    expect: "교체할 시간이 남지 않은 앞 라운드의 루트가 파일과 다르면 거부된다 (15차)",
  },
  {
    name: "15차: set-root 가 교체 전 라운드를 누계에서 뺀다",
    file: SR,
    from: "    included.push({ roundId: r.roundId, start, total: rTotal, registered });",
    to:   "    if (!stale) included.push({ roundId: r.roundId, start, total: rTotal, registered });",
    run: JS(OG),
    expect: "교체 전 라운드의 파일 판이 누계를 넘치게 하면 거부된다 (15차)",
  },
  {
    name: "16차: set-root 의 교체 불가 조건에서 파일 시작 쪽이 빠진다",
    file: SR,
    from: "      if (Number(oc.startTime) - nowTs < LEAD || Number(r.startTime) - nowTs < LEAD) {",
    to:   "      if (Number(oc.startTime) - nowTs < LEAD) {",
    run: JS(OG),
    expect: "파일의 시작이 LEAD 안이면 교체 전 라운드를 셀 수 없어 거부된다 (16차)",
  },
  {
    name: "16차: set-root 의 교체 불가 조건에서 체인 시작 쪽이 빠진다",
    file: SR,
    from: "      if (Number(oc.startTime) - nowTs < LEAD || Number(r.startTime) - nowTs < LEAD) {",
    to:   "      if (Number(r.startTime) - nowTs < LEAD) {",
    run: JS(OG),
    expect: "교체할 시간이 남지 않은 앞 라운드의 루트가 파일과 다르면 거부된다 (15차)",
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
    // 10차 감사. JS() 뮤테이션은 컴파일하지 않고, 이 finally 는 소스만 복원했다.
    // 그래서 .sol 뮤테이션 다음의 모든 JS 뮤테이션은 방금 변이된 바이트코드 위에서
    // 돌았다 (재현: 복원 뒤에도 artifact 해시가 변이된 값으로 남았다). .sol 을
    // 건드렸으면 복원 직후 다시 컴파일한다.
    if (m.file.endsWith('.sol')) {
      // 11차 감사: 실패를 삼켰다. 재컴파일이 실패하면 다음 JS 뮤테이션들이 다시
      // 변이된 바이트코드 위에서 돈다 — 10차가 고친 결함이 경고 없이 돌아온다.
      try {
        execSync('node compile.cjs', { cwd: ROOT, stdio: 'ignore' });
      } catch (_) {
        console.error(`compile.cjs FAILED after restoring ${m.file}. Stopping: every later result would be wrong.`);
        process.exit(2);
      }
    }
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
// 11차 감사: 필터 오타는 "0 of 0 mutations caught" 로 exit 0 이었다.
if (chosen.length === 0) {
  console.error(`no mutation name contains ${JSON.stringify(filter)}. Nothing was tested.`);
  fs.rmSync(SENTINEL, { force: true });
  process.exit(1);
}

// 10차 감사. 기준선. 이전 판은 변이된 상태로만 스위트를 돌렸다. 이름 붙은 단언이
// 원래부터 실패하고 있으면(이 저장소에는 벽시계에 의존하는 테스트가 많다) 그
// 뮤테이션은 아무 증거 없이 CAUGHT 로 보고됐다. 이제 선택된 뮤테이션이 쓰는
// 스위트를 변이 없이 한 번씩 돌려, 각 단언이 **PASS 줄로** 나오는지 먼저 본다.
// 그렇지 않은 뮤테이션은 BASELINE 으로 보고하고 실패로 센다.
const baseline = new Map();
for (const cmd of Array.from(new Set(chosen.map((m) => m.run)))) {
  process.stdout.write(`baseline: ${cmd}\n`);
  let out = '';
  try {
    out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  baseline.set(cmd, out);
}
const passedAtBaseline = (m) => new RegExp(
  '(PASS|ok)\\s+' + m.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(baseline.get(m.run) || '');

const results = chosen.map((m) => {
  process.stdout.write(`... ${m.name}\n`);
  if (!passedAtBaseline(m)) {
    const r = { name: m.name, status: 'BASELINE', detail: `"${m.expect}" is not a PASS line when nothing is mutated` };
    console.log(`    ${r.status}  ${r.detail}`);
    return r;
  }
  const r = run(m);
  console.log(`    ${r.status}  ${r.detail}`);
  return r;
});
console.log('');
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.status.padEnd(17)} ${r.name.padEnd(w)}`);
const bad = results.filter((r) => r.status !== 'CAUGHT');
console.log(`\n${results.length - bad.length} of ${results.length} mutations caught`);
// 복원 확인. 10차 감사: 이전 판은 `includes(from)` 만 봤다. 낡은 뮤테이션이
// 하나라도 있으면 거짓 "RESTORE FAILED" 로 exit 2 가 났고, 파일이 실제로 원래와
// 같은지는 보지 않았다. 이제 실행 전에 떠 둔 백업과 바이트 단위로 비교한다.
for (const f of guardedFiles()) {
  const now = fs.readFileSync(path.join(ROOT, f));
  const was = fs.readFileSync(path.join(BACKUP, backupName(f)));
  if (!now.equals(was)) {
    console.error(`RESTORE FAILED: ${f} differs from the copy taken before the run (${path.join(BACKUP, backupName(f))})`);
    process.exit(2);
  }
}
// Rebuild from the restored sources. The artifacts on disk are otherwise those
// of the last mutation, and the next thing anyone runs - checkflat, which gates
// BscScan verification - reports a false mismatch against them.
try { execSync('node compile.cjs', { cwd: ROOT, stdio: 'ignore' }); } catch (_) {}
fs.rmSync(SENTINEL, { force: true });
console.log('all sources restored and rebuilt');
process.exit(bad.length ? 1 : 0);
