'use strict';
/* The guards added after the fourth adversarial audit (2026-09-18), each one
 * exercised against the REAL operator script running as a child process
 * against an in-process chain.
 *
 * Why this file exists at all. Every finding it covers was of the same shape:
 * a script that printed something reassuring while checking nothing, or a
 * check that existed in a sibling script and not in this one. None of them
 * were reachable by the contract test suites, because none of them are in a
 * contract. A guard with no test is a guard that will be deleted by the next
 * person who finds it inconvenient.
 *
 * Each case asserts on the ERROR NAME OR PHRASE, not merely that the script
 * exited non-zero. Several guards stand in a row and "it failed" is satisfied
 * by any of them, which is how a guard passes its own test for the wrong
 * reason.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { boot, run, dep, ROOT, KEY_DEPLOY, KEY_TREASURY, KEY_OTHER } = require('./harness/fixture.cjs');

const NOW = 1900000000, DAY = 86400, E = 10n ** 18n;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const says = (r, needle, m) => ok(r.status !== 0 && r.out.includes(needle),
  r.status !== 0 && r.out.includes(needle) ? m : `${m}\n        status ${r.status}, output:\n${r.out.split('\n').map((l) => '        | ' + l).join('\n')}`);

const recPath = (c) => path.join(ROOT, 'deployments', `${c}.json`);
const clearRec = () => fs.rmSync(path.join(ROOT, 'deployments'), { recursive: true, force: true });
const readRec = (c) => JSON.parse(fs.readFileSync(recPath(c), 'utf8'));
const writeRec = (c, o) => {
  fs.mkdirSync(path.dirname(recPath(c)), { recursive: true });
  fs.writeFileSync(recPath(c), JSON.stringify(o, null, 2));
};
const hasRec = (c) => fs.existsSync(recPath(c));

// The treasury has to be a contract: deploy-claim.cjs refuses an EOA owner on
// mainnet, and every case past that guard needs to get past it.
async function stage({ chainId = 56 } = {}) {
  const f = await boot({ chainId, now: NOW });
  const safe = await dep('MockSafe', f.deployer, [await f.treasury.getAddress()]);
  const treasury = await safe.getAddress();
  const tk = await dep('HCOWToken', f.deployer, [treasury]);
  const token = await tk.getAddress();
  writeRec(chainId, { chainId, treasury, tgeTime: NOW + 30 * DAY, addresses: { HCOWToken: token } });
  return { f, tk, token, treasury, chainId, safe };
}
const env = (s) => ({
  RPC_URL: s.f.node.url, CHAIN_ID: String(s.chainId), DEPLOYER_KEY: KEY_DEPLOY,
  HCOW_ADDRESS: s.token, CLAIM_OWNER: s.treasury, CLAIM_DEADLINE: String(NOW + 800 * DAY), CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000',
});

(async () => {
  console.log('\ndeploy-claim.cjs — dry run (audit 4, C-1)\n');
  {
    clearRec();
    const s = await stage();
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      const r = await run('deploy-claim.cjs', { ...env(s), [flag]: 'yes' });
      ok(r.status === 0, `${flag}=yes exits 0`);
      ok(r.out.includes('DRY RUN'), `${flag}=yes says DRY RUN`);
      ok(!readRec(56).addresses.HCOWClaim, `${flag}=yes writes no HCOWClaim address`);
    }
    // The defect: both names were ignored and the contract deployed for real.
    const live = await run('deploy-claim.cjs', env(s));
    ok(live.status === 0 && !!readRec(56).addresses?.HCOWClaim, 'without either flag it does deploy');
  }

  console.log('\ndry-run flags fail closed on a typo (audit 4, C-2)\n');
  {
    clearRec();
    const s = await stage();
    for (const v of ['1', 'true', 'y', 'on']) {
      const r = await run('deploy-claim.cjs', { ...env(s), PRINT_ONLY: v });
      ok(r.status === 0 && r.out.includes('DRY RUN') && !readRec(56).addresses.HCOWClaim,
        `PRINT_ONLY=${v} is a dry run too, not a live deploy`);
    }
    const bad = await run('deploy-claim.cjs', { ...env(s), PRINT_ONLY: 'maybe' });
    says(bad, 'Refusing to guess', 'PRINT_ONLY=maybe refuses rather than deploying');
    ok(!readRec(56).addresses.HCOWClaim, 'and deployed nothing');
  }

  console.log('\ndeploy-claim.cjs — rerun guard (audit 4, C-3)\n');
  {
    clearRec();
    const s = await stage();
    const first = await run('deploy-claim.cjs', env(s));
    ok(first.status === 0, 'first deploy succeeds');
    const addr1 = readRec(56).addresses.HCOWClaim;

    const second = await run('deploy-claim.cjs', env(s));
    says(second, 'already deployed', 'a second run is refused');
    ok(readRec(56).addresses.HCOWClaim === addr1, 'and the first address is still the recorded one');

    const forced = await run('deploy-claim.cjs', { ...env(s), REPLACE_CLAIM: 'yes' });
    ok(forced.status === 0 && readRec(56).addresses.HCOWClaim !== addr1,
      'REPLACE_CLAIM=yes is the deliberate escape hatch and does replace it');
  }

  console.log('\ndeploy-claim.cjs — a missing record is not proof of a first deploy (audit 4, C-3)\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: NOW });
    const safe = await dep('MockSafe', f.deployer, [await f.treasury.getAddress()]);
    const treasury = await safe.getAddress();
    const tk = await dep('HCOWToken', f.deployer, [treasury]);
    const s = { f, token: await tk.getAddress(), treasury, chainId: 56 };
    ok(!hasRec(56), 'no deployments record exists');
    const r = await run('deploy-claim.cjs', env(s));
    says(r, 'FIRST_DEPLOY', 'it refuses and names the flag');
    const y = await run('deploy-claim.cjs', { ...env(s), FIRST_DEPLOY: 'yes' });
    ok(y.status === 0, 'FIRST_DEPLOY=yes proceeds');
  }

  console.log('\ndeploy-claim.cjs — token identity (audit 4, C-4)\n');
  {
    clearRec();
    const s = await stage();
    const decoy = await dep('DecoyToken', s.f.deployer, []);
    const decoyAddr = await decoy.getAddress();

    // The decoy is a real ERC20 with 18 decimals. Decimals was the only thing
    // the old script checked, so it passed.
    const r = await run('deploy-claim.cjs', { ...env(s), HCOW_ADDRESS: decoyAddr });
    says(r, 'not "HCOW"', 'an 18-decimal USDT decoy is refused by symbol');
    ok(!readRec(56).addresses?.HCOWClaim, 'and nothing was deployed against it');

    // A decoy that got the name right. The symbol check has nothing to say
    // about this one; the fixed supply is what gives it away.
    const liar = await dep('WrongSupplyHCOW', s.f.deployer, []);
    const rs = await run('deploy-claim.cjs', { ...env(s), HCOW_ADDRESS: await liar.getAddress() });
    says(rs, 'not 200,000,000', 'a contract calling itself HCOW with the wrong supply is refused');

    // A record that already names a token is authoritative for seal.cjs and
    // release.cjs. Silently replacing it is how the authoritative value
    // becomes the unverified one.
    const other = await dep('HCOWToken', s.f.deployer, [s.treasury]);
    const r2 = await run('deploy-claim.cjs', { ...env(s), HCOW_ADDRESS: await other.getAddress() });
    says(r2, 'already names HCOWToken', 'a token that disagrees with the record is refused');

    const good = await run('deploy-claim.cjs', env(s));
    ok(good.status === 0, 'the recorded HCOW token itself is accepted');
    ok(good.out.includes('supply 200000000.0'), 'and the supply is printed, having been checked');
  }

  console.log('\ndeploy-claim.cjs — the owner (audit 4, H-6)\n');
  {
    clearRec();
    const s = await stage();
    // A different Safe: has code, so the EOA guard has nothing to say. The only
    // objection left is that the record names a different treasury.
    const otherSafe = await dep('MockSafe', s.f.deployer, [await s.f.other.getAddress()]);
    const r = await run('deploy-claim.cjs', { ...env(s), CLAIM_OWNER: await otherSafe.getAddress() });
    says(r, 'records the treasury as', 'an owner that is not the recorded treasury is refused on mainnet');

    // An EOA, with the record agreeing that it is the treasury. The remaining
    // objection is that it has no code, and that is now a stop, not a warning.
    const eoa = await s.f.other.getAddress();
    writeRec(56, { ...readRec(56), treasury: eoa });
    const r2 = await run('deploy-claim.cjs', { ...env(s), CLAIM_OWNER: eoa });
    says(r2, 'externally owned account', 'an EOA owner is refused on mainnet');
    const r3 = await run('deploy-claim.cjs', { ...env(s), CLAIM_OWNER: eoa, ALLOW_EOA_OWNER: 'yes' });
    ok(r3.status === 0, 'ALLOW_EOA_OWNER=yes is the deliberate escape hatch');
  }

  console.log('\ndeploy-claim.cjs — what already worked, still works\n');
  {
    clearRec();
    const s = await stage();
    const r = await run('deploy-claim.cjs', { ...env(s), CLAIM_DEADLINE: String(NOW + 800 * DAY * 1000) });
    says(r, 'more than 10 years out', 'a millisecond deadline is still refused');
    const r2 = await run('deploy-claim.cjs', { ...env(s), CLAIM_OWNER: (await (new ethers.Wallet(KEY_DEPLOY)).getAddress()) });
    says(r2, 'CLAIM_OWNER is the deploy key', 'the deploy key as owner is still refused');
  }

  console.log('\nset-root.cjs — the repeated, irreversible call\n');
  {
    clearRec();
    // This section needs an owner that can actually sign, and a token holder
    // that can actually transfer, so the treasury here is the EOA rather than
    // the MockSafe the other sections use.
    const f = await boot({ chainId: 56, now: NOW });
    const treasury = await f.treasury.getAddress();
    const tk = await dep('HCOWToken', f.deployer, [treasury]);
    const token = await tk.getAddress();
    writeRec(56, { chainId: 56, treasury, tgeTime: NOW + 30 * DAY, addresses: { HCOWToken: token } });
    const s = { f, tk, token, treasury, chainId: 56 };

    const dep1 = await run('deploy-claim.cjs', { ...env(s), ALLOW_EOA_OWNER: 'yes' });
    ok(dep1.status === 0, 'a claim contract is deployed for these cases');
    const claimAddr = readRec(56).addresses.HCOWClaim;

    // A one-entry tree, written by hand in the shape build-merkle.cjs emits.
    const { buildRound } = require('../scripts/merkle.cjs');
    const dir = path.join(ROOT, 'build', 'test-merkle');
    const writeTree = (startTime, amount) => {
      const t = buildRound(0, [{ account: '0x' + '44'.repeat(20), amount: String(amount) }]);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'round-0.json'),
        JSON.stringify({ roundId: 0, merkleRoot: t.root, startTime, count: t.count, total: t.total, claims: t.claims }, null, 2));
      fs.writeFileSync(path.join(dir, 'rounds.json'),
        JSON.stringify({ rounds: [{ roundId: 0, merkleRoot: t.root, startTime, count: t.count, total: t.total }] }, null, 2));
    };
    const setroot = (extra = {}) => run('set-root.cjs', {
      RPC_URL: s.f.node.url, CHAIN_ID: '56', TREASURY_KEY: KEY_TREASURY, ...extra,
    }, ['--rounds', path.join(dir, 'rounds.json'), '--round', '0']);

    // H-9: the README said this script checks the contract holds enough. It
    // was a console.log and the transaction went out underneath it.
    writeTree(NOW + 10 * DAY, 1000n * E);
    const under = await setroot();
    says(under, 'the contract holds', 'an underfunded round is refused, not warned about');
    const under2 = await setroot({ ALLOW_UNDERFUNDED: 'yes' });
    ok(under2.status === 0, 'ALLOW_UNDERFUNDED=yes is the deliberate escape hatch');

    // Fund it so the balance stops being the objection.
    const tx = await s.tk.connect(s.f.treasury).transfer(claimAddr, 5000n * E);
    await tx.wait();

    // M-11: the normal path prints calldata for a Safe that executes later.
    // A round that is barely ahead at preparation time can be behind at
    // execution time, and the old check only looked at preparation time.
    writeTree(NOW + 600, 1000n * E);
    const lead = await setroot();
    says(lead, 'less than the', 'a round opening in ten minutes is refused');

    // And the margin cannot be set below what the contract itself enforces —
    // that would only produce a call the chain rejects days later.
    const below = await setroot({ LEAD_SECONDS: '60' });
    says(below, "contract's minRoundNotice", 'a margin under the on-chain notice is refused by the script');

    writeTree(NOW + 5 * DAY, 1000n * E);
    const lead2 = await setroot({ LEAD_SECONDS: String(4 * DAY) });
    ok(lead2.status === 0, 'above the notice, LEAD_SECONDS is a deliberate choice');

    // M-10: a millisecond timestamp is ~year 62178. The contract accepts it
    // and the round then never opens.
    writeTree((NOW + 10 * DAY) * 1000, 1000n * E);
    const ms = await setroot();
    says(ms, 'sanity bound', 'a millisecond startTime is refused');

    // C-2: PRINT_ONLY=1 used to send a live setRoot.
    writeTree(NOW + 10 * DAY, 1000n * E);
    const p1 = await setroot({ PRINT_ONLY: '1' });
    ok(p1.status === 0 && p1.out.includes('data   0x') && !p1.out.includes('tx 0x'),
      'PRINT_ONLY=1 prints calldata and sends nothing');
    const pbad = await setroot({ PRINT_ONLY: 'yep' });
    says(pbad, 'Refusing to guess', 'PRINT_ONLY=yep refuses rather than sending');

    // The documented path: the key running the script is NOT the owner,
    // because the owner is a Safe and its key is not available to a script.
    // Printing calldata for it is the whole reason PRINT_ONLY exists, so the
    // owner check has to be the thing PRINT_ONLY suppresses -- in every
    // spelling, not just the literal 'yes'.
    const notOwner = await setroot({ PRINT_ONLY: '1', TREASURY_KEY: KEY_DEPLOY });
    ok(notOwner.status === 0 && notOwner.out.includes('data   0x'),
      'PRINT_ONLY=1 with a non-owner key prints calldata instead of demanding the owner key');
    const notOwnerLive = await setroot({ TREASURY_KEY: KEY_DEPLOY });
    says(notOwnerLive, 'Use PRINT_ONLY', 'and without it, a non-owner key is still refused');

    // ---- 7차 감사 H-3. 이 스크립트는 DRY_RUN 을 몰랐다 ------------------
    //
    // deploy-token · deploy-claim · seal 은 DRY_RUN 과 PRINT_ONLY 를 둘 다
    // 받는다. 이 파일은 PRINT_ONLY 만 받았고 DRY_RUN 은 정의되지 않은 환경
    // 변수로 조용히 무시했다. 리허설이라 믿고 친 명령이 루트를 실제로
    // 등록하고, startTime 이 지나면 그 루트는 영원히 고칠 수 없다.
    writeTree(NOW + 30 * DAY, E);
    const claimRead = new ethers.Contract(
      claimAddr, ['function rounds(uint256) view returns (bytes32,uint256)'], s.f.provider);
    const rootNow = async () => (await claimRead.rounds(0))[0];
    // 이 블록의 앞선 케이스들이 이미 round 0 에 루트를 하나 등록해 두었다.
    // 그래서 "0 인가" 가 아니라 "변하지 않았는가" 로 재야 한다.
    const rootBefore = await rootNow();
    const dry = await setroot({ DRY_RUN: 'yes', ALLOW_UNDERFUNDED: 'yes' });
    ok(dry.status === 0 && /data   0x/.test(dry.out), 'DRY_RUN=yes 가 보낼 내용을 출력한다');
    ok(await rootNow() === rootBefore, '그리고 루트를 바꾸지 않는다');
    const dbad = await setroot({ DRY_RUN: 'maybe', ALLOW_UNDERFUNDED: 'yes' });
    says(dbad, 'Refusing to guess', 'DRY_RUN=maybe 는 추측하지 않고 거부한다');
    ok(await rootNow() === rootBefore, '그리고 여전히 바뀌지 않았다');

    // 위 케이스들은 owner 키로 돌기 때문에 owner 검사가 DRY_RUN 을 보는지
    // 아닌지를 구별하지 못한다. 사보타주에서 이 변이가 살아남았다: suppressed()
    // 를 dryFlag('PRINT_ONLY') 로 되돌려도 전 스위트가 초록이었다.
    // 실제 운영은 owner 가 Safe 라 스크립트를 돌리는 키가 owner 가 아니다.
    const dryNotOwner = await setroot({ DRY_RUN: '1', TREASURY_KEY: KEY_DEPLOY, ALLOW_UNDERFUNDED: 'yes' });
    ok(dryNotOwner.status === 0 && /data   0x/.test(dryNotOwner.out),
      'DRY_RUN=1 은 비-owner 키로도 calldata 를 출력한다 — owner 검사도 억제한다');
    ok(await rootNow() === rootBefore, '그리고 루트는 그대로다');

    // ---- 7차 감사 M-3. MAX_AHEAD_SECONDS 가 검증되지 않았다 --------------
    //
    // Number('3650d') 은 NaN 이고 x > NaN 은 항상 false 라, 오타 한 글자가
    // 4차 M-10 의 밀리초 가드를 통째로 끈다. 22줄 위 LEAD_SECONDS 는
    // Number.isInteger 로 검증하는데 이 형제는 하지 않았다.
    writeTree(1900864000000, E);
    const msBase = await setroot({ PRINT_ONLY: 'yes', ALLOW_UNDERFUNDED: 'yes' });
    says(msBase, 'sanity bound', '기준: 밀리초 타임스탬프는 잡힌다');
    for (const v of ['3650d', 'none', '', '-1', '0', 'Infinity', '1.5']) {
      const r = await setroot({ PRINT_ONLY: 'yes', ALLOW_UNDERFUNDED: 'yes', MAX_AHEAD_SECONDS: v });
      says(r, 'MAX_AHEAD_SECONDS', `MAX_AHEAD_SECONDS=${JSON.stringify(v)} 는 가드를 끄지 못한다`);
    }
    // 지수 표기는 모호하지 않고 Number.isInteger 를 통과한다. 거부하지 않는다.
    // 다만 그래도 밀리초 타임스탬프는 여전히 잡혀야 한다 — 거기가 요점이다.
    const expo = await setroot({ PRINT_ONLY: 'yes', ALLOW_UNDERFUNDED: 'yes', MAX_AHEAD_SECONDS: '1e9' });
    says(expo, 'sanity bound', 'MAX_AHEAD_SECONDS=1e9 는 유효한 값이고 가드는 그대로 작동한다');
    const okAhead = await setroot({ PRINT_ONLY: 'yes', ALLOW_UNDERFUNDED: 'yes', MAX_AHEAD_SECONDS: String(3650 * DAY) });
    says(okAhead, 'sanity bound', '유효한 값을 줘도 밀리초 타임스탬프는 여전히 잡힌다');

    fs.rmSync(dir, { recursive: true, force: true });
  }


  // ======================================================================
  // deploy.cjs — 7차 감사 C-1 / C-2 / M-5 / M-6
  //
  // CLAUDE.md 절대규칙 4 가 "메인넷 배포는 scripts/deploy.cjs 로만" 이라고
  // 못박은 파일인데, 4차 감사도 6차 감사도 이 파일을 보지 않았다. 7차에서
  // 처음 보니 형제인 deploy-claim.cjs 가 이미 가진 가드가 통째로 없었다.
  // 여기의 모든 케이스는 에러 문구를 단언한다. "exit != 0" 은 옆에 선 다른
  // 가드가 대신 만족시켜 줄 수 있고, 그게 가드가 자기 테스트를 엉뚱한
  // 이유로 통과하는 방식이다.
  // ======================================================================
  const SCHED = path.join(ROOT, 'build', 'opsguard-sched.json');
  function writeSchedule(totalWei) {
    const names = ['Public', 'Private', 'Seed', 'Airdrop', 'Incentives', 'Ecosystem', 'Foundation', 'Liquidity', 'Team'];
    const per = totalWei / 9n, rem = totalWei - per * 8n;
    fs.mkdirSync(path.dirname(SCHED), { recursive: true });
    fs.writeFileSync(SCHED, JSON.stringify({
      rows: names.map((label, i) => ({
        label,
        beneficiary: ethers.getAddress('0x' + (i + 1).toString(16).padStart(40, '0')),
        total: (i === 8 ? rem : per).toString(),
        tgeBps: 1350, cliffMonths: 0, linearMonths: 12,
      })),
    }, null, 2));
  }
  function commitEnv(tge) {
    const r = require('child_process').spawnSync(process.execPath,
      ['scripts/commitcheck.cjs', SCHED, String(tge)], { cwd: ROOT, encoding: 'utf8' });
    const g = (k) => (r.stdout.match(new RegExp('export ' + k + '=(\\S+)')) || [])[1];
    return {
      EXPECT_BENEFICIARIES: g('EXPECT_BENEFICIARIES'), EXPECT_SCHEDULED: g('EXPECT_SCHEDULED'),
      EXPECT_TGE_UNLOCK: g('EXPECT_TGE_UNLOCK'), EXPECT_HASH: g('EXPECT_HASH'),
    };
  }
  // deploy.cjs 는 TGE_TIME 을 벽시계(Date.now)와 비교한다. 체인 시계가 아니다.
  const WALL = Math.floor(Date.now() / 1000);
  const TGE = WALL + 30 * DAY;
  // deploy.cjs 는 TGE_TIME 의 상식 범위를 벽시계(Date.now)로 재고, HCOWVesting
  // 생성자는 block.timestamp 로 잰다. 메인넷에서는 둘이 같지만 이 하네스의
  // 기본 체인 시계(NOW=1900000000)와는 4년 어긋난다. 그래서 이 블록만 체인을
  // 벽시계에 맞춰 띄운다.
  async function stageWall() {
    const f = await boot({ chainId: 56, now: WALL });
    const safe = await dep('MockSafe', f.deployer, [await f.treasury.getAddress()]);
    const treasury = await safe.getAddress();
    const tk = await dep('HCOWToken', f.deployer, [treasury]);
    return { f, tk, token: await tk.getAddress(), treasury, chainId: 56 };
  }
  const denv = (s, extra = {}) => ({
    RPC_URL: s.f.node.url, CHAIN_ID: String(s.chainId), DEPLOYER_KEY: KEY_DEPLOY,
    TREASURY_ADDRESS: s.treasury, RESCUE_RECIPIENT: '0x' + '55'.repeat(20),
    TGE_TIME: String(TGE), SCHEDULE: SCHED, ...commitEnv(TGE), ...extra,
  });

  console.log('\ndeploy.cjs — 재실행 가드 (7차 C-1)\n');
  {
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    // 레코드가 이미 토큰·클레임·앵커를 안다. HCOW_ADDRESS 만 빠뜨린 상황.
    writeRec(56, {
      chainId: 56, treasury: s.treasury, tgeTime: TGE,
      addresses: { HCOWToken: s.token, HCOWClaim: '0x' + 'aa'.repeat(20), HCOWAnchor: '0x' + 'bb'.repeat(20) },
      deploymentTxs: { HCOWToken: '0x' + '11'.repeat(32), HCOWClaim: '0x' + '22'.repeat(32), HCOWAnchor: '0x' + '33'.repeat(32) },
    });
    const slip = await run('deploy.cjs', denv(s));
    says(slip, 'REPLACE_TOKEN=1', 'HCOW_ADDRESS 를 빠뜨리면 거부하고 플래그를 말한다');
    ok(readRec(56).addresses.HCOWToken === s.token, '그리고 기록된 토큰 주소가 그대로다');

    for (const spelling of ['yes', 'true', 'on', 'YES', ' 1']) {
      const r = await run('deploy.cjs', denv(s, { REPLACE_TOKEN: spelling }));
      says(r, 'REPLACE_TOKEN=1', `REPLACE_TOKEN=${JSON.stringify(spelling)} 는 위험을 켜지 않는다`);
    }
    ok(readRec(56).addresses.HCOWToken === s.token, '오타 다섯 번을 거치고도 토큰은 교체되지 않았다');
  }

  console.log('\ndeploy.cjs — 레코드가 없다는 것이 첫 배포의 증거는 아니다 (7차 C-1)\n');
  {
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    fs.rmSync(path.join(ROOT, 'deployments'), { recursive: true, force: true });
    const r = await run('deploy.cjs', denv(s));
    says(r, 'FIRST_DEPLOY', '레코드가 없으면 거부하고 플래그를 말한다');
    ok(!hasRec(56), '그리고 아무것도 배포하지 않았다');
  }

  console.log('\ndeploy.cjs — 토큰 신원 (7차 C-2)\n');
  {
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    // 레코드를 먼저 놓는다. 그러지 않으면 FIRST_DEPLOY 가드가 먼저 걸려서
    // 이 블록이 노린 심볼 가드가 아니라 엉뚱한 가드로 "통과" 한다.
    writeRec(56, { chainId: 56, treasury: s.treasury, tgeTime: TGE, addresses: { HCOWToken: s.token } });
    const decoy = await dep('DecoyToken', s.f.deployer, []);
    const decoyAddr = await decoy.getAddress();
    // 디코이 전량을 트레저리로 옮겨 잔액 가드를 먼저 만족시킨다. 그래야
    // 심볼 가드가 자기 힘으로 잡는지 알 수 있다.
    await (await decoy.connect(s.f.deployer).transfer(s.treasury, await decoy.totalSupply())).wait();
    writeSchedule(await decoy.totalSupply());
    const r = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: decoyAddr }));
    says(r, 'not "HCOW"', '18자리 USDT 디코이가 심볼로 거부된다');
    ok(!readRec(56).addresses?.HCOWVesting, '그리고 베스팅이 디코이에 묶이지 않았다');

    writeSchedule(ethers.parseUnits('200000000', 18));
    const liar = await dep('WrongSupplyHCOW', s.f.deployer, []);
    const rs = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: await liar.getAddress() }));
    says(rs, 'not 200,000,000', '이름만 HCOW 이고 공급량이 틀린 것도 거부된다');

    const other = await dep('HCOWToken', s.f.deployer, [s.treasury]);
    const r2 = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: await other.getAddress() }));
    says(r2, 'already names HCOWToken', '레코드와 다른 토큰은 거부된다');
  }

  console.log('\ndeploy.cjs — 베스팅 재실행 · 레코드 병합 · 되읽기 (7차 C-1 / M-5 / M-6)\n');
  {
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    writeRec(56, {
      chainId: 56, treasury: s.treasury, tgeTime: TGE,
      addresses: { HCOWToken: s.token, HCOWClaim: '0x' + 'aa'.repeat(20) },
      deploymentTxs: { HCOWToken: '0x' + '11'.repeat(32), HCOWClaim: '0x' + '22'.repeat(32) },
    });
    const good = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token }));
    ok(good.status === 0, '정상 경로는 배포된다');
    ok(good.out.includes('rescueRecipient'), '되읽기가 rescueRecipient 를 이름으로 확인한다');
    ok(good.out.includes('supplyCap') || good.out.includes('token, owner'), '되읽기가 token 과 supplyCap 까지 읽는다');
    const rec = readRec(56);
    ok(rec.addresses.HCOWClaim === '0x' + 'aa'.repeat(20), 'addresses 의 기존 HCOWClaim 이 보존된다');
    ok(rec.deploymentTxs.HCOWClaim === '0x' + '22'.repeat(32), 'deploymentTxs 의 기존 HCOWClaim 도 보존된다');
    ok(!!rec.deploymentTxs.HCOWVesting, '그리고 새 HCOWVesting tx 가 더해진다');

    const again = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token }));
    says(again, 'REPLACE_VESTING=1', '베스팅이 이미 기록돼 있으면 두 번째 실행은 거부된다');
    const forced = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token, REPLACE_VESTING: '1' }));
    ok(forced.status === 0 && readRec(56).addresses.HCOWVesting !== rec.addresses.HCOWVesting,
      'REPLACE_VESTING=1 은 의도적 탈출구다');
    fs.rmSync(SCHED, { force: true });
  }


  // ======================================================================
  // 억제 플래그의 이름이 스크립트마다 달랐다 (7차 감사 H-3 / H-4 / H-5)
  //
  // set-root.cjs 는 PRINT_ONLY 만 알고 DRY_RUN 을 몰랐다. anchor.cjs 는
  // 그 반대였다. deploy-anchor.cjs 는 둘 다 몰랐고 dryFlag 를 import 조차
  // 하지 않았다. 셋 다 "리허설이라고 믿고 친 명령이 되돌릴 수 없는 것을
  // 실제로 한다" 는 같은 결과를 낸다. 4차 감사 C-1/C-2 와 같은 형태가
  // 다른 파일에서 재발한 것이다.
  // ======================================================================
  console.log('\ndeploy-anchor.cjs 에 드라이런이 있다 (7차 H-5)\n');
  {
    clearRec();
    const s = await stage();
    const aEnv = (extra) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY,
      ANCHOR_OWNER: s.treasury, ANCHOR_PUBLISHER: '0x' + '77'.repeat(20),
      FIRST_DEPLOY: '1', ...extra,
    });
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      const r = await run('deploy-anchor.cjs', aEnv({ [flag]: 'yes' }));
      ok(r.status === 0, `${flag}=yes 로 exit 0`);
      ok(/DRY RUN/.test(r.out), `${flag}=yes 가 DRY RUN 이라고 말한다`);
      ok(!readRec(56).addresses?.HCOWAnchor, `${flag}=yes 는 아무것도 배포하지 않는다`);
    }
    const bad = await run('deploy-anchor.cjs', aEnv({ DRY_RUN: 'maybe' }));
    says(bad, 'Refusing to guess', 'DRY_RUN=maybe 는 배포하지 않고 거부한다');
    ok(!readRec(56).addresses?.HCOWAnchor, '그리고 아무것도 배포되지 않았다');
    const live = await run('deploy-anchor.cjs', aEnv({}));
    ok(live.status === 0 && !!readRec(56).addresses?.HCOWAnchor, '플래그가 없으면 실제로 배포한다');
  }


  // ======================================================================
  // 되읽기 비교는 순수 함수로만 시험할 수 있다 (백로그 C-7)
  //
  // deploy.cjs 는 언제나 자기가 방금 보낸 인자로 배포한 컨트랙트를 읽는다.
  // 그래서 비교문을 통째로 지워도 정상 경로는 전부 초록이다 — 7차 조치의
  // 사보타주에서 rescueRecipient 비교 삭제가 살아남았다. deploy-token.cjs 가
  // 같은 이유로 readbackFaults 를 분리했고 여기도 같은 처리를 했다.
  // ======================================================================
  console.log('\ndeploy.cjs — readbackFaults 를 데코이 값으로 직접 먹인다 (7차 M-5)\n');
  {
    const { readbackFaults } = require('../scripts/deploy.cjs');
    const T = '0x' + '11'.repeat(20), R = '0x' + '22'.repeat(20), O = '0x' + '33'.repeat(20);
    const H = '0x' + 'ab'.repeat(32);
    const want = { token: T, rescue: R, supply: 200n * E, count: 9n, total: 200n * E, unlock: 27n * E, hash: H, treasury: O, tge: 1900000000 };
    const good = { oTok: T, oResc: R, oCap: 200n * E, ob: 9n, os: 200n * E, ou: 27n * E, oh: H, oo: O, ot: 1900000000n };
    ok(readbackFaults(good, want).length === 0, '올바른 되읽기에는 결함이 없다');
    ok(readbackFaults({ ...good, oTok: T.toUpperCase().replace('0X', '0x') }, want).length === 0,
      '주소 비교는 대소문자를 구분하지 않는다');

    const cases = [
      ['oTok', '0x' + '99'.repeat(20), 'token'],
      ['oResc', '0x' + '99'.repeat(20), 'rescueRecipient'],
      ['oCap', 199n * E, 'supplyCap'],
      ['ob', 8n, 'expectedBeneficiaries'],
      ['os', 199n * E, 'expectedScheduled'],
      ['ou', 26n * E, 'expectedTgeUnlock'],
      ['oh', '0x' + 'cd'.repeat(32), 'expectedScheduleHash'],
      ['oo', '0x' + '99'.repeat(20), 'owner'],
      ['ot', 1900000001n, 'tgeTime'],
    ];
    for (const [field, wrong, name] of cases) {
      const faults = readbackFaults({ ...good, [field]: wrong }, want);
      ok(faults.length === 1 && faults[0].startsWith(name),
        `${name} 이 틀리면 그 이름으로 정확히 한 건 보고된다`);
    }
    ok(readbackFaults({ ...good, oTok: '0x' + '99'.repeat(20), oResc: '0x' + '99'.repeat(20) }, want).length === 2,
      '두 개가 틀리면 두 건 다 보고된다 — 첫 번째에서 멈추지 않는다');
  }

  // ======================================================================
  // anchor.cjs 에는 테스트가 하나도 없었다 (7차 H-4)
  //
  // 사보타주에서 suppressed() 를 dryFlag('DRY_RUN') 으로 되돌려도 전 스위트가
  // 초록이었다. 되돌릴 수 없는 스크립트에 테스트가 없다는 뜻이다.
  // ======================================================================
  console.log('\nanchor.cjs — 억제 플래그 두 이름이 다 통한다 (7차 H-4)\n');
  {
    clearRec();
    // anchor.cjs 는 "구간이 끝났는가" 를 서버 시계(Date.now)로 잰다. 크론으로
    // 도는 스크립트라 그 자체는 합리적이지만, 이 하네스의 기본 체인 시계
    // (NOW = 2030년)와는 어긋난다. deploy.cjs 의 TGE 검사와 같은 성질이다.
    const f = await boot({ chainId: 56, now: WALL });
    const pub = await f.other.getAddress();
    const an = await dep('HCOWAnchor', f.deployer, [await f.treasury.getAddress(), pub]);
    const anchorAddr = await an.getAddress();
    writeRec(56, { chainId: 56, addresses: { HCOWAnchor: anchorAddr } });

    const dir = path.join(ROOT, 'build', 'opsguard-anchor');
    fs.mkdirSync(dir, { recursive: true });
    const roundsFile = path.join(dir, 'rounds.json');
    fs.writeFileSync(roundsFile, JSON.stringify([
      { roundHash: 'aa'.repeat(32), epochKey: 'bb'.repeat(32), nonce: 0 },
      { roundHash: 'cc'.repeat(32), epochKey: 'bb'.repeat(32), nonce: 1 },
    ], null, 2));
    const aenv = (extra) => ({
      RPC_URL: f.node.url, CHAIN_ID: '56', PUBLISHER_KEY: KEY_OTHER,
      ANCHOR_ADDRESS: anchorAddr, ROUNDS_FILE: roundsFile,
      // 첫 배치는 제네시스 시각을 정하고 그 앞의 모든 구간을 영구히 앵커
      // 불가능하게 만든다. 스크립트가 그걸 막고 ALLOW_GAP 을 요구한다.
      ALLOW_GAP: '1',
      PERIOD_START: String(Math.floor((WALL - 2 * 3600) / 3600) * 3600), ...extra,
    });
    const count = async () => (await new ethers.Contract(
      anchorAddr, ['function batchCount() view returns (uint256)'], f.provider).batchCount());

    ok(await count() === 0n, '앵커는 아직 비어 있다');
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      const r = await run('anchor.cjs', aenv({ [flag]: 'yes' }));
      ok(r.status === 0, `${flag}=yes 로 exit 0`);
      ok(await count() === 0n, `${flag}=yes 는 아무것도 앵커하지 않는다`);
    }
    const bad = await run('anchor.cjs', aenv({ PRINT_ONLY: 'maybe' }));
    says(bad, 'Refusing to guess', 'PRINT_ONLY=maybe 는 추측하지 않고 거부한다');
    ok(await count() === 0n, '그리고 여전히 비어 있다');

    const live = await run('anchor.cjs', aenv({}));
    ok(live.status === 0 && await count() === 1n, '플래그가 없으면 실제로 앵커한다');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  clearRec();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
