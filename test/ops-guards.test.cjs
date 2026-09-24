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
const { boot, run, dep, art, ROOT, KEY_DEPLOY, KEY_TREASURY, KEY_OTHER } = require('./harness/fixture.cjs');

const NOW = 1900000000, DAY = 86400, E = 10n ** 18n;
// 8차 감사 M-6 이후 deploy-claim.cjs 는 TGE_TIME 을 벽시계(Date.now)로 재고
// 365일 상한을 둔다 — deploy.cjs 와 같은 규칙이고, HCOWVesting 생성자가 그
// 범위를 강제하기 때문이다. 이 하네스의 체인 시계(NOW=2030년)와 벽시계는 몇 년
// 어긋나 있으므로, TGE_TIME 으로 넘기는 값은 벽시계 기준이어야 한다.
const WALLNOW = Math.floor(Date.now() / 1000);
// 10차 감사: ethers v6 는 getBlockNumber() 결과를 약 250ms 캐시한다. 배포 직후에
// 읽은 "이전" 값이 캐시된 옛 번호여서, 아무것도 나가지 않았는데 블록이 늘었다고
// 거짓으로 실패한 단언이 7개 있었다. 반대 방향(거짓 PASS)은 "이후" 값을 수 초 뒤에
// 읽으므로 생기지 않지만, 셈이 틀린 단언을 두지 않는다. 캐시를 거치지 않고 노드에
// 직접 묻는다.
const blockNo = async (provider) => Number(await provider.send('eth_blockNumber', []));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const says = (r, needle, m) => ok(r.status !== 0 && r.out.includes(needle),
  r.status !== 0 && r.out.includes(needle) ? m : `${m}\n        status ${r.status}, output:\n${r.out.split('\n').map((l) => '        | ' + l).join('\n')}`);

// 10차 감사. 이 스위트는 ROOT/deployments 를 통째로 지우고 가짜 chainId 56
// 레코드를 써 왔다. 그 경로는 _connect.cjs 가 운영 레코드를 두는 곳과 같다.
// 운영자가 실제 체크아웃에서 `npm test` 를 돌리면 메인넷 레코드가 지워지고,
// 중간에 끊기면 하네스 주소가 적힌 가짜 메인넷 레코드가 남았다 (재현함).
// 이제 스위트 전용 디렉터리를 쓰고, 자식 프로세스도 HCOW_RECORD_DIR 로 같은
// 곳을 본다. run() 이 process.env 를 넘기므로 여기서 한 번 정하면 된다.
const REC_DIR = path.join(ROOT, 'build', 'test-deployments', 'ops-guards');
process.env.HCOW_RECORD_DIR = REC_DIR;
// (11차 감사: 여기 있던 "REC_DIR 이 실제 deployments/ 이면 거부" 검사는 상수 두 개를
// 비교해서 절대 발동하지 않았다. 지웠다. 운영자 셸의 HCOW_RECORD_DIR 는 바로 위
// 대입이 덮어쓰고, 실제 체인에서 그 변수가 쓰이는 일은 _connect.cjs 가 막는다.)
// 운영 레코드 디렉터리의 지문. 11차 감사: 이전 판은 최상위 항목의 이름과 mtime 만
// 봤다. 하위 디렉터리 안의 변경은 보지 못했다. 전부 재귀로 크기·mtime·내용 해시를 본다.
function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) { out.push(`${path.relative(dir, p)}/`); walk(p); }
      else out.push(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs}:` +
        require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out.join('\n');
}
const REAL_DEPLOYMENTS_AT_START = snapshotDir(path.join(ROOT, 'deployments'));
const recPath = (c) => path.join(REC_DIR, `${c}.json`);
const clearRec = () => fs.rmSync(REC_DIR, { recursive: true, force: true });
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
    // 7차 M-4 이후: 레코드가 없으면 tgeTime 도 없으므로 메인넷에서는 TGE_TIME
    // 을 함께 줘야 한다. 그것이 이 조치의 요점이다 — 정해진 배포 순서에서는
    // 레코드에 tgeTime 이 있을 수가 없고, 그래서 TGE 대조가 한 번도 돌지 않았다.
    // 먼저 TGE 없이. 성공한 실행이 레코드를 만들면 그 다음 실행은 재실행
    // 가드에 먼저 걸려서 이 케이스가 엉뚱한 이유로 통과한다.
    const noTge = await run('deploy-claim.cjs', { ...env(s), FIRST_DEPLOY: 'yes' });
    says(noTge, 'TGE_TIME', 'FIRST_DEPLOY 만으로는 부족하다 — TGE 를 알 방법이 없으면 거부된다');
    const y = await run('deploy-claim.cjs', { ...env(s), FIRST_DEPLOY: 'yes', TGE_TIME: String(WALLNOW + 30 * DAY) });
    ok(y.status === 0, 'FIRST_DEPLOY=yes + TGE_TIME 이면 진행된다');
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
    says(notOwnerLive, 'PRINT_ONLY=yes (or DRY_RUN=yes', 'and without it, a non-owner key is still refused, naming both spellings');

    // ---- 8차 감사 M-9. PRINT_ONLY 가 TREASURY_KEY 를 요구했다 -------------
    //
    // PRINT_ONLY 의 존재 이유는 트레저리 개인키가 스크립트에 없고 있어서도 안
    // 된다는 것이다. 그런데 이 스크립트는 needSigner 를 주지 않아 키가 없으면
    // connect 단계에서 죽었다. 즉 to/data 를 뽑으려면 뽑을 필요가 없는 키가
    // 있어야 했다. load.cjs 는 처음부터 맞게 돼 있었다.
    writeTree(NOW + 10 * DAY, 1000n * E);
    // 9차 감사 M-3. 8차 판의 이 단언은 공허했다. 픽스처가
    // record.treasury === 체인의 owner 로 만들어져 있어서, `from` 을 레코드에서
    // 읽어도 체인에서 읽어도 같은 문자열이 나왔다. 두 출처가 다를 때만 이
    // 단언이 무언가를 확인한다. 그래서 레코드의 treasury 만 오염시킨다.
    const decoyTreasury = ethers.getAddress('0x' + 'd0'.repeat(20));
    const keepRec = readRec(56);
    writeRec(56, { ...keepRec, treasury: decoyTreasury });
    for (const flag of ['PRINT_ONLY', 'DRY_RUN']) {
      const noKey = await run('set-root.cjs', {
        RPC_URL: s.f.node.url, CHAIN_ID: '56', [flag]: 'yes',
      }, ['--rounds', path.join(dir, 'rounds.json'), '--round', '0']);
      ok(noKey.status === 0 && noKey.out.includes('data   0x'),
        `${flag}=yes 는 TREASURY_KEY 가 환경에 아예 없어도 calldata 를 찍는다`);
      ok(noKey.out.includes(`from   ${s.treasury}`),
        `${flag}=yes 가 찍는 from 은 체인에서 읽은 owner 다`);
      ok(!noKey.out.includes(`from   ${decoyTreasury}`),
        `${flag}=yes 가 찍는 from 은 레코드의 treasury 가 아니다 — 두 값이 다른 상태에서 확인`);
    }
    writeRec(56, keepRec);
    // 억제 플래그가 없으면 서명자가 필요하다. 위 케이스가 "키는 늘 필요 없다" 로
    // 읽히지 않게 한다.
    const noKeyLive = await run('set-root.cjs', {
      RPC_URL: s.f.node.url, CHAIN_ID: '56',
    }, ['--rounds', path.join(dir, 'rounds.json'), '--round', '0']);
    says(noKeyLive, 'TREASURY_KEY', '억제 플래그 없이 키도 없으면 거부된다');

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
  // 9차 감사: 행 수를 바꿀 수 있어야 한다. 배포 전 사전 검사(MAX_BENEFICIARIES)와
  // 메인넷 9행 등식을 테스트하려면 9 가 아닌 테이블이 필요하다.
  // 12차 감사 M-2: 메인넷 deploy.cjs 는 이제 meta.totalsMustEqual · tgeUnlockMustEqual 을
  // 행에서 계산한 값과 대조한다. 실제 mainnet.json 처럼 meta 를 채우되, 행이 퇴화해
  // 커밋먼트를 계산할 수 없는 테스트에서는 비워 둔다. metaOver 로 어긋난 meta 를 만든다.
  function writeSchedule(totalWei, n = 9, rowOverrides = {}, metaOver = {}) {
    const names = ['Public', 'Private', 'Seed', 'Airdrop', 'Incentives', 'Ecosystem', 'Foundation', 'Liquidity', 'Team'];
    const per = totalWei / BigInt(n), rem = totalWei - per * BigInt(n - 1);
    fs.mkdirSync(path.dirname(SCHED), { recursive: true });
    const rows = Array.from({ length: n }, (_, i) => ({
      label: names[i] || `Row${i + 1}`,
      beneficiary: ethers.getAddress('0x' + (i + 1).toString(16).padStart(40, '0')),
      total: (i === n - 1 ? rem : per).toString(),
      tgeBps: 1350, cliffMonths: 0, linearMonths: 12,
      ...(rowOverrides[i] || {}),
    }));
    let meta = {};
    try {
      const cm = require('../scripts/commitcheck.cjs').commitments(rows.map((r) => ({ ...r, total: BigInt(r.total) })));
      meta = { totalsMustEqual: cm.total.toString(), tgeUnlockMustEqual: cm.unlock.toString() };
    } catch (_) { meta = {}; }
    fs.writeFileSync(SCHED, JSON.stringify({ meta: { ...meta, ...metaOver }, rows }, null, 2));
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

  // 10차 감사. 메인넷에서 deploy.cjs 는 이제 토큰을 배포하지 않는다 — 정해진
  // 순서에서 토큰은 deploy-token.cjs 가 먼저 배포하고 레코드에 적는다. 그래서
  // 메인넷 케이스는 "토큰이 있고 레코드가 그것을 부른다" 에서 시작해야 한다.
  // 새 토큰 경로(한 실행에서 토큰과 베스팅을 연달아 배포)는 테스트넷에만 남았고,
  // 고아 토큰 사전 검사가 의미를 갖는 곳도 테스트넷이다.
  const mainRec = (s, extra = {}) => writeRec(56, {
    chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token }, ...extra,
  });
  const menv = (s, extra = {}) => denv(s, { HCOW_ADDRESS: s.token, ...extra });
  async function stageTestnet({ eoa = false } = {}) {
    const f = await boot({ chainId: 97, now: WALL });
    let treasury;
    if (eoa) treasury = await f.treasury.getAddress();
    else treasury = await (await dep('MockSafe', f.deployer, [await f.treasury.getAddress()])).getAddress();
    const tk = await dep('HCOWToken', f.deployer, [treasury]);
    return { f, tk, token: await tk.getAddress(), treasury, chainId: 97 };
  }
  // 메인넷 레코드에 HCOWClaim 이 있으면 deploy.cjs 는 그것을 체인에 대고 본다
  // (토큰 바인딩, 테이블에 그 주소가 있는지, 기한이 TGE 로부터 12개월 이상인지).
  // 그래서 가짜 주소가 아니라 진짜 claim 을 배포하고, 테이블 Airdrop 행에 넣는다.
  // 12차 감사 M-2: deploy.cjs 는 claim 행이 다 풀린 뒤에도 라운드를 하나 열 수 있는지
  // (행 종료 <= claimDeadline − minClaimWindow) 본다. 테스트 테이블의 행은 12개월 선형,
  // 창은 90일이므로 기본 기한을 TGE+460일로 둔다 (360 + 90 + 여유 10).
  async function realClaim(s, { deadline = TGE + 460 * DAY, token = s.token, notice = 259200 } = {}) {
    // 자식 프로세스(deploy-anchor.cjs 등)가 같은 배포키로 트랜잭션을 보낸 뒤에는 이
    // 프로세스의 NonceManager 캐시가 낡는다. 그때만 캐시를 버리고 다시 시도한다.
    // (무조건 reset 하면 ethers 의 250ms 요청 캐시 때문에 방금 쓴 nonce 를 다시 읽는다.)
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await dep('HCOWClaim', s.f.deployer, [token, s.treasury, deadline, notice, 7776000]);
        return c.getAddress();
      } catch (e) {
        if (attempt >= 2 || !/correct nonce/.test(String(e.message || e))) throw e;
        s.f.deployer.reset();
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  // 11차 감사: 메인넷 deploy.cjs 는 이제 기록된 HCOWClaim 을 요구하고, 그 claim 이
  // 라벨 Airdrop 행(인덱스 3)의 수혜자여야 한다. 정해진 순서 그대로의 출발점을
  // 한 번에 만든다: 토큰(이미 있음) + 진짜 claim + 그 claim 을 Airdrop 행에 둔 테이블
  // + 둘을 부르는 레코드.
  async function mainReady(s, { over = {}, n = 9, total = ethers.parseUnits('200000000', 18), claimOpts = {} } = {}) {
    const claim = await realClaim(s, claimOpts);
    writeSchedule(total, n, { 3: { beneficiary: claim }, ...over });
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: claim } });
    s.claim = claim;
    return claim;
  }

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
    says(slip, 'already names HCOWToken', 'HCOW_ADDRESS 를 빠뜨리면 거부한다');
    says(slip, 'Set HCOW_ADDRESS to the token you mean', '그리고 실제로 존재하는 해결책을 안내한다');
    ok(readRec(56).addresses.HCOWToken === s.token, '그리고 기록된 토큰 주소가 그대로다');

    // 8차 감사 M-1. 7차 판의 이 루프는 오타 다섯 가지만 돌리고 전부 거부되는
    // 것을 확인했다. REPLACE_TOKEN 은 저장소 어디에서도 읽히지 않았으므로
    // 정확한 철자 '1' 도 거부된다 — 즉 이 테스트는 "가드가 작동한다" 와
    // "가드가 아예 없다" 를 구분하지 못했다 (백로그 C-11). 이제 문구가 그
    // 플래그를 약속하지 않으므로, 확인해야 할 것은 두 가지다: 어떤 철자로도
    // 위험이 켜지지 않는다, 그리고 문구가 존재하지 않는 탈출구를 안내하지 않는다.
    for (const spelling of ['1', 'yes', 'true', 'on', 'YES', ' 1']) {
      const r = await run('deploy.cjs', denv(s, { REPLACE_TOKEN: spelling }));
      says(r, 'already names HCOWToken', `REPLACE_TOKEN=${JSON.stringify(spelling)} 는 위험을 켜지 않는다`);
      ok(!r.out.includes('re-run with REPLACE_TOKEN'),
        `그리고 REPLACE_TOKEN=${JSON.stringify(spelling)} 실행의 문구가 없는 탈출구를 약속하지 않는다`);
    }
    ok(readRec(56).addresses.HCOWToken === s.token, '정확한 철자를 포함한 여섯 번을 거치고도 토큰은 교체되지 않았다');
  }

  console.log('\ndeploy.cjs — 레코드가 없다는 것이 첫 배포의 증거는 아니다 (7차 C-1)\n');
  {
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    clearRec();
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
    // 디코이 전량을 트레저리로 옮겨 잔액 가드를 먼저 만족시킨다.
    // 9차 감사: 스케줄 합계를 디코이의 공급량에 맞추던 줄을 지웠다. 메인넷
    // 합계 등식(9차 A-4)이 심볼 가드보다 먼저 걸려서 이 케이스가 엉뚱한 이유로
    // "통과" 했다. 심볼 검사는 deploy.cjs 안에서 잔액·합계 검사보다 앞에 있으므로
    // 200,000,000 테이블로 두면 심볼 가드가 자기 힘으로 잡는다. 단언은 그
    // 가드만이 낼 수 있는 문구(not "HCOW")를 본다.
    await (await decoy.connect(s.f.deployer).transfer(s.treasury, await decoy.totalSupply())).wait();
    const r = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: decoyAddr }));
    says(r, 'not "HCOW"', '18자리 USDT 디코이가 심볼로 거부된다');
    ok(!readRec(56).addresses?.HCOWVesting, '그리고 베스팅이 디코이에 묶이지 않았다');

    writeSchedule(ethers.parseUnits('200000000', 18));
    const liar = await dep('WrongSupplyHCOW', s.f.deployer, []);
    const rs = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: await liar.getAddress() }));
    says(rs, 'reports a total supply of', '이름만 HCOW 이고 공급량이 틀린 것도 거부된다');

    const other = await dep('HCOWToken', s.f.deployer, [s.treasury]);
    const r2 = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: await other.getAddress() }));
    says(r2, 'already names HCOWToken', '레코드와 다른 토큰은 거부된다');
  }

  console.log('\ndeploy.cjs — 베스팅 재실행 · 레코드 병합 · 되읽기 (7차 C-1 / M-5 / M-6)\n');
  {
    clearRec();
    const s = await stageWall();
    // 10차 감사: 이 블록은 가짜 HCOWClaim(0xaa…, 코드 없음)을 썼다. 이제 메인넷
    // deploy.cjs 는 레코드의 claim 을 체인에 대고 확인하므로 진짜 claim 을
    // 배포하고, 테이블의 Community / Airdrop 행(인덱스 3)에 그 주소를 넣는다.
    const claimAddr = await realClaim(s);
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 3: { beneficiary: claimAddr } });
    writeRec(56, {
      chainId: 56, treasury: s.treasury,
      addresses: { HCOWToken: s.token, HCOWClaim: claimAddr },
      deploymentTxs: { HCOWToken: '0x' + '11'.repeat(32), HCOWClaim: '0x' + '22'.repeat(32) },
    });
    const good = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token }));
    ok(good.status === 0, '정상 경로는 배포된다');
    ok(good.out.includes('rescueRecipient'), '되읽기가 rescueRecipient 를 이름으로 확인한다');
    ok(good.out.includes('supplyCap') || good.out.includes('token, owner'), '되읽기가 token 과 supplyCap 까지 읽는다');
    ok(/bound to this token; deadline \d+\.\d thirty-day months after this TGE/.test(good.out),
      '그리고 기록된 claim 을 체인에서 읽어 토큰 바인딩과 기한을 확인했다고 말한다 (10차)');
    const rec = readRec(56);
    ok(rec.addresses.HCOWClaim === claimAddr, 'addresses 의 기존 HCOWClaim 이 보존된다');
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


  // ======================================================================
  // deploy-claim.cjs 의 TGE 대조는 한 번도 실행되지 않았다 (7차 M-4)
  //
  // record.tgeTime 을 쓰는 곳은 저장소 전체에서 deploy.cjs 하나뿐이고,
  // 정해진 배포 순서는 token → HCOWClaim → vesting 이라 deploy-claim 이 도는
  // 시점에 tgeTime 은 구조적으로 항상 없다. deploy-token.cjs 는 그 값을
  // 기록하지 않는다. claimDeadline 은 연장만 되고 줄일 수 없으므로 "너무
  // 짧게 잡았다" 를 잡아 줄 유일한 검사가 죽어 있었다.
  // 대표 결정: TGE_TIME 을 env 로 직접 받는다.
  // ======================================================================
  console.log('\ndeploy-claim.cjs — TGE 대조가 실제로 돈다 (7차 M-4)\n');
  {
    clearRec();
    const s = await stage();
    // 레코드에 tgeTime 이 없는 상태. 정해진 순서에서는 이게 정상이다.
    writeRec(56, { chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token } });
    const base = { ...env(s) };
    delete base.CLAIM_DEADLINE;
    const e = (extra) => ({ ...base, CLAIM_DEADLINE: String(NOW + 800 * DAY), ...extra });

    const none = await run('deploy-claim.cjs', e({}));
    says(none, 'TGE_TIME', '메인넷에서 TGE 를 알 방법이 없으면 거부하고 그 이름을 말한다');
    ok(!readRec(56).addresses?.HCOWClaim, '그리고 아무것도 배포하지 않았다');

    const tge = WALLNOW + 30 * DAY;
    const okRun = await run('deploy-claim.cjs', e({ TGE_TIME: String(tge) }));
    ok(okRun.status === 0, 'TGE_TIME 을 주면 배포된다');
    ok(/months after/.test(okRun.out), '그리고 TGE 대비 개월 수를 실제로 출력한다 — 검사가 돌았다는 뜻');

    // 이제 검사가 실제로 무언가를 잡는지 본다.
    clearRec();
    const s2 = await stage();
    writeRec(56, { chainId: 56, treasury: s2.treasury, addresses: { HCOWToken: s2.token } });
    const e2 = (extra) => ({ ...env(s2), ...extra });
    const short = await run('deploy-claim.cjs', {
      ...e2({ TGE_TIME: String(WALLNOW + 30 * DAY) }), CLAIM_DEADLINE: String(WALLNOW + 60 * DAY) });
    says(short, 'months after TGE', '기한이 TGE 로부터 1개월이면 메인넷에서 거부된다');
    const before = await run('deploy-claim.cjs', {
      ...e2({ TGE_TIME: String(WALLNOW + 300 * DAY) }), CLAIM_DEADLINE: String(WALLNOW + 200 * DAY) });
    says(before, 'at or before TGE', '기한이 TGE 보다 앞서면 거부된다');
    ok(!readRec(56).addresses?.HCOWClaim, '두 경우 모두 아무것도 배포되지 않았다');

    // 레코드와 env 가 둘 다 있으면 일치해야 한다. 고르지 않는다.
    clearRec();
    const s3 = await stage();
    writeRec(56, { chainId: 56, treasury: s3.treasury, tgeTime: WALLNOW + 30 * DAY,
                   addresses: { HCOWToken: s3.token } });
    const clash = await run('deploy-claim.cjs', { ...env(s3), TGE_TIME: String(WALLNOW + 31 * DAY) });
    says(clash, 'TGE_TIME', '레코드의 tgeTime 과 TGE_TIME 이 다르면 거부한다');
    const agree = await run('deploy-claim.cjs', { ...env(s3), TGE_TIME: String(WALLNOW + 30 * DAY) });
    ok(agree.status === 0, '두 값이 같으면 배포된다');
  }

  // ======================================================================
  // 8차 감사 조치
  // ======================================================================

  console.log('\ndeploy.cjs — DRY_RUN · PRINT_ONLY (8차 H-1)\n');
  {
    // 재현했던 결함: 두 이름 다 exit 0 으로 끝나면서 토큰과 베스팅이 실제로
    // 배포됐다. 그래서 "exit 0" 만으로는 이 테스트가 아무 의미도 없다. 체인에
    // 블록이 늘지 않았는지, 레코드가 쓰이지 않았는지를 같이 본다.
    // 10차 감사: 메인넷에서는 이제 새 토큰 경로 자체가 닫혔으므로 이 블록은 그
    // 경로가 남아 있는 테스트넷에서 돈다. 메인넷의 드라이런(HCOW_ADDRESS 경로)은
    // 9차 A-3 블록이 본다.
    writeSchedule(ethers.parseUnits('200000000', 18));
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      for (const spelling of ['yes', '1', 'true', 'on', 'YES']) {
        clearRec();
        const s = await stageTestnet();
        const before = await blockNo(s.f.provider);
        const r = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1', [flag]: spelling }));
        const after = await blockNo(s.f.provider);
        ok(r.status === 0 && /DRY RUN/.test(r.out), `${flag}=${spelling} 는 exit 0 이고 DRY RUN 이라고 말한다`);
        ok(before === after, `${flag}=${spelling} 로는 트랜잭션이 하나도 나가지 않는다 (블록 ${before})`);
        ok(!hasRec(97), `${flag}=${spelling} 로는 레코드도 쓰이지 않는다`);
        ok(/constructor arguments/.test(r.out), `${flag}=${spelling} 가 생성자 인자를 출력한다`);
      }
    }
    // 오타는 추측하지 않는다. 이것이 억제 플래그 규칙의 요점이다.
    clearRec();
    const s = await stageTestnet();
    const b0 = await blockNo(s.f.provider);
    const typo = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1', DRY_RUN: 'mabye' }));
    says(typo, 'Refusing to guess', 'DRY_RUN=mabye 는 배포하지 않고 거부한다');
    ok(b0 === await blockNo(s.f.provider), '그리고 그때도 아무것도 배포되지 않았다');
    // 8차 감사 L-3. 예전 suppressed() 는 단축평가라 DRY_RUN 이 참이면 PRINT_ONLY
    // 의 오타를 검증하지 않았다. 억제 플래그의 요점이 "추측하지 않는다" 이므로
    // 두 번째 이름의 오타도 잡혀야 한다.
    const both = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1', DRY_RUN: 'yes', PRINT_ONLY: 'mabye' }));
    says(both, 'PRINT_ONLY', 'DRY_RUN=yes 여도 PRINT_ONLY 의 오타는 그냥 지나가지 않는다');
    // 드라이런이라도 읽을 수 있는 검사는 돈다. HCOW_ADDRESS 가 있으면 신원 검사가
    // 대상을 갖는다. 배너가 "돌았다" 고 말하는데 실제로는 안 도는 상태를 막는다.
    const liar = await dep('DecoyToken', s.f.deployer, []);
    const lie = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1', DRY_RUN: 'yes', HCOW_ADDRESS: await liar.getAddress() }));
    says(lie, 'not "HCOW"', '드라이런에서도 HCOW_ADDRESS 가 주어지면 심볼 검사가 돈다');
    // 그리고 HCOW_ADDRESS 가 없으면 그 검사가 돌지 않았다고 스스로 밝힌다.
    const quiet = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1', DRY_RUN: 'yes' }));
    ok(/did NOT run/.test(quiet.out), 'HCOW_ADDRESS 없는 드라이런은 신원 검사가 안 돌았다고 말한다');
  }

  console.log('\ndeploy.cjs — 레코드의 내용을 본다, 존재만 보지 않는다 (8차 H-2 · 10차)\n');
  {
    // 10차 감사: 레코드 검증은 이제 _connect.cjs 의 readRecord 한 곳에 있다.
    // 파일이 있는데 틀리면 던지고, **FIRST_DEPLOY 로도 넘어가지 않는다.** 9차
    // 판은 여기서 "names no deployment at all" 이라고 말했고, 그 문구가 운영자를
    // FIRST_DEPLOY=1 로 안내했으며, 그 플래그가 봉인 검사까지 껐다.
    writeSchedule(ethers.parseUnits('200000000', 18));
    const broken = [
      ['{}', {}, 'no chainId field'],
      ['addresses:null', { chainId: 56, addresses: null }, 'no addresses object'],
      ['addresses:{}', { chainId: 56, addresses: {} }, 'addresses is empty'],
      ['addresses:[]', { chainId: 56, addresses: [] }, 'no addresses object'],
      ['배열', [], 'not a JSON object'],
    ];
    for (const [label, body, why] of broken) {
      clearRec();
      const s = await stageWall();
      writeRec(56, body);
      const before = await blockNo(s.f.provider);
      const r = await run('deploy.cjs', menv(s));
      says(r, 'is not a record any script here can trust', `레코드가 ${label} 이면 거부한다`);
      says(r, why, `그리고 ${label} 의 이유를 이름으로 말한다`);
      const forced = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
      says(forced, 'FIRST_DEPLOY included', `${label} 은 FIRST_DEPLOY=1 로도 넘어가지 않는다 (10차)`);
      ok(before === await blockNo(s.f.provider), `그리고 ${label} 에서 아무것도 배포되지 않았다`);
    }
    // 다른 체인의 레코드를 복사해 온 경우.
    clearRec();
    const s = await stageWall();
    writeRec(56, { chainId: 97, addresses: { HCOWToken: '0x' + 'cc'.repeat(20) } });
    const wrongChain = await run('deploy.cjs', menv(s));
    says(wrongChain, 'its chainId is 97, not 56', '레코드의 chainId 가 다르면 거부한다');
    // 긍정 대조군. 앵커만 적힌 레코드는 정당하다 — 앵커를 먼저 배포할 수 있다.
    // 테스트넷에서는 그대로 진행된다.
    clearRec();
    const t = await stageTestnet();
    writeRec(97, { chainId: 97, addresses: { HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)) } });
    const anchorOnly = await run('deploy.cjs', denv(t, { HCOW_ADDRESS: t.token }));
    ok(anchorOnly.status === 0, '앵커만 적힌 레코드는 테스트넷에서 진행된다');
    ok(readRec(97).addresses.HCOWAnchor === ethers.getAddress('0x' + 'bb'.repeat(20)), '그리고 앵커 주소가 보존된다');
    // 메인넷에서는 레코드가 deploy-token.cjs 가 배포한 토큰을 불러야 한다.
    clearRec();
    const s2 = await stageWall();
    writeRec(56, { chainId: 56, addresses: { HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)) } });
    const mainAnchorOnly = await run('deploy.cjs', menv(s2));
    says(mainAnchorOnly, 'must already name the HCOWToken', '메인넷에서는 토큰이 기록되지 않은 레코드를 거부한다 (10차)');
  }

  console.log('\ndeploy.cjs — 스케줄 합계는 토큰 배포 전에 검사된다 (8차 H-3)\n');
  {
    // 10차: 고아 토큰은 새 토큰 경로에서만 생긴다. 그 경로는 이제 테스트넷에만 있다.
    clearRec();
    const s = await stageTestnet();
    writeSchedule(ethers.parseUnits('200000001', 18));
    const before = await blockNo(s.f.provider);
    const r = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    says(r, 'HCOWToken mints', '합계가 공급량을 넘으면 거부한다');
    const after = await blockNo(s.f.provider);
    ok(before === after, `거부가 체인에 고아 토큰을 남기지 않는다 (블록 ${before} 그대로)`);
    ok(!hasRec(97), '그리고 레코드도 쓰이지 않았다');
    ok(!/^HCOWToken\s+0x/m.test(r.out), '출력에 배포된 토큰 주소가 없다');
    // 정상 합계는 통과한다.
    writeSchedule(ethers.parseUnits('200000000', 18));
    const good = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    ok(good.status === 0, '정확히 200,000,000 이면 진행된다');
  }

  console.log('\ndeploy-anchor.cjs — 드라이런이 첫 배포를 리허설할 수 있다 (8차 M-8)\n');
  {
    clearRec();
    const s = await stage();
    clearRec();   // 깨끗한 체인: 레코드가 아예 없는 상태가 이 케이스의 전부다
    const aEnv = (extra) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY,
      ANCHOR_OWNER: s.treasury, ANCHOR_PUBLISHER: '0x' + '77'.repeat(20), ...extra,
    });
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      const r = await run('deploy-anchor.cjs', aEnv({ [flag]: 'yes' }));
      ok(r.status === 0 && /DRY RUN/.test(r.out), `레코드가 없어도 ${flag}=yes 로 리허설된다`);
      ok(!hasRec(56), `그리고 ${flag}=yes 는 레코드를 만들지 않는다`);
    }
    // 실제 배포는 여전히 FIRST_DEPLOY 를 요구한다. 드라이런만 면제다.
    const live = await run('deploy-anchor.cjs', aEnv({}));
    says(live, 'FIRST_DEPLOY', '본 실행은 그대로 거부된다');
  }

  console.log('\ndeploy-claim.cjs — TGE_TIME 상식 검사 (8차 M-6 · M-7)\n');
  {
    const mk = async () => {
      clearRec();
      const s = await stage();
      writeRec(56, { chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token } });
      return s;
    };
    const cenv = (s, extra) => ({ ...env(s), CLAIM_DEADLINE: String(NOW + 800 * DAY), ...extra });
    let s = await mk();
    says(await run('deploy-claim.cjs', cenv(s, { TGE_TIME: String(WALLNOW - 400 * DAY) })),
      'is in the past', '과거 TGE 는 거부된다');
    ok(!readRec(56).addresses?.HCOWClaim, '그리고 배포되지 않았다');
    s = await mk();
    says(await run('deploy-claim.cjs', cenv(s, { TGE_TIME: String(WALLNOW + 400 * DAY) })),
      'more than 365 days', '365일을 넘는 TGE 는 거부된다');
    // 9차 감사 B-F4. 8차 판에 있던 "메인넷 2일 미만 TGE 거부" 는 근거 없이
    // deploy.cjs 에서 복사된 규칙이었고 탈출구도 없었다. 가드를 지웠으므로
    // 그 케이스도 지운다. 대신 36시간 전 재배포가 통과한다는 것을 확인한다 —
    // immutable 인자를 잘못 넣어 TGE 직전에 다시 배포해야 하는 상황이다.
    // 10차 감사: 9차 B-F4 는 틀렸다. 이 claim 을 채울 베스팅은 이 스크립트 다음에
    // deploy.cjs 로 배포되고 deploy.cjs 는 TGE 2일 안을 거부한다. 36시간 전에
    // claim 을 배포하면 어떤 베스팅도 자금을 줄 수 없는 claim 이 남는다 (재현함).
    s = await mk();
    const late = await run('deploy-claim.cjs', cenv(s, { TGE_TIME: String(WALLNOW + 36 * 3600) }));
    says(late, 'less than 2 days away', 'TGE 36시간 전 claim 배포는 메인넷에서 거부된다 (10차, 9차 B-F4 되돌림)');
    says(late, 'deployed AFTER it', '그리고 이번에는 진짜 이유 — 뒤따를 베스팅 배포 — 를 말한다');
    ok(!readRec(56).addresses?.HCOWClaim, '그리고 claim 이 배포되지 않았다');
    // 밀리초는 /^\d+$/ 를 통과한다. 9차 M-4: 8차 판은 needle 을 'TGE_TIME' 으로
    // 뒀는데, 그 문자열은 정상 로그의 "(TGE_TIME)" 라벨이 만족시키고 exit != 0 은
    // 무관한 가드(deadline <= tge)가 만족시켰다. 가드를 지워도 통과하는 단언이었다.
    // 이제 이 가드만이 낼 수 있는 문구를 단언한다.
    s = await mk();
    const ms = await run('deploy-claim.cjs', cenv(s, { TGE_TIME: String((WALLNOW + 30 * DAY) * 1000) }));
    // 10차 감사: 'more than 365 days' 는 env 가드와 체인 시계 가드 둘 다 낸다.
    // env 가드를 지워도 체인 시계 가드가 같은 문구로 이 단언을 만족시켰다.
    // env 가드만 내는 형태("TGE_TIME <값> is more than 365 days out")를 본다.
    says(ms, `TGE_TIME ${(WALLNOW + 30 * DAY) * 1000} is more than 365 days out`, '밀리초 TGE 는 env 범위 검사가 잡는다');
    says(ms, 'milliseconds, not seconds', '그리고 문구가 원인을 직접 말한다');
    ok(!/at or before TGE/.test(ms.out), '그리고 무관한 deadline<=tge 가드가 대신 만족시키지 않는다');
    // 8차 M-7. 메인넷 드라이런은 TGE 필수 검사를 건너뛰었다. 배너는 모든 검사가
    // 돈다고 말한다. 이제 드라이런도 같은 이유로 거부된다.
    s = await mk();
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      says(await run('deploy-claim.cjs', cenv(s, { [flag]: 'yes' })),
        'TGE_TIME must be set', `메인넷 ${flag} 도 TGE 없이는 통과하지 않는다`);
    }
    // 그리고 TGE 를 주면 드라이런이 통과한다. 위 케이스가 "드라이런이 늘 실패" 로
    // 만족되는 것을 막는다.
    s = await mk();
    const dry = await run('deploy-claim.cjs', cenv(s, { DRY_RUN: 'yes', TGE_TIME: String(WALLNOW + 30 * DAY) }));
    ok(dry.status === 0 && /months after TGE/.test(dry.out), 'TGE 를 주면 메인넷 드라이런이 통과하고 개월 수를 출력한다');
    ok(!readRec(56).addresses?.HCOWClaim, '그리고 드라이런은 아무것도 배포하지 않았다');
  }

  // ======================================================================
  // 8차 감사 L-5. load.cjs 와 seal.cjs 는 자식 프로세스로 돌리는 테스트가
  // 저장소 전체에 0건이었다. seal.cjs 는 이 프로젝트에서 가장 되돌릴 수 없는
  // 스크립트이고, 7차에서 손으로 7가지 조합을 확인한 것이 전부였다.
  //
  // 이 블록은 트레저리를 EOA 로 세운다. 다른 블록들은 MockSafe 를 쓰는데
  // (deploy-claim.cjs 가 메인넷에서 EOA 오너를 거부하므로 그쪽은 그래야 한다)
  // addSchedules 와 fundAndSeal 은 트레저리가 직접 서명해야 하므로 Safe 로는
  // 본 실행 경로를 한 번도 지나갈 수 없다. 실제 메인넷에서 그 경로는 PRINT_ONLY
  // 로 뽑아 Safe 에서 서명하는 것이고, 그쪽도 아래에서 같이 확인한다.
  // ======================================================================
  console.log('\nload.cjs · seal.cjs — 테스트가 하나도 없었다 (8차 L-5) · DRY_RUN (8차 M-10)\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    const treasuryEoa = await f.treasury.getAddress();
    const tk = await dep('HCOWToken', f.deployer, [treasuryEoa]);
    const s = { f, tk, token: await tk.getAddress(), treasury: treasuryEoa, chainId: 56 };
    // 10차·11차: 메인넷 순서 그대로 — 토큰과 claim 이 이미 있고 레코드가 둘을 부른다.
    await mainReady(s);
    const d = await run('deploy.cjs', menv(s));
    ok(d.status === 0, '토큰과 베스팅을 배포해 둔다');

    const lenv = (extra = {}) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', SCHEDULE: SCHED, TREASURY_KEY: KEY_TREASURY, ...extra,
    });

    // ---- load.cjs ----
    // 8차 M-10: 두 이름이 같은 뜻이어야 한다. 예전에는 PRINT_ONLY 만 알았고
    // DRY_RUN 은 전송만 막힌 뒤 되읽기에서 "9명을 기대했는데 체인은 0" 이라는
    // 엉뚱한 실패를 냈다. 그리고 둘 다 TREASURY_KEY 없이 돌아야 한다.
    for (const flag of ['PRINT_ONLY', 'DRY_RUN']) {
      const r = await run('load.cjs', lenv({ [flag]: 'yes', TREASURY_KEY: '' }));
      ok(r.status === 0 && r.out.includes('data   0x'),
        `load.cjs ${flag}=yes 는 키 없이 addSchedules calldata 를 찍는다`);
      // 11차: 이전 안내("PRINT_ONLY 없이 다시 돌려 확인")는 Safe 에서 실행할 수 없었다.
      ok(/DRY_RUN=yes node scripts\/seal\.cjs/.test(r.out) && !/without PRINT_ONLY to verify/.test(r.out),
        `load.cjs ${flag}=yes 는 Safe 에서 실제로 할 수 있는 확인 방법을 안내한다 (11차)`);
      ok(!/chain says 0/.test(r.out), `load.cjs ${flag}=yes 가 되읽기 실패로 끝나지 않는다`);
      ok(/addSchedules/.test(r.out), `load.cjs ${flag}=yes 가 어떤 호출인지 이름을 찍는다`);
    }
    says(await run('load.cjs', lenv({ DRY_RUN: 'mabye' })), 'Refusing to guess',
      'load.cjs 는 DRY_RUN 오타를 추측하지 않는다');
    says(await run('load.cjs', lenv({ TREASURY_KEY: KEY_OTHER })), 'owner-only',
      'load.cjs 는 소유자가 아닌 키를 거부한다');
    const loaded = await run('load.cjs', lenv({}));
    ok(loaded.status === 0, 'load.cjs 가 트레저리 키로 9개를 실제로 로드한다');

    // ---- seal.cjs ----
    const sealed0 = await run('seal.cjs', lenv({ DRY_RUN: 'yes', TREASURY_KEY: '' }));
    ok(sealed0.status === 0 && /DRY RUN/.test(sealed0.out),
      'seal.cjs DRY_RUN=yes 는 키 없이 전 검사를 통과하고 아무것도 보내지 않는다');
    // 10차: "TGE has not passed…" 는 ok(…, true) 였다. 아무것도 확인하지 않는 칸이
    // "10 of 10" 의 하나를 차지했다. 이제 9개다.
    ok(/9 of 9 checks passed/.test(sealed0.out), '그리고 9개 검사가 전부 통과했다고 말한다');
    ok(!/TGE has not passed, or the seal is still open/.test(sealed0.out.split('\n').filter((l) => /^\s+ok\s/.test(l)).join('\n')),
      '그리고 아무것도 확인하지 않던 검사가 더 이상 검사로 세어지지 않는다');
    const po = await run('seal.cjs', lenv({ PRINT_ONLY: 'yes', TREASURY_KEY: '' }));
    ok(po.status === 0 && po.out.includes('data   0x'),
      'seal.cjs PRINT_ONLY=yes 는 키 없이 approve · fundAndSeal calldata 를 찍는다');
    ok(/fundAndSeal/.test(po.out), '그리고 fundAndSeal 이라는 이름이 출력에 있다');
    says(await run('seal.cjs', lenv({ PRINT_ONLY: 'nope' })), 'Refusing to guess',
      'seal.cjs 도 오타를 추측하지 않는다');
    // 10차 감사: 이 단언은 exit != 0 만 봤다. 스크립트의 서명자 대조를 지워도
    // PASS 였다 — approve() 가 체인에 실제로 나가고 fundAndSeal 이 컨트랙트에서
    // 되돌려져 exit != 0 이 됐기 때문이다. 스크립트 가드가 멈춘 것이 아니었다.
    // 이제 스크립트 가드만 내는 문구와, 체인에 아무것도 나가지 않았다는 것을 본다.
    {
      const b = await blockNo(s.f.provider);
      const other = await run('seal.cjs', lenv({ TREASURY_KEY: KEY_OTHER }));
      says(other, 'TREASURY_KEY is', 'seal.cjs 는 소유자가 아닌 키로 봉인하지 않는다');
      ok(b === await blockNo(s.f.provider), '그리고 그 키로는 approve 조차 나가지 않았다');
    }

    // 봉인 불변식. 스케줄 파일을 1 wei 옮기면 봉인이 거부되어야 한다. CLAUDE.md
    // 의 "HCOW 1 wei 만 움직여도 _seal() 의 검사에 걸린다" 가 이 경로다.
    const keep = fs.readFileSync(SCHED, 'utf8');
    const t = JSON.parse(keep);
    t.rows[0].total = (BigInt(t.rows[0].total) + 1n).toString();
    t.rows[8].total = (BigInt(t.rows[8].total) - 1n).toString();
    fs.writeFileSync(SCHED, JSON.stringify(t, null, 2));
    const drift = await run('seal.cjs', lenv({ DRY_RUN: 'yes', TREASURY_KEY: '' }));
    ok(drift.status !== 0 && /rows differ/.test(drift.out),
      '스케줄 파일이 체인과 1 wei 라도 다르면 seal.cjs 가 거부한다');
    fs.writeFileSync(SCHED, keep);

    // 그리고 실제로 봉인된다. 위의 거부 케이스들이 "seal 은 늘 실패한다" 로
    // 만족되는 것을 막는 유일한 방법이다.
    const va = art('HCOWVesting');
    const vest = readRec(56).addresses.HCOWVesting;
    const vc = new ethers.Contract(vest, va.abi, s.f.provider);
    ok(Number(await vc.beneficiaryCount()) === 9, '봉인 전 beneficiaryCount() 가 정확히 9 다');
    ok(await vc.sealed_() === false, '그리고 아직 봉인되지 않았다');
    // 11차 감사: set-root 가 베스팅이 풀어줄 양을 세는 것은 봉인된 뒤에만 맞다.
    // 봉인 전에는 release() 가 되돌려지고 베스팅은 아직 HCOW 를 들고 있지도 않다.
    // 스케줄 행은 load.cjs 뒤에 이미 존재하므로, 봉인 여부를 보지 않으면 봉인 전에도
    // "그때 풀릴 양" 을 세어 0번 라운드를 통과시킨다. 봉인 전에는 거부되어야 한다.
    const { buildRound: br11 } = require('../scripts/merkle.cjs');
    const dir11 = path.join(ROOT, 'build', 'r11-tree');
    const put11 = (amountWei) => {
      const t = br11(0, [{ account: '0x' + '44'.repeat(20), amount: amountWei.toString() }]);
      fs.mkdirSync(dir11, { recursive: true });
      fs.writeFileSync(path.join(dir11, 'round-0.json'), JSON.stringify(
        { roundId: 0, merkleRoot: t.root, startTime: TGE, count: t.count, total: t.total, claims: t.claims }, null, 2));
      fs.writeFileSync(path.join(dir11, 'rounds.json'), JSON.stringify({ rounds: [
        { roundId: 0, merkleRoot: t.root, startTime: TGE, count: t.count, total: t.total }] }, null, 2));
    };
    const sr11 = (extra = {}) => run('set-root.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', PRINT_ONLY: 'yes', ...extra },
      ['--rounds', path.join(dir11, 'rounds.json'), '--round', '0']);
    {
      put11(1000n * E);
      const early = await sr11();
      ok(early.status !== 0 && /is not sealed, so nothing it holds counts yet/.test(early.out) &&
         /Release the bucket first/.test(early.out) && !early.out.includes('data   0x'),
        '봉인 전에는 베스팅이 풀어줄 양을 세지 않아 0번 라운드가 거부된다 (11차)');
      fs.rmSync(dir11, { recursive: true, force: true });
    }
    const done = await run('seal.cjs', lenv({}));
    ok(done.status === 0, 'seal.cjs 가 트레저리 키로 실제로 봉인한다');
    ok(await vc.sealed_() === true, '그리고 체인이 sealed_() === true 를 읽는다');
    ok(await vc.totalScheduled() === ethers.parseUnits('200000000', 18),
      '봉인된 합계가 정확히 200,000,000 HCOW 다');

    // ---- 11차 감사. 봉인 뒤 · TGE 전의 두 가지 ----
    //
    // (a) seal.cjs 가 봉인 확인 도구로 안내하는 release.cjs 보고 모드는 TGE 전에
    //     곧바로 돌아가서 TGE 언락 대조를 하지 않았다. 봉인은 TGE 전에 한다.
    {
      const pre = await run('release.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', SCHEDULE: SCHED });
      ok(pre.status === 0 && /matching the schedule file/.test(pre.out) && /TGE has not happened/.test(pre.out),
        'TGE 전에도 release.cjs 보고 모드가 TGE 언락을 스케줄과 대조한다 (11차)');
    }
    // (b) 0번 라운드는 TGE 에 열리고, notice 때문에 TGE 전에 등록해야 한다. 그때 claim
    //     잔고는 언제나 0 이다. set-root 는 이제 봉인된 베스팅이 그 시점까지 claim 에
    //     풀어줄 양을 센다. 9차까지는 ALLOW_UNDERFUNDED=yes 없이는 등록이 불가능했다.
    {
      const put = put11, sr = sr11;
      put(1000n * E);
      const fundedLater = await sr();
      ok(fundedLater.status === 0 && fundedLater.out.includes('data   0x'),
        '0번 라운드(TGE 개시)가 ALLOW_UNDERFUNDED 없이 등록된다 — 베스팅이 그때 풀어줄 양을 센다 (11차)');
      ok(/will have released/.test(fundedLater.out) && /release\(0x/.test(fundedLater.out),
        '그리고 누가 release 를 불러야 하는지 출력한다');
      // 긍정 대조군의 짝: 베스팅이 풀어줄 양보다 큰 라운드는 여전히 거부된다.
      put(ethers.parseUnits('10000000', 18));
      says(await sr(), 'the vesting will release by then', '베스팅이 그때 풀어줄 양을 넘는 라운드는 거부된다 (11차)');

      // 12차 감사 M-B. 라운드마다 따로 보면 맞지만 누계로는 넘치는 경우.
      // HCOWClaim 은 잔고 하나를 모든 라운드가 나눠 쓴다.
      {
        const { vestedAt: vA } = require('../scripts/commitcheck.cjs');
        const rec12 = readRec(56);
        const vc12 = new ethers.Contract(rec12.addresses.HCOWVesting, art('HCOWVesting').abi, s.f.provider);
        const sc = await vc12.schedules(rec12.addresses.HCOWClaim);
        const vtge = await vc12.tgeTime();
        const row = { total: sc.total, tgeBps: sc.tgeBps, cliffMonths: sc.cliffMonths, linearMonths: sc.linearMonths };
        const start1 = TGE + 60 * 86400;
        const x = vA(row, vtge, BigInt(TGE));
        const v1 = vA(row, vtge, BigInt(start1));
        ok(x > 0n && v1 > x, '(전제) claim 행이 TGE 에 풀리고 그 뒤에도 더 풀린다');
        const put2 = (a0, a1) => {
          const t0 = br11(0, [{ account: '0x' + '44'.repeat(20), amount: a0.toString() }]);
          const t1 = br11(1, [{ account: '0x' + '45'.repeat(20), amount: a1.toString() }]);
          fs.mkdirSync(dir11, { recursive: true });
          fs.writeFileSync(path.join(dir11, 'round-0.json'), JSON.stringify(
            { roundId: 0, merkleRoot: t0.root, startTime: TGE, count: t0.count, total: t0.total, claims: t0.claims }, null, 2));
          fs.writeFileSync(path.join(dir11, 'round-1.json'), JSON.stringify(
            { roundId: 1, merkleRoot: t1.root, startTime: start1, count: t1.count, total: t1.total, claims: t1.claims }, null, 2));
          fs.writeFileSync(path.join(dir11, 'rounds.json'), JSON.stringify({ rounds: [
            { roundId: 0, merkleRoot: t0.root, startTime: TGE, count: t0.count, total: t0.total },
            { roundId: 1, merkleRoot: t1.root, startTime: start1, count: t1.count, total: t1.total }] }, null, 2));
        };
        const sr1 = () => run('set-root.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', PRINT_ONLY: 'yes' },
          ['--rounds', path.join(dir11, 'rounds.json'), '--round', '1']);
        // 대조군: 누계가 정확히 그때까지 풀린 양이면 등록된다.
        put2(x, v1 - x);
        const fits = await sr1();
        ok(fits.status === 0 && fits.out.includes('data   0x'),
          '누계가 베스팅이 그때까지 푼 양과 같으면 1번 라운드가 등록된다 (12차 대조군)');
        // 1 HCOW 넘치면: 1번 라운드 단독으로는 v1 이하지만 0번과 합치면 넘친다.
        put2(x, v1 - x + E);
        ok(v1 - x + E <= v1, '(전제) 1번 라운드 단독으로는 그때 풀린 양 이하다');
        const over = await sr1();
        ok(over.status !== 0 && /the rounds open by then pay/.test(over.out) && !over.out.includes('data   0x'),
          '앞 라운드와 합친 누계가 넘치면 1번 라운드가 거부된다 (12차)');

        // 이미 등록된 앞 라운드는 체인의 루트와 대조한다. 파일이 체인과 다르면 이
        // 빌드의 합계는 claim 이 실제로 진 빚이 아니다.
        put11(1000n * E);
        const live = await run('set-root.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', TREASURY_KEY: KEY_TREASURY },
          ['--rounds', path.join(dir11, 'rounds.json'), '--round', '0']);
        ok(live.status === 0, '(준비) 0번 라운드를 1,000 HCOW 로 실제로 등록한다');
        put2(1000n * E, E);
        const same = await sr1();
        ok(same.status === 0 && same.out.includes('data   0x'),
          '대조군: 파일의 0번 루트가 체인과 같으면 1번 라운드가 등록된다 (12차)');
        // 14차 감사 M-1: 아직 열리지 않은 라운드의 루트가 파일과 다른 것은 TGE 전 정정
        // (재빌드)의 정상 상태다. 12차 판은 여기서 멈췄고, 13차 판은 모든 라운드를
        // 거부해 정정 경로를 닫았다. 이제 파일의 판으로 세고 교체하라고 경고한다.
        // 이미 열린 라운드의 불일치는 아래 13차 무베스팅 블록에서 거부를 확인한다.
        put2(x, v1 - x);
        const staleR = await sr1();
        ok(staleR.status === 0 && /registered with a different root than this build/.test(staleR.out),
          '아직 열리지 않은 앞 라운드의 루트가 파일과 다르면 파일 판으로 세고 교체하라고 경고한다 (14차)');

        // ---- 13차 감사 ----
        // 여기서 체인에는 0번(TGE, 1,000 HCOW)이 등록돼 있다. 라운드 파일을 자유롭게 쓴다.
        const put = (list) => {
          fs.rmSync(dir11, { recursive: true, force: true });
          fs.mkdirSync(dir11, { recursive: true });
          const sum = [];
          for (const r of list) {
            const t = br11(r.id, [{ account: r.account, amount: r.amount.toString() }]);
            fs.writeFileSync(path.join(dir11, `round-${r.id}.json`), JSON.stringify(
              { roundId: r.id, merkleRoot: t.root, startTime: r.start, count: t.count, total: t.total, claims: t.claims }, null, 2));
            sum.push({ roundId: r.id, merkleRoot: t.root, startTime: r.start, count: t.count, total: t.total, root: t.root });
          }
          fs.writeFileSync(path.join(dir11, 'rounds.json'), JSON.stringify({ rounds: sum }, null, 2));
          return Object.fromEntries(sum.map((x) => [x.roundId, x.root]));
        };
        const srN = (id, extra = {}) => run('set-root.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', PRINT_ONLY: 'yes', ...extra },
          ['--rounds', path.join(dir11, 'rounds.json'), '--round', String(id)]);
        const srLive = (id) => run('set-root.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', TREASURY_KEY: KEY_TREASURY },
          ['--rounds', path.join(dir11, 'rounds.json'), '--round', String(id)]);
        const r0 = { id: 0, account: '0x' + '44'.repeat(20), amount: 1000n * E, start: TGE };
        const v60 = v1;                         // start1 = TGE + 60일
        const s90 = TGE + 90 * 86400, v90 = vA(row, vtge, BigInt(s90));
        const s70 = TGE + 70 * 86400, v70 = vA(row, vtge, BigInt(s70));
        const acct = (n) => '0x' + n.repeat(20);

        // (d) 등록되지 않았고 이제 그 시각으로 등록할 수도 없는 라운드는 빚이 아니다.
        const chainNow = (await s.f.provider.getBlock('latest')).timestamp;
        put([r0, { id: 5, account: acct('55'), amount: 10000000n * E, start: chainNow + 3600 },
             { id: 1, account: acct('45'), amount: E, start: start1 }]);
        const skip = await srN(1);
        ok(skip.status === 0 && /round 5 is not registered and can no longer open/.test(skip.out),
          '등록할 수 없게 된 미등록 라운드는 누계에 넣지 않는다 (13차)');

        // (a) 이 라운드보다 뒤에 열리도록 이미 등록된 라운드도 누계 시점으로 본다.
        //     파일에 1번이 없을 때 2번(+90일)을 실제로 등록한 뒤, 1번(+60일)을 끼운다.
        const r2 = { id: 2, account: acct('46'), amount: v90 - v60 + E, start: s90 };
        put([r0, r2]);
        const reg2 = await srLive(2);
        ok(reg2.status === 0, '(준비) 2번 라운드(+90일)를 실제로 등록한다');
        put([r0, { id: 1, account: acct('45'), amount: v60 - 1000n * E - E, start: start1 }, r2]);
        const fitA = await srN(1);
        ok(fitA.status === 0 && fitA.out.includes('data   0x'),
          '대조군: 끼운 1번이 2번 시점 누계를 넘지 않으면 등록된다 (13차)');
        put([r0, { id: 1, account: acct('45'), amount: v60 - 1000n * E, start: start1 }, r2]);
        const overA = await srN(1);
        ok(overA.status !== 0 && /round 2 \(already registered\) opens/.test(overA.out),
          '끼운 라운드 때문에 뒤에 이미 등록된 라운드가 넘치면 거부된다 (13차)');

        // (b) 등록된 라운드의 시각은 체인에서 읽는다. 3번을 파일(+200일)과 다른 +70일로 등록한다.
        const a1 = v60 - 1000n * E - E;         // 위 대조군의 1번
        const r3amt = v70 - 1000n * E - a1 + E; // +70일 시점에만 1 HCOW 넘친다
        const roots = put([r0, { id: 1, account: acct('45'), amount: a1, start: start1 }, r2,
                           { id: 3, account: acct('47'), amount: r3amt, start: TGE + 200 * 86400 }]);
        // 자식 프로세스가 같은 트레저리 키로 보냈으므로 이 프로세스의 nonce 캐시를 버린다.
        s.f.treasury.reset();
        await new Promise((r) => setTimeout(r, 400));
        const clW = new ethers.Contract(readRec(56).addresses.HCOWClaim, art('HCOWClaim').abi, s.f.treasury);
        await (await clW.setRoot(3, roots[3], s70)).wait();
        const overB = await srN(1);
        ok(overB.status !== 0 && /round 3 is registered on chain to open/.test(overB.out) &&
           /round 3 \(already registered\) opens/.test(overB.out),
          '파일과 다른 시각으로 등록된 라운드는 체인의 시각으로 센다 (13차)');
      }
      fs.rmSync(dir11, { recursive: true, force: true });
    }
    // 봉인 후에는 같은 스크립트가 다시 봉인하지 않는다.
    // 10차 감사: 이것도 exit != 0 만 봤다. "not already sealed" 검사를 끄면
    // approve(…, 0) 가 체인에 나간 뒤 컨트랙트가 되돌렸고, 단언은 PASS 였다.
    const bAgain = await blockNo(s.f.provider);
    const again = await run('seal.cjs', lenv({}));
    // 11차 감사: needle 'the contract is not already sealed' 는 통과할 때도
    // "  ok    the contract is not already sealed" 로 찍힌다. 가드를 꺼도 PASS 였다.
    // 실패 줄만 본다.
    says(again, 'FAIL  the contract is not already sealed', '봉인된 컨트랙트에 대해 seal.cjs 를 다시 돌리면 거부된다');
    ok(bAgain === await blockNo(s.f.provider), '그리고 그때 아무것도 나가지 않았다');

    // ---- 9차 감사 A-5. 봉인된 베스팅을 REPLACE_VESTING 으로 덮어쓸 수 없다 ----
    //
    // 8차 판의 거부 문구는 "AND it has not been sealed" 라고 조건을 걸면서 봉인
    // 여부를 읽는 코드가 없었다. 재현: sealed:true 레코드에 REPLACE_VESTING=1 로
    // 돌리면 exit 0 으로 새 베스팅을 기록하고 sealed 를 false 로 덮어써서,
    // 200,000,000 을 들고 봉인된 컨트랙트가 어떤 파일에도 남지 않았다.
    // 레코드의 sealed 플래그는 저장소에서 아무도 읽지 않으므로 체인에서 읽는다.
    const sealedRec = readRec(56);
    const replace = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token, REPLACE_VESTING: '1' }));
    says(replace, 'IS SEALED', 'REPLACE_VESTING=1 로도 봉인된 베스팅은 교체되지 않는다');
    ok(readRec(56).addresses.HCOWVesting === sealedRec.addresses.HCOWVesting,
      '그리고 레코드의 베스팅 주소가 그대로다');
    // 레코드가 봉인을 주장하든 말든 체인이 근거다. sealed 플래그를 지워도 같다.
    writeRec(56, { ...sealedRec, sealed: false });
    const replace2 = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token, REPLACE_VESTING: '1' }));
    says(replace2, 'IS SEALED', '레코드의 sealed 플래그를 false 로 고쳐도 체인을 읽어 거부한다');
    writeRec(56, sealedRec);

    // ---- 9차 감사 B-F5. release.cjs 는 두 억제 이름을 다 몰랐다 ----
    //
    // 재현: RELEASE=yes DRY_RUN=yes PRINT_ONLY=yes 로 돌리니 release() 9건이
    // 실제로 나가고 31.8M HCOW 가 움직였다. 자금 손실은 아니지만(수취인에게 가고
    // permissionless 다) 되돌릴 수 없고, 리허설이라 믿은 시점에 TGE 언락 물량의
    // 지급 시각이 결정된다. 그리고 이 스크립트를 자식 프로세스로 돌리는 테스트가
    // 저장소 전체에 0건이었다.
    console.log('\nrelease.cjs — 억제 플래그와 첫 테스트 (9차 B-F5)\n');
    s.f.node.setTime(TGE + 10 * DAY);
    const renv = (extra = {}) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', SCHEDULE: SCHED, ...extra,
    });
    const totalReleased = async () => BigInt(await vc.totalReleased());
    const before = await totalReleased();
    const report = await run('release.cjs', renv({}));
    ok(report.status === 0 && /Report only/.test(report.out), 'RELEASE 없이는 보고만 한다');
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      const r = await run('release.cjs', renv({ RELEASE: 'yes', [flag]: 'yes' }));
      ok(r.status === 0, `RELEASE=yes ${flag}=yes 는 DEPLOYER_KEY 없이 exit 0`);
      ok(/DRY RUN/.test(r.out) && r.out.includes('data  0x'),
        `RELEASE=yes ${flag}=yes 는 release() calldata 를 찍는다`);
      ok(!/tx 0x/.test(r.out), `RELEASE=yes ${flag}=yes 는 트랜잭션을 보내지 않는다`);
      ok(await totalReleased() === before, `RELEASE=yes ${flag}=yes 뒤에도 totalReleased 가 그대로다`);
    }
    says(await run('release.cjs', renv({ RELEASE: 'yes', DRY_RUN: 'mabye' })), 'Refusing to guess',
      'release.cjs 도 오타를 추측하지 않는다');
    ok(await totalReleased() === before, '오타 실행 뒤에도 totalReleased 가 그대로다');
    const live = await run('release.cjs', renv({ RELEASE: 'yes', DEPLOYER_KEY: KEY_DEPLOY }));
    ok(live.status === 0 && /tx 0x/.test(live.out), '억제 플래그가 없으면 실제로 지급된다');
    ok(await totalReleased() > before, '그리고 totalReleased 가 늘었다');

    // 10차 감사: 보고 모드와 억제 모드는 TGE 언락 불일치 FAIL 을 찍고도 exit 0 이었다.
    // 라이브만 exit 1 이어서 리허설은 초록이고 실전은 빨강이었다. 스케줄 파일 사본의
    // 한 행에서 tgeBps 만 바꿔(여전히 유효한 값) 불일치를 만든다.
    const skewed = JSON.parse(fs.readFileSync(SCHED, 'utf8'));
    skewed.rows[0].tgeBps = skewed.rows[0].tgeBps === 1350 ? 1400 : 1350;
    const SKEW = path.join(path.dirname(SCHED), 'opsguard-sched-skew.json');
    fs.writeFileSync(SKEW, JSON.stringify(skewed, null, 2));
    const mism = await run('release.cjs', renv({ SCHEDULE: SKEW }));
    ok(mism.status !== 0 && /NOT matching/.test(mism.out), '보고 모드도 TGE 언락 불일치에 exit 1 이다 (10차)');
    const mismDry = await run('release.cjs', renv({ SCHEDULE: SKEW, RELEASE: 'yes', DRY_RUN: 'yes' }));
    ok(mismDry.status !== 0 && /NOT matching/.test(mismDry.out), '억제 모드도 불일치에 exit 1 이다 (10차)');
    const matchReport = await run('release.cjs', renv({}));
    ok(matchReport.status === 0, '일치하는 파일로는 보고 모드가 exit 0 이다 — 위 단언이 "늘 1" 로 만족되지 않게');
    fs.rmSync(SKEW, { force: true });
  }

  // ======================================================================
  // 9차 감사 조치. 8차 조치를 적대적으로 재검해서 나온 것들.
  // ======================================================================

  console.log('\ndeploy.cjs — 드라이런은 HCOW_ADDRESS 가 있어도 아무것도 배포하지 않는다 (9차 A-3)\n');
  {
    // 8차 판의 드라이런 케이스 10개가 전부 HCOW_ADDRESS 없이 돌았다. 그 경로에서
    // 조기 return 을 지우면 token===null 이라 ethers 가 생성자 인자 인코딩에서
    // 먼저 던지고, 스위트는 그 **우연** 때문에 빨개졌다. 정작 문서화된 메인넷
    // 리허설 명령(token → claim → vesting 순서이므로 deploy.cjs 는 늘
    // HCOW_ADDRESS 와 함께 돈다)에 대해 "아무것도 배포되지 않는다" 를 단언하는
    // 케이스가 한 건도 없었다. `return` 을 `if (!token) return;` 로 바꿔도 전
    // 스위트가 초록이었다.
    writeSchedule(ethers.parseUnits('200000000', 18));
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      clearRec();
      const s = await stageWall();
      await mainReady(s);
      const before = await blockNo(s.f.provider);
      const r = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token, [flag]: 'yes' }));
      ok(r.status === 0 && /DRY RUN/.test(r.out), `${flag}=yes + HCOW_ADDRESS 는 exit 0`);
      ok(before === await blockNo(s.f.provider),
        `${flag}=yes + HCOW_ADDRESS 로는 베스팅도 배포되지 않는다 (블록 ${before})`);
      ok(!readRec(56).addresses.HCOWVesting, '그리고 레코드에 베스팅이 적히지 않는다');
      ok(!/did NOT run/.test(r.out), 'HCOW_ADDRESS 가 있으므로 신원 검사는 돌았다고 말한다');
    }
    // 그리고 드라이런은 건너뛴 검사를 스스로 밝힌다 (9차 A-6).
    clearRec();
    const s = await stageTestnet();
    const skip = await run('deploy.cjs', denv(s, { DRY_RUN: 'yes' }));
    ok(skip.status === 0, '레코드가 없어도 드라이런은 돈다 — 첫 배포 리허설이 가능해야 한다');
    ok(/CHECKS THIS DRY RUN DID NOT MAKE/.test(skip.out), '그리고 건너뛴 검사가 있다고 제목을 단다');
    ok(/does not exist/.test(skip.out) && /FIRST_DEPLOY=1/.test(skip.out),
      '그리고 라이브 실행이 무엇을 요구할지 미리 말한다');
    ok(!/Every check/.test(skip.out), '더 이상 "모든 검사가 통과했다" 고 말하지 않는다');
    // 잔액 0 도 드라이런에서는 통과하고, 그 사실을 밝힌다. 라이브는 거부한다.
    clearRec();
    const zf = await boot({ chainId: 97, now: WALLNOW, balances: { [ethers.getAddress(new ethers.Wallet(KEY_DEPLOY).address).toLowerCase()]: '0' } });
    const zsafe = await dep('MockSafe', zf.deployer, [await zf.treasury.getAddress()]);
    const ztreasury = await zsafe.getAddress();
    const ztk = await dep('HCOWToken', zf.deployer, [ztreasury]);
    const zs = { f: zf, tk: ztk, token: await ztk.getAddress(), treasury: ztreasury, chainId: 97 };
    const zdry = await run('deploy.cjs', denv(zs, { FIRST_DEPLOY: '1', DRY_RUN: 'yes' }));
    ok(zdry.status === 0, '잔액 0 이어도 드라이런은 돈다');
    ok(/has no BNB \(checked only on the live run\)/.test(zdry.out), '그리고 그 검사를 건너뛴 것을 밝힌다');
    const zlive = await run('deploy.cjs', denv(zs, { FIRST_DEPLOY: '1' }));
    says(zlive, 'deployer has no BNB', '라이브 실행은 잔액 0 을 거부한다');
  }

  console.log('\ndeploy.cjs — 레코드의 addresses 는 값까지 본다 (9차 A-1)\n');
  {
    writeSchedule(ethers.parseUnits('200000000', 18));
    // 8차 판은 키 개수만 봤다. 아래 세 가지 모두 exit 0 으로 두 번째 토큰을 배포했다.
    for (const [label, addrs] of [
      ['HCOWToken: null', { HCOWToken: null }],
      ['HCOWToken: ""', { HCOWToken: '' }],
      ['HCOWToken: 주소가 아닌 문자열', { HCOWToken: 'not-an-address' }],
      ['알 수 없는 키만', { note: 'wiped by hand' }],
      // 9차 사보타주에서 나온 케이스. 위 네 가지는 "알려진 키 중 하나가 진짜
      // 주소" 절만으로도 거부되므로, 키별 엄격성 절을 지워도 전 스위트가
      // 초록이었다. 그 절이 필요한 형태는 이것이다: 앵커는 진짜 주소인데
      // 토큰 항목만 쓰레기인 레코드. usable() 이 통과시키면 recordedToken 이
      // falsy 라 재실행 가드 두 개가 조용히 풀린다.
      ['앵커는 진짜 주소, 토큰만 null', { HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)), HCOWToken: null }],
      ['앵커는 진짜 주소, 토큰만 쓰레기', { HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)), HCOWToken: '0xnope' }],
    ]) {
      clearRec();
      const s = await stageWall();
      writeRec(56, { chainId: 56, addresses: addrs });
      const before = await blockNo(s.f.provider);
      const r = await run('deploy.cjs', menv(s));
      says(r, 'is not a record any script here can trust', `addresses 가 {${label}} 이면 거부한다`);
      // 10차: 그리고 FIRST_DEPLOY 로도 넘어가지 않는다. 9차에는 넘어갔고, 그게
      // 봉인된 베스팅을 레코드에서 지우는 경로였다.
      const f2 = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
      says(f2, 'FIRST_DEPLOY included', `{${label}} 은 FIRST_DEPLOY=1 로도 넘어가지 않는다`);
      ok(before === await blockNo(s.f.provider), `그리고 {${label}} 에서 아무것도 배포되지 않았다`);
    }
    // 긍정 대조군: 값이 진짜 주소이면 통과해야 한다 (테스트넷: 메인넷은 토큰 기록을 요구한다).
    clearRec();
    const s2 = await stageTestnet();
    writeRec(97, { chainId: 97, addresses: { HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)) } });
    const good = await run('deploy.cjs', denv(s2, { HCOW_ADDRESS: s2.token }));
    ok(good.status === 0, '앵커 주소가 진짜 주소이면 통과한다');
  }

  console.log('\ndeploy.cjs — 생성자가 거부할 인자는 배포 전에 전부 걸러낸다 (9차 A-2)\n');
  {
    // 201행 테이블은 합계가 정확히 200,000,000 이라 8차의 공급량 검사를 통과하고,
    // HCOWToken 이 실제로 배포된 뒤 생성자가 CommitmentMismatch 로 revert 했다.
    // 10차 감사: 이 케이스는 메인넷에서만 돌았는데, 메인넷에서는 이 사전 검사가
    // 필요 없다(9행 등식이 먼저 걸리고 이제 새 토큰 경로 자체가 없다). 가드가
    // 존재하는 이유는 테스트넷의 새 토큰 경로다. `if (mainnet && …)` 로 바꿔도
    // 이 블록이 초록이었다. 테스트넷에서 돈다.
    clearRec();
    const s = await stageTestnet();
    writeSchedule(ethers.parseUnits('200000000', 18), 201);
    const before = await blockNo(s.f.provider);
    const r = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    says(r, 'MAX_BENEFICIARIES', '201행은 배포 전에 거부된다');
    ok(before === await blockNo(s.f.provider), `그리고 고아 토큰이 생기지 않는다 (블록 ${before})`);
    ok(!hasRec(97), '그리고 레코드도 쓰이지 않았다');
    ok(!/^HCOWToken\s+0x/m.test(r.out), '출력에 배포된 토큰 주소가 없다');
  }

  console.log('\ndeploy.cjs — 메인넷 봉인 불변식은 등식이다 (9차 A-4)\n');
  {
    // 8차 판은 `>` 만 봤다. 0 하나가 빠진 20,000,000 테이블로 deploy → load → seal
    // 전 단계가 exit 0 이고, beneficiaryCount()==9 인 채로 공급량의 1/10 만
    // 커밋된 상태로 되돌릴 수 없게 봉인됐다.
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('20000000', 18));
    const before = await blockNo(s.f.provider);
    const r = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    says(r, 'must schedule exactly', '합계가 200,000,000 미만이면 메인넷에서 거부된다');
    says(r, 'sealing invariant is an equality', '그리고 왜 등식인지 말한다');
    ok(before === await blockNo(s.f.provider), '그리고 아무것도 배포되지 않았다');
    // 1 wei 부족도 부족이다. 그리고 문구가 wei 를 말해야 한다 (9차 A-8).
    writeSchedule(ethers.parseUnits('200000000', 18) - 1n);
    const oneWei = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    says(oneWei, 'must schedule exactly', '1 wei 부족도 거부된다');
    ok(/199999999999999999999999999 wei/.test(oneWei.out), '그리고 문구가 wei 단위로 말한다 — tok() 은 같은 숫자를 낸다');
    // 행 수도 등식이다.
    writeSchedule(ethers.parseUnits('200000000', 18), 8);
    const eight = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    says(eight, 'exactly 9 rows', '메인넷에서 8행은 거부된다');
    // 테스트넷에서는 두 등식 모두 적용되지 않는다. 테스트넷 스케줄은 합계가 작다.
    clearRec();
    const t = await boot({ chainId: 97, now: WALLNOW });
    const tsafe = await dep('MockSafe', t.deployer, [await t.treasury.getAddress()]);
    const ttre = await tsafe.getAddress();
    const ttk = await dep('HCOWToken', t.deployer, [ttre]);
    const ts = { f: t, tk: ttk, token: await ttk.getAddress(), treasury: ttre, chainId: 97 };
    writeSchedule(ethers.parseUnits('20000000', 18), 8);
    const tr = await run('deploy.cjs', { ...denv(ts, { FIRST_DEPLOY: '1' }), CHAIN_ID: '97' });
    ok(tr.status === 0, '테스트넷에서는 8행 20,000,000 도 배포된다 — 등식은 메인넷 한정이다');
    clearRec();
    writeSchedule(ethers.parseUnits('200000000', 18));
  }

  console.log('\ndeploy.cjs — 레코드의 chainId 는 있어야 한다 (9차 A-7)\n');
  {
    clearRec();
    const s = await stageWall();
    writeRec(56, { addresses: { HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)) } });
    const r = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token }));
    says(r, 'has no chainId field', 'chainId 가 없는 레코드는 거부된다');
    says(r, 'belongs to this chain', '그리고 왜 위험한지 말한다');
    // 그리고 deploy-anchor.cjs 가 이제 chainId 를 쓴다 — 위 형태를 만드는 곳이었다.
    clearRec();
    const anchorRun = await run('deploy-anchor.cjs', {
      RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY,
      ANCHOR_OWNER: s.treasury, ANCHOR_PUBLISHER: '0x' + '77'.repeat(20), FIRST_DEPLOY: '1',
    });
    ok(anchorRun.status === 0, 'deploy-anchor.cjs 가 돈다');
    ok(Number(readRec(56).chainId) === 56, '그리고 이제 레코드에 chainId 를 쓴다');
    // deploy-token.cjs 와 deploy-claim.cjs 가 한 일을 흉내낸다 (메인넷은 둘 다 요구한다).
    const a7claim = await realClaim(s);
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 3: { beneficiary: a7claim } });
    writeRec(56, { ...readRec(56), treasury: s.treasury,
      addresses: { ...readRec(56).addresses, HCOWToken: s.token, HCOWClaim: a7claim } });
    const after = await run('deploy.cjs', denv(s, { HCOW_ADDRESS: s.token }));
    ok(after.status === 0, '그래서 앵커 먼저 배포한 뒤의 deploy.cjs 가 통과한다');
  }

  console.log('\ndeploy-claim.cjs — 9차 B-F1 · B-F2 · B-F3\n');
  {
    const mk = async (balance) => {
      clearRec();
      const opts = { chainId: 56, now: NOW };
      if (balance !== undefined) {
        opts.balances = { [new ethers.Wallet(KEY_DEPLOY).address.toLowerCase()]: balance };
      }
      const f = await boot(opts);
      const safe = await dep('MockSafe', f.deployer, [await f.treasury.getAddress()]);
      const treasury = await safe.getAddress();
      const tk = await dep('HCOWToken', f.deployer, [treasury]);
      const st = { f, tk, token: await tk.getAddress(), treasury, chainId: 56 };
      writeRec(56, { chainId: 56, treasury, addresses: { HCOWToken: st.token } });
      return st;
    };
    // B-F1. 형제 셋은 드라이런에서 잔액 검사를 면제하는데 이 파일만 빠져 있었다.
    const z = await mk('0');
    const zdry = await run('deploy-claim.cjs', {
      RPC_URL: z.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: z.token,
      CLAIM_OWNER: z.treasury, CLAIM_DEADLINE: String(NOW + 800 * DAY), CLAIM_NOTICE_SECONDS: '259200',
      CLAIM_WINDOW_SECONDS: '7776000', TGE_TIME: String(WALLNOW + 30 * DAY), DRY_RUN: 'yes' });
    ok(zdry.status === 0, '잔액 0 이어도 deploy-claim.cjs 의 드라이런은 끝까지 돈다 (9차 B-F1)');
    ok(/DRY RUN/.test(zdry.out) && /months after TGE/.test(zdry.out),
      '그리고 배너가 약속한 대로 immutable 인자 검사들이 실제로 돌았다');
    const zlive = await run('deploy-claim.cjs', {
      RPC_URL: z.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: z.token,
      CLAIM_OWNER: z.treasury, CLAIM_DEADLINE: String(NOW + 800 * DAY), CLAIM_NOTICE_SECONDS: '259200',
      CLAIM_WINDOW_SECONDS: '7776000', TGE_TIME: String(WALLNOW + 30 * DAY) });
    says(zlive, 'deployer has no BNB', '라이브 실행은 잔액 0 을 거부한다');

    // B-F2. record.tgeTime 이 과거면 "TGE 로부터 12개월" 은 맞는 잣대가 아니다.
    const s = await mk();
    writeRec(56, { chainId: 56, treasury: s.treasury, tgeTime: WALLNOW - 400 * DAY,
                   addresses: { HCOWToken: s.token } });
    const cenv2 = (extra) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: s.token,
      CLAIM_OWNER: s.treasury, CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000', ...extra });
    const shortD = await run('deploy-claim.cjs', cenv2({ CLAIM_DEADLINE: String(WALLNOW + 95 * DAY) }));
    says(shortD, 'from now', '레코드 tgeTime 이 과거면 기한을 지금부터 재고 짧으면 거부한다');
    ok(!readRec(56).addresses?.HCOWClaim, '그리고 배포되지 않았다');
    const longD = await run('deploy-claim.cjs', cenv2({ CLAIM_DEADLINE: String(NOW + 800 * DAY) }));
    ok(longD.status === 0, '지금으로부터 12개월을 넘기면 통과한다 — 과거 TGE 자체는 막지 않는다');
    ok(/already past, so the deadline is measured from NOW/.test(longD.out),
      '그리고 잣대를 바꿨다는 사실을 출력한다');
    // 그리고 레코드의 tgeTime 도 범위 검사를 받는다.
    const s3 = await mk();
    writeRec(56, { chainId: 56, treasury: s3.treasury, tgeTime: (WALLNOW + 30 * DAY) * 1000,
                   addresses: { HCOWToken: s3.token } });
    const recMs = await run('deploy-claim.cjs', {
      RPC_URL: s3.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: s3.token,
      CLAIM_OWNER: s3.treasury, CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000',
      CLAIM_DEADLINE: String(NOW + 800 * DAY) });
    says(recMs, "more than 365 days past the chain's latest block", '레코드의 밀리초 tgeTime 도 잡힌다');
    says(recMs, `deployments/56.json`, '그리고 어느 출처에서 온 값인지 말한다');

    // B-F3. 단축평가가 남아 있던 두 파일.
    const s4 = await mk();
    const both = await run('deploy-claim.cjs', {
      RPC_URL: s4.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: s4.token,
      CLAIM_OWNER: s4.treasury, CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000',
      CLAIM_DEADLINE: String(NOW + 800 * DAY), TGE_TIME: String(WALLNOW + 30 * DAY),
      DRY_RUN: 'yes', PRINT_ONLY: 'mabye' });
    says(both, 'Refusing to guess', 'deploy-claim.cjs 도 두 번째 플래그의 오타를 잡는다 (9차 B-F3)');
    const tokBoth = await run('deploy-token.cjs', {
      RPC_URL: s4.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, TREASURY_ADDRESS: s4.treasury,
      FIRST_DEPLOY: '1', DRY_RUN: 'yes', PRINT_ONLY: 'mabye' });
    says(tokBoth, 'Refusing to guess', 'deploy-token.cjs 도 잡는다');
  }

  console.log('\nload.cjs — owner 는 체인에서 읽는다 (9차 B-F6 · B-F7) · set-root 주소 검사 (B-F8)\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    const treasuryEoa = await f.treasury.getAddress();
    const tk = await dep('HCOWToken', f.deployer, [treasuryEoa]);
    const s = { f, tk, token: await tk.getAddress(), treasury: treasuryEoa, chainId: 56 };
    await mainReady(s);   // 11차: 메인넷은 기록된 claim 을 요구한다
    ok((await run('deploy.cjs', menv(s))).status === 0, '베스팅을 배포해 둔다');
    const rec = readRec(56);
    const lenv = (extra = {}) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', SCHEDULE: SCHED, TREASURY_KEY: KEY_TREASURY, ...extra });
    // 레코드의 treasury 만 오염시킨다. 체인의 owner 는 그대로다.
    const decoy = ethers.getAddress('0x' + 'd1'.repeat(20));
    writeRec(56, { ...rec, treasury: decoy });
    const corrupt = await run('load.cjs', lenv({ PRINT_ONLY: 'yes', TREASURY_KEY: '' }));
    says(corrupt, 'reports owner', '레코드의 treasury 가 체인의 owner 와 다르면 거부한다');
    ok(!corrupt.out.includes(`owner     ${decoy}`),
      '그리고 검증하지 않은 주소를 owner 라고 찍지 않는다');
    // treasury 필드가 없으면 무엇이 없는지 말한다.
    const noTre = { ...rec }; delete noTre.treasury;
    writeRec(56, noTre);
    const missing = await run('load.cjs', lenv({ PRINT_ONLY: 'yes', TREASURY_KEY: '' }));
    says(missing, 'no usable "treasury" field', 'treasury 필드가 없으면 그 이름을 말한다');
    ok(!/toLowerCase/.test(missing.out), '그리고 TypeError 를 토하지 않는다');
    writeRec(56, rec);
    const fine = await run('load.cjs', lenv({ PRINT_ONLY: 'yes', TREASURY_KEY: '' }));
    ok(fine.status === 0 && /read from the chain/.test(fine.out),
      '정상 레코드에서는 owner 를 체인에서 읽었다고 밝힌다');

    // B-F8. --claim 에 코드가 없으면 ethers 내부 오류가 아니라 문장이 나온다.
    const dir = path.join(ROOT, 'build', 'r9-tree');
    const { buildRound: br9 } = require('../scripts/merkle.cjs');
    const t9 = br9(0, [{ account: '0x' + '44'.repeat(20), amount: '1000000000000000000' }]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'round-0.json'), JSON.stringify(
      { roundId: 0, merkleRoot: t9.root, startTime: NOW + 10 * DAY, count: t9.count, total: t9.total, claims: t9.claims }, null, 2));
    fs.writeFileSync(path.join(dir, 'rounds.json'), JSON.stringify({ rounds: [
      { roundId: 0, merkleRoot: t9.root, startTime: NOW + 10 * DAY, count: t9.count, total: t9.total },
    ] }, null, 2));
    // 11차: 레코드가 다른 claim 을 부르면 10차의 "--claim 과 레코드가 다르면 거부" 가
    // 먼저 걸린다. 이 케이스가 노리는 것은 코드 존재 검사이므로, 레코드도 같은 (코드
    // 없는) 주소를 부르게 한다 — 손상된 레코드를 그대로 믿고 온 상황이다.
    const keepB = readRec(56);
    const noCodeAddr = ethers.getAddress('0x' + 'ab'.repeat(20));
    writeRec(56, { ...keepB, addresses: { ...keepB.addresses, HCOWClaim: noCodeAddr } });
    const noCode = await run('set-root.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', PRINT_ONLY: 'yes' },
      ['--rounds', path.join(dir, 'rounds.json'), '--round', '0', '--claim', noCodeAddr]);
    writeRec(56, keepB);
    says(noCode, 'there is no contract at', '코드 없는 --claim 주소는 문장으로 거부된다');
    ok(!/BAD_DATA/.test(noCode.out), '그리고 ethers 내부 오류가 노출되지 않는다');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ======================================================================
  // 10차 감사 조치
  // ======================================================================
  const { Address, hexToBytes } = require('@ethereumjs/util');
  const delegate7702 = async (f, eoa) => {
    // EIP-7702 위임 지정자: 0xef0100 + 20바이트 주소. 하네스는 Paris 라 이 형식을
    // 실행하지는 못하지만, getCode 가 돌려주는 값을 메인넷과 같게 만들 수는 있다.
    // 스크립트의 "EOA 인가" 판정이 보는 것은 그 값뿐이다.
    await f.node.vm.stateManager.putContractCode(
      new Address(hexToBytes(eoa)), hexToBytes('0xef0100' + '12'.repeat(20)));
  };

  console.log('\n10차 A-1 회귀 — 봉인된 베스팅을 FIRST_DEPLOY 로 지울 수 없다\n');
  {
    // 9차가 만든 사고의 재현 경로 그대로. 봉인까지 끝낸 레코드에 알려진 키 하나를
    // null 로 넣으면 9차 판은 "names no deployment at all" 이라고 말했고,
    // FIRST_DEPLOY=1 로 돌리면 봉인된 200,000,000 베스팅이 레코드에서 사라지고
    // 두 번째 토큰이 발행됐다.
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    const tre = await f.treasury.getAddress();
    const tk = await dep('HCOWToken', f.deployer, [tre]);
    const s = { f, tk, token: await tk.getAddress(), treasury: tre, chainId: 56 };
    await mainReady(s);   // 11차: 메인넷은 기록된 claim 을 요구한다
    ok((await run('deploy.cjs', menv(s))).status === 0, '베스팅을 배포한다');
    const lenv = { RPC_URL: f.node.url, CHAIN_ID: '56', SCHEDULE: SCHED, TREASURY_KEY: KEY_TREASURY };
    ok((await run('load.cjs', lenv)).status === 0, '9행을 적재한다');
    ok((await run('seal.cjs', lenv)).status === 0, '봉인한다');
    const sealedRec = readRec(56);
    const oldVesting = sealedRec.addresses.HCOWVesting;
    writeRec(56, { ...sealedRec, addresses: { ...sealedRec.addresses, HCOWAnchor: null } });
    const b = await blockNo(f.provider);
    const plain = await run('deploy.cjs', menv(s));
    says(plain, 'addresses.HCOWAnchor is null', '손상된 키를 이름으로 말한다 — "배포 기록 없음" 이라고 하지 않는다');
    ok(!/names no deployment at all/.test(plain.out), '9차의 거짓 문구가 나오지 않는다');
    const forced = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    says(forced, 'FIRST_DEPLOY included', 'FIRST_DEPLOY=1 로도 넘어가지 않는다');
    ok(b === await blockNo(f.provider), '두 번째 토큰도 새 베스팅도 배포되지 않았다');
    const after = JSON.parse(fs.readFileSync(recPath(56), 'utf8'));
    ok(after.addresses.HCOWVesting === oldVesting && after.addresses.HCOWToken === s.token,
      '봉인된 베스팅과 토큰이 레코드에 그대로 남아 있다');
  }

  console.log('\n10차 — 모든 스크립트가 같은 레코드 검증을 쓴다\n');
  {
    // 레코드 검증이 스크립트마다 따로 있어서 7·8·9차 모두 한 곳을 고치면 형제가
    // 남았다. 9차 당시 deploy-token.cjs 는 `{}` 위에서 플래그 없이 두 번째
    // 토큰을 발행했다. 이제 전부 _connect.cjs 의 readRecord 를 거친다.
    const bad = [
      ['{}', {}],
      ['HCOWToken:""', { chainId: 56, addresses: { HCOWToken: '' } }],
      ['토큰 null + 앵커', { chainId: 56, addresses: { HCOWToken: null, HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)) } }],
      ['HCOWClaim 만 (토큰 삭제)', { chainId: 56, addresses: { HCOWClaim: ethers.getAddress('0x' + 'cc'.repeat(20)) } }],
      ['zero address', { chainId: 56, addresses: { HCOWAnchor: '0x' + '00'.repeat(20) } }],
      ['알 수 없는 키', { chainId: 56, addresses: { HCOWToken: ethers.getAddress('0x' + 'aa'.repeat(20)), Legacy: ethers.getAddress('0x' + 'ab'.repeat(20)) } }],
    ];
    for (const [label, body] of bad) {
      clearRec();
      const f = await boot({ chainId: 56, now: WALLNOW });
      const safe = await (await dep('MockSafe', f.deployer, [await f.treasury.getAddress()])).getAddress();
      writeRec(56, body);
      const b = await blockNo(f.provider);
      for (const flags of [{}, { FIRST_DEPLOY: '1' }, { REPLACE_TOKEN: '1' }]) {
        const r = await run('deploy-token.cjs', {
          RPC_URL: f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, TREASURY_ADDRESS: safe, ...flags });
        says(r, 'is not a record any script here can trust',
          `deploy-token.cjs 는 {${label}} 레코드를 ${JSON.stringify(flags)} 로도 받아들이지 않는다`);
      }
      ok(b === await blockNo(f.provider), `그리고 {${label}} 위에서 토큰이 발행되지 않았다`);
    }
    // 레코드를 읽는 나머지 스크립트들도 같은 이유로 멈춘다.
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    writeRec(56, { chainId: 56, addresses: { HCOWToken: '' } });
    const url = f.node.url;
    const readers = [
      ['deploy-claim.cjs', { DEPLOYER_KEY: KEY_DEPLOY, CLAIM_OWNER: '0x' + '44'.repeat(20), CLAIM_DEADLINE: String(WALLNOW + 800 * DAY), CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000', TGE_TIME: String(WALLNOW + 30 * DAY) }],
      ['deploy-anchor.cjs', { DEPLOYER_KEY: KEY_DEPLOY, ANCHOR_OWNER: '0x' + '44'.repeat(20), ANCHOR_PUBLISHER: '0x' + '77'.repeat(20) }],
      ['load.cjs', { PRINT_ONLY: 'yes', SCHEDULE: SCHED }],
      ['seal.cjs', { DRY_RUN: 'yes', SCHEDULE: SCHED }],
      ['release.cjs', { SCHEDULE: SCHED }],
    ];
    for (const [script, extra] of readers) {
      const r = await run(script, { RPC_URL: url, CHAIN_ID: '56', ...extra });
      says(r, 'is not a record any script here can trust', `${script} 도 손상된 레코드에서 멈춘다`);
    }
    // 긍정 대조군: 레코드가 없으면 FIRST_DEPLOY 로 발행된다. 앵커만 적힌 정상
    // 레코드 위에서도 발행된다 (앵커를 먼저 배포하는 것은 정당하다).
    // 12차 감사 M-1: 다만 이제 FIRST_DEPLOY=1 이 필요하다. 앵커만 적힌 파일은 레코드를
    // 잃은 뒤 deploy-anchor.cjs 가 새로 쓴 파일과 구별되지 않는다.
    clearRec();
    const g = await boot({ chainId: 56, now: WALLNOW });
    const gsafe = await (await dep('MockSafe', g.deployer, [await g.treasury.getAddress()])).getAddress();
    const first = await run('deploy-token.cjs', { RPC_URL: g.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, TREASURY_ADDRESS: gsafe, FIRST_DEPLOY: '1' });
    ok(first.status === 0 && !!readRec(56).addresses.HCOWToken, '레코드가 없으면 FIRST_DEPLOY=1 로 발행된다');
    clearRec();
    writeRec(56, { chainId: 56, addresses: { HCOWAnchor: ethers.getAddress('0x' + 'bb'.repeat(20)) } });
    const anchorFirst = await run('deploy-token.cjs', { RPC_URL: g.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, TREASURY_ADDRESS: gsafe, FIRST_DEPLOY: '1' });
    ok(anchorFirst.status === 0 && readRec(56).addresses.HCOWAnchor === ethers.getAddress('0x' + 'bb'.repeat(20)),
      '앵커만 적힌 정상 레코드 위에서는 FIRST_DEPLOY=1 로 발행되고 앵커가 보존된다 (12차)');
    // 그리고 claim 이 이미 옛 토큰에 묶였으면 REPLACE_TOKEN 도 거부된다.
    const recNow = readRec(56);
    writeRec(56, { ...recNow, addresses: { ...recNow.addresses, HCOWClaim: ethers.getAddress('0x' + 'cc'.repeat(20)) } });
    const repl = await run('deploy-token.cjs', { RPC_URL: g.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, TREASURY_ADDRESS: gsafe, REPLACE_TOKEN: '1' });
    says(repl, 'REPLACE_TOKEN included', 'claim 이 옛 토큰에 묶였으면 REPLACE_TOKEN=1 도 거부된다');
  }

  console.log('\n10차 — deploy-anchor.cjs 가 다른 체인의 레코드를 세탁하지 않는다\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    const safe = await (await dep('MockSafe', f.deployer, [await f.treasury.getAddress()])).getAddress();
    const foreign = { chainId: 97, addresses: { HCOWToken: ethers.getAddress('0x' + 'aa'.repeat(20)) } };
    writeRec(56, foreign);
    const r = await run('deploy-anchor.cjs', {
      RPC_URL: f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY,
      ANCHOR_OWNER: safe, ANCHOR_PUBLISHER: '0x' + '77'.repeat(20), REPLACE_ANCHOR: '1' });
    says(r, 'its chainId is 97, not 56', 'deploy-anchor.cjs 는 chainId 97 레코드를 거부한다');
    ok(Number(readRec(56).chainId) === 97, '그리고 그 chainId 를 56 으로 덮어써 세탁하지 않았다');
  }

  console.log('\n10차 — 메인넷 deploy.cjs 는 토큰을 배포하지 않는다\n');
  {
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    const b = await blockNo(s.f.provider);
    const r = await run('deploy.cjs', denv(s, { FIRST_DEPLOY: '1' }));
    says(r, 'on mainnet HCOW_ADDRESS is required', '메인넷에서 레코드가 없어도 HCOW_ADDRESS 없이는 거부된다');
    ok(b === await blockNo(s.f.provider), '그리고 토큰이 배포되지 않았다');
  }

  console.log('\n10차 — 적재 단계에서야 걸리던 행 결함을 배포 전에 잡는다\n');
  {
    // 이 행들은 9차까지 deploy.cjs 를 exit 0 으로 통과했고 load.cjs 에서 revert 했다.
    // 그때는 커밋먼트가 이미 immutable 이라 봉인할 수 없는 베스팅이 남았다.
    const cases = [
      ['tgeBps 10001', { tgeBps: 10001 }, 'tgeBps is 10001'],
      ['tgeBps 65000', { tgeBps: 65000 }, 'tgeBps is 65000'],
      ['cliff 0 · linear 0 · bps 5000', { tgeBps: 5000, cliffMonths: 0, linearMonths: 0 }, 'DegenerateSchedule'],
      ['cliff 60 + linear 61', { cliffMonths: 60, linearMonths: 61 }, 'VestingTooLong above 120'],
      ['zero beneficiary', { beneficiary: '0x' + '00'.repeat(20) }, 'zero address placeholder'],
      ['total 0', { total: '0' }, 'ZeroAmount'],
    ];
    for (const [label, over, needle] of cases) {
      clearRec();
      const t = await stageTestnet();
      writeSchedule(ethers.parseUnits('200000000', 18), 9, { 4: over });
      const b = await blockNo(t.f.provider);
      const r = await run('deploy.cjs', denv(t, { FIRST_DEPLOY: '1' }));
      says(r, needle, `행 결함 "${label}" 은 배포 전에 거부된다`);
      ok(b === await blockNo(t.f.provider), `그리고 "${label}" 에서 고아 토큰이 생기지 않는다`);
    }
    // 토큰 자신을 수혜자로 둔 행 (메인넷 경로: 토큰 주소를 이때 안다).
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 5: { beneficiary: s.token } });
    mainRec(s);
    const b = await blockNo(s.f.provider);
    const r = await run('deploy.cjs', menv(s));
    says(r, 'names the token itself', '토큰 자신을 수혜자로 둔 행은 거부된다');
    ok(b === await blockNo(s.f.provider), '그리고 베스팅이 배포되지 않았다');
    // 미리보기(commitcheck CLI)는 자리표시 0x0 을 허용한다 — mainnet.json 의 Airdrop 행.
    // 16차 최종 확인: 이 단언은 schedule/mainnet.json 을 읽었는데, 그 파일은 수혜자 주소
    // 실물이라 GitHub 에 올리지 않는다. 갓 클론한 저장소에서는 이 단언이 실패했다.
    // 저장소에 있는 mainnet.template.json(0x0 자리표시 9개)으로 같은 것을 본다.
    const pv = require('child_process').spawnSync(process.execPath,
      ['scripts/commitcheck.cjs', 'schedule/mainnet.template.json'], { cwd: ROOT, encoding: 'utf8' });
    ok(pv.status === 0, 'commitcheck 미리보기는 0x0 자리표시를 허용한다 (mainnet.template.json)');
  }

  console.log('\n10차 — rescueRecipient 가 이번 실행이 만들 주소면 배포 전에 거부한다\n');
  {
    // 이전 주석은 베스팅 주소를 "아무도 예측할 수 없다" 고 했다. CREATE 주소는
    // 배포키와 nonce 로 정해진다. 재현: rescue 를 예측 주소로 두면 토큰이 배포된
    // 뒤 생성자가 InvalidRescueRecipient 로 거부해 고아 토큰이 남았다.
    writeSchedule(ethers.parseUnits('200000000', 18));
    for (const which of ['token', 'vesting']) {
      clearRec();
      const t = await stageTestnet();
      const me = new ethers.Wallet(KEY_DEPLOY).address;
      const n0 = await t.f.provider.getTransactionCount(me, 'pending');
      const target = ethers.getCreateAddress({ from: me, nonce: which === 'token' ? n0 : n0 + 1 });
      const b = await blockNo(t.f.provider);
      const r = await run('deploy.cjs', denv(t, { FIRST_DEPLOY: '1', RESCUE_RECIPIENT: target }));
      says(r, 'RESCUE_RECIPIENT', `rescue 가 이번 실행의 ${which} 주소면 거부된다`);
      ok(b === await blockNo(t.f.provider), `그리고 ${which} 경우에 고아 토큰이 생기지 않는다`);
    }
    // 메인넷 경로: rescue == HCOW_ADDRESS
    clearRec();
    const s = await stageWall();
    mainRec(s);
    const r = await run('deploy.cjs', menv(s, { RESCUE_RECIPIENT: s.token }));
    says(r, 'is the address of the token', '메인넷에서 rescue 가 토큰이면 거부된다');
  }

  console.log('\n10차 — 레코드의 HCOWClaim 을 체인에 대고 확인한다\n');
  {
    // (1) 다른 토큰에 묶인 claim
    clearRec();
    let s = await stageWall();
    const otherTok = await dep('HCOWToken', s.f.deployer, [s.treasury]);
    let claim = await realClaim(s, { token: await otherTok.getAddress() });
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 3: { beneficiary: claim } });
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: claim } });
    says(await run('deploy.cjs', menv(s)), 'is bound to token', '다른 토큰에 묶인 claim 이면 거부된다');
    // (2) 테이블에 claim 이 없다
    clearRec();
    s = await stageWall();
    claim = await realClaim(s);
    writeSchedule(ethers.parseUnits('200000000', 18));
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: claim } });
    says(await run('deploy.cjs', menv(s)), 'has no row paying the recorded HCOWClaim', '테이블이 claim 을 수혜자로 갖지 않으면 거부된다');
    // (3) 기한이 이 TGE 로부터 12개월 미만 — deploy-claim 이 다른 TGE 로 검사했던 경우
    clearRec();
    s = await stageWall();
    claim = await realClaim(s, { deadline: TGE + 100 * DAY });
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 3: { beneficiary: claim } });
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: claim } });
    says(await run('deploy.cjs', menv(s)), "claimDeadline is 3.3 thirty-day months after", '기한이 이 TGE 로부터 12개월 미만이면 거부된다');
    // 긍정 대조군은 7차 M-5/M-6 블록이 본다 (진짜 claim, 테이블에 있음, 기한 충분).
  }

  console.log('\n10차 — 자금이 들어간 미봉인 베스팅은 교체할 수 없다 · held 검사는 살아 있다\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    const tre = await f.treasury.getAddress();
    const tk = await dep('HCOWToken', f.deployer, [tre]);
    const s = { f, tk, token: await tk.getAddress(), treasury: tre, chainId: 56 };
    await mainReady(s);   // 11차: 메인넷은 기록된 claim 을 요구한다
    ok((await run('deploy.cjs', menv(s))).status === 0, '베스팅을 배포한다');
    const v = readRec(56).addresses.HCOWVesting;
    // 트레저리가 fundAndSeal 이 아니라 맨 전송으로 1 wei 를 보낸다.
    await (await tk.connect(f.treasury).transfer(v, 1n)).wait();
    const b = await blockNo(f.provider);
    const repl = await run('deploy.cjs', menv(s, { REPLACE_VESTING: '1' }));
    says(repl, 'already holds 1 wei of HCOW', '1 wei 라도 든 미봉인 베스팅은 REPLACE_VESTING 으로도 교체되지 않는다');
    ok(b === await blockNo(f.provider), '그리고 새 베스팅이 배포되지 않았다');
    // held < c.total: 9차 주석이 "메인넷에서 도달 불가" 라고 했던 검사. 레코드에서
    // 베스팅을 빼 첫 베스팅 배포 상황으로 되돌리고 확인한다 (트레저리는 이제 1 wei 모자란다).
    const rec = readRec(56);
    writeRec(56, { chainId: 56, treasury: rec.treasury, addresses: { HCOWToken: s.token, HCOWClaim: rec.addresses.HCOWClaim } });
    const short = await run('deploy.cjs', menv(s));
    says(short, 'but the table needs 200000000000000000000000000 wei', '트레저리가 1 wei 모자라면 메인넷에서 거부된다 (held 검사는 살아 있다)');
  }

  console.log('\n10차 — deploy-claim.cjs 는 베스팅 뒤에 claim 을 배포하지 않는다\n');
  {
    // 수혜자 집합은 봉인이 아니라 베스팅 **배포** 시점에 expectedScheduleHash 로
    // 고정된다. 9차까지 이 스크립트는 sealed_() 만 봤고, 재현하니 미봉인 베스팅
    // 뒤에 REPLACE_CLAIM=yes 로 새 claim 이 배포되고 레코드가 그쪽을 가리켰다.
    clearRec();
    const s = await stage();
    const claim = await realClaim({ f: s.f, token: s.token, treasury: s.treasury }, { deadline: NOW + 800 * DAY });
    const vest = await dep('HCOWVesting', s.f.deployer, [s.token, NOW + 30 * DAY, s.treasury, '0x' + '55'.repeat(20),
      9, ethers.parseUnits('200000000', 18), 1n, '0x' + '11'.repeat(32)]);
    const vestAddr = await vest.getAddress();
    // (a) claim 없이 베스팅만 있는 레코드: 순서를 거꾸로 밟은 첫 claim 배포
    writeRec(56, { chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token, HCOWVesting: vestAddr } });
    const first = await run('deploy-claim.cjs', { ...env(s), TGE_TIME: String(WALLNOW + 30 * DAY) });
    says(first, 'REPLACE_CLAIM included', '베스팅이 이미 있으면 첫 claim 도 배포하지 않는다');
    ok(!readRec(56).addresses.HCOWClaim, '그리고 레코드에 claim 이 적히지 않았다');
    // (b) claim 과 베스팅이 다 있는 레코드에서 REPLACE_CLAIM=yes
    writeRec(56, { chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token, HCOWClaim: claim, HCOWVesting: vestAddr } });
    const repl = await run('deploy-claim.cjs', { ...env(s), TGE_TIME: String(WALLNOW + 30 * DAY), REPLACE_CLAIM: 'yes' });
    says(repl, 'REPLACE_CLAIM included', '베스팅 뒤에는 REPLACE_CLAIM=yes 로도 claim 을 바꾸지 않는다 (9차 재현 경로)');
    ok(readRec(56).addresses.HCOWClaim === claim, '그리고 레코드의 claim 이 그대로다');
  }

  console.log('\n10차 — set-root.cjs 는 --claim 과 레코드가 다르면 고르지 않는다\n');
  {
    clearRec();
    const s = await stage();
    const a = await realClaim({ f: s.f, token: s.token, treasury: s.treasury }, { deadline: NOW + 800 * DAY });
    const bb = await realClaim({ f: s.f, token: s.token, treasury: s.treasury }, { deadline: NOW + 800 * DAY });
    writeRec(56, { chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token, HCOWClaim: bb } });
    const { buildRound: br10 } = require('../scripts/merkle.cjs');
    const dir = path.join(ROOT, 'build', 'r10-tree');
    const t10 = br10(0, [{ account: '0x' + '44'.repeat(20), amount: '1000000000000000000' }]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'round-0.json'), JSON.stringify(
      { roundId: 0, merkleRoot: t10.root, startTime: NOW + 10 * DAY, count: t10.count, total: t10.total, claims: t10.claims }, null, 2));
    fs.writeFileSync(path.join(dir, 'rounds.json'), JSON.stringify({ rounds: [
      { roundId: 0, merkleRoot: t10.root, startTime: NOW + 10 * DAY, count: t10.count, total: t10.total }] }, null, 2));
    const r = await run('set-root.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', PRINT_ONLY: 'yes' },
      ['--rounds', path.join(dir, 'rounds.json'), '--round', '0', '--claim', a]);
    says(r, 'will not pick', '--claim 이 레코드의 HCOWClaim 과 다르면 거부된다');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n10차 — seal.cjs 의 treasury 누락 · EIP-7702 위임 EOA\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    writeRec(56, { chainId: 56, addresses: { HCOWToken: ethers.getAddress('0x' + 'aa'.repeat(20)), HCOWVesting: ethers.getAddress('0x' + 'ab'.repeat(20)) } });
    const r = await run('seal.cjs', { RPC_URL: f.node.url, CHAIN_ID: '56', DRY_RUN: 'yes', SCHEDULE: SCHED });
    says(r, 'no usable "treasury" field', 'seal.cjs 는 treasury 가 없으면 그 이름을 말한다');
    ok(!/toLowerCase/.test(r.out), '그리고 TypeError 를 토하지 않는다');

    // 7702: deploy-claim 의 EOA 오너 거부와 deploy-token 의 EOA 트레저리 거부.
    clearRec();
    const s = await stage();
    const eoa = new ethers.Wallet('0x' + '66'.repeat(32)).address;
    await delegate7702(s.f, eoa);
    ok((await s.f.provider.getCode(eoa)).startsWith('0xef0100'), '위임 EOA 에 0xef0100 코드를 심었다');
    writeRec(56, { chainId: 56, addresses: { HCOWToken: s.token } });
    const dc = await run('deploy-claim.cjs', { ...env(s), CLAIM_OWNER: eoa, TGE_TIME: String(WALLNOW + 30 * DAY) });
    says(dc, 'externally owned account', 'deploy-claim.cjs 는 7702 위임 EOA 오너를 EOA 로 보고 거부한다');
    clearRec();
    const dt = await run('deploy-token.cjs', { RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, TREASURY_ADDRESS: eoa, FIRST_DEPLOY: '1' });
    says(dt, 'ALLOW_EOA_TREASURY', 'deploy-token.cjs 도 7702 위임 EOA 트레저리를 거부한다');
  }

  console.log('\n10차 — deploy-claim.cjs 의 체인 시계 상한은 365일이다\n');
  {
    // 이 상한의 유일한 테스트가 13자리 밀리초였다. 365 를 36500 으로 바꿔도 초록이었다.
    for (const [days, expectRefuse] of [[400, true], [300, false]]) {
      clearRec();
      const s = await stage();
      writeRec(56, { chainId: 56, treasury: s.treasury, tgeTime: NOW + days * DAY, addresses: { HCOWToken: s.token } });
      const r = await run('deploy-claim.cjs', { ...env(s), CLAIM_DEADLINE: String(NOW + 1200 * DAY) });
      if (expectRefuse) says(r, "past the chain's latest block", `레코드 tgeTime 이 체인 시계 +${days}일이면 거부된다`);
      else ok(!/past the chain's latest block/.test(r.out), `레코드 tgeTime 이 체인 시계 +${days}일이면 이 상한에 걸리지 않는다`);
    }
  }

  // ======================================================================
  // 11차 감사 조치
  // ======================================================================
  console.log('\n11차 — 메인넷 deploy.cjs 는 기록된 claim 을 Airdrop 행에서만 받아들인다\n');
  {
    // (1) claim 이 기록돼 있지 않다 — 2단계를 빠뜨린 경우
    clearRec();
    let s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    mainRec(s);
    let b = await blockNo(s.f.provider);
    says(await run('deploy.cjs', menv(s)), 'must already name the HCOWClaim', '메인넷에서 claim 이 기록되지 않았으면 거부된다');
    ok(b === await blockNo(s.f.provider), '그리고 베스팅이 배포되지 않았다');
    // (2) claim 이 Team 행에 있다 — Airdrop 행과 맞바꾼 경우
    clearRec();
    s = await stageWall();
    const c2 = await realClaim(s);
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 8: { beneficiary: c2 }, 3: { beneficiary: ethers.getAddress('0x' + '09'.padStart(40, '0')) } });
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: c2 } });
    says(await run('deploy.cjs', menv(s)), 'not of the "Airdrop" row', 'claim 이 Airdrop 이 아닌 행에 있으면 거부된다');
    // (3) Airdrop 라벨 행이 둘
    clearRec();
    s = await stageWall();
    const c3 = await realClaim(s);
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 3: { beneficiary: c3 }, 5: { label: 'Airdrop 2' } });
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: c3 } });
    says(await run('deploy.cjs', menv(s)), '2 rows labelled as Airdrop', 'Airdrop 라벨 행이 둘이면 거부된다');
    // (4) 기록된 claim 에 코드가 없다 (메인넷)
    clearRec();
    s = await stageWall();
    const ghost = ethers.getAddress('0x' + 'c4'.repeat(20));
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 3: { beneficiary: ghost } });
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: ghost } });
    says(await run('deploy.cjs', menv(s)), 'fix it before fixing commitments', '메인넷에서 코드 없는 claim 이 기록돼 있으면 거부된다');
    // (5) claim 의 notice 로는 0번 라운드를 이 TGE 에 열 수 없다
    clearRec();
    s = await stageWall();
    await mainReady(s, { claimOpts: { notice: 30 * DAY, deadline: TGE + 600 * DAY } });
    says(await run('deploy.cjs', menv(s)), 'Round 0 pays at TGE', 'claim 의 notice 가 TGE 까지 남은 시간보다 길면 거부된다');
    // (6) TREASURY_ADDRESS 가 레코드의 treasury 와 다르다
    clearRec();
    s = await stageWall();
    await mainReady(s);
    says(await run('deploy.cjs', menv(s, { TREASURY_ADDRESS: ethers.getAddress('0x' + '5a'.repeat(20)) })),
      'records the treasury as', 'TREASURY_ADDRESS 가 레코드의 treasury 와 다르면 거부된다');
  }

  console.log('\n11차 — deploy-claim.cjs 는 notice 와 TGE 를 대조한다\n');
  {
    clearRec();
    const s = await stage();
    writeRec(56, { chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token } });
    const r = await run('deploy-claim.cjs', { ...env(s), TGE_TIME: String(WALLNOW + 3 * DAY) });
    says(r, 'Round 0 pays at TGE', 'TGE 3일 전 · notice 72시간이면 0번 라운드를 TGE 에 열 수 없어 거부된다');
    ok(!readRec(56).addresses.HCOWClaim, '그리고 claim 이 배포되지 않았다');
    const ok5 = await run('deploy-claim.cjs', { ...env(s), TGE_TIME: String(WALLNOW + 5 * DAY) });
    ok(ok5.status === 0, 'TGE 5일 전이면 통과한다 — 위 거부가 "늘 거부" 로 만족되지 않게');
  }

  console.log('\n11차 — anchor.cjs · deploy-anchor.cjs\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: WALLNOW });
    writeRec(56, { chainId: 56, addresses: { HCOWAnchor: ethers.getAddress('0x' + 'a1'.repeat(20)) } });
    const r = await run('anchor.cjs', { RPC_URL: f.node.url, CHAIN_ID: '56', PUBLISHER_KEY: KEY_OTHER,
      ANCHOR_ADDRESS: ethers.getAddress('0x' + 'a2'.repeat(20)), DRY_RUN: 'yes' });
    says(r, 'will not pick', 'anchor.cjs 는 ANCHOR_ADDRESS 가 레코드와 다르면 거부한다');
    clearRec();
    const safe = await (await dep('MockSafe', f.deployer, [await f.treasury.getAddress()])).getAddress();
    const r2 = await run('deploy-anchor.cjs', { RPC_URL: f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY,
      ANCHOR_OWNER: safe, ANCHOR_PUBLISHER: '0x' + '77'.repeat(20), REPLACE_ANCHOR: '1' });
    says(r2, 'FIRST_DEPLOY', 'REPLACE_ANCHOR=1 은 레코드 부재 가드를 풀지 않는다');
  }

  console.log('\n11차 — 순수 함수로 직접 확인하는 것들\n');
  {
    const cx = require('../scripts/_connect.cjs');
    // HCOW_RECORD_DIR 는 루프백 RPC 에서만 받는다.
    const keepRpc = process.env.RPC_URL;
    process.env.RPC_URL = 'https://bsc-dataseed.binance.org';
    let msg = '';
    try { cx.recordDir(); } catch (e) { msg = e.message; }
    ok(/HCOW_RECORD_DIR is set/.test(msg), 'HCOW_RECORD_DIR 는 실제 체인 RPC 와 함께면 거부된다 (11차)');
    process.env.RPC_URL = 'http://127.0.0.1:8545';
    let fine = true;
    try { cx.recordDir(); } catch (_) { fine = false; }
    ok(fine, '그리고 루프백 RPC 와 함께면 받아들인다');
    if (keepRpc === undefined) delete process.env.RPC_URL; else process.env.RPC_URL = keepRpc;
    // claim.token 과 addresses.HCOWToken 이 다르면 손상이다.
    const bad = cx.recordProblems({ chainId: 56, addresses: { HCOWToken: '0x' + 'aa'.repeat(20) },
      claim: { token: '0x' + 'ab'.repeat(20) } }, 56);
    ok(bad.some((x) => /claim\.token is/.test(x)), 'claim.token 이 HCOWToken 과 다르면 레코드 결함이다');
    // commitcheck 의 행 검사 중 테스트가 없던 셋
    const { loadSchedule } = require('../scripts/commitcheck.cjs');
    const tmp = path.join(ROOT, 'build', 'r11-rows.json');
    const tryRows = (row) => {
      const rows = Array.from({ length: 9 }, (_, i) => ({ label: 'R' + i,
        beneficiary: ethers.getAddress('0x' + (i + 1).toString(16).padStart(40, '0')),
        total: '1000', tgeBps: 1350, cliffMonths: 0, linearMonths: 12 }));
      rows[2] = { ...rows[2], ...row };
      fs.writeFileSync(tmp, JSON.stringify({ rows }));
      try { loadSchedule(tmp); return null; } catch (e) { return e.message; }
    };
    ok(/is not an address/.test(tryRows({ beneficiary: 'treasury-safe' }) || ''), '주소가 아닌 수혜자 문자열은 거부된다');
    ok(/must be an integer number of wei/.test(tryRows({ total: '1e21' }) || ''), '정수가 아닌 total 은 거부된다');
    ok(/does not fit uint128/.test(tryRows({ total: (2n ** 128n).toString() }) || ''), 'uint128 을 넘는 total 은 거부된다');
    ok(tryRows({}) === null, '정상 행은 통과한다');
    fs.rmSync(tmp, { force: true });
  }

  console.log('\n11차 — deploy.cjs 의 기존 베스팅 읽기 (괄호 오류)\n');
  {
    // 10차가 자금 검사 블록을 옮기면서 else 를 빈 블록으로 닫았다. 코드 없는 주소에도
    // sealed_() 를 읽어 "no contract there" 직후 "there is code at that address" 로
    // 멈췄다 (테스트넷).
    clearRec();
    const t = await stageTestnet();
    writeSchedule(ethers.parseUnits('200000000', 18));
    writeRec(97, { chainId: 97, treasury: t.treasury,
      addresses: { HCOWToken: t.token, HCOWVesting: ethers.getAddress('0x' + 'ab'.repeat(20)) } });
    const r = await run('deploy.cjs', denv(t, { HCOW_ADDRESS: t.token, REPLACE_VESTING: '1' }));
    ok(r.status === 0 && /no contract there\. Treating it as not sealed/.test(r.out),
      '테스트넷에서 코드 없는 기록 베스팅은 경고하고 교체된다');
    ok(!/there is code at that address/.test(r.out), '그리고 모순된 문구가 나오지 않는다');
    // 코드는 있지만 베스팅이 아닌 주소 (예: 토큰 자신)는 읽을 수 없어 거부된다.
    clearRec();
    const t2 = await stageTestnet();
    writeRec(97, { chainId: 97, treasury: t2.treasury, addresses: { HCOWToken: t2.token, HCOWVesting: t2.token } });
    says(await run('deploy.cjs', denv(t2, { HCOW_ADDRESS: t2.token, REPLACE_VESTING: '1' })),
      'could not be read', '베스팅이 아닌 코드가 기록돼 있으면 거부된다');
  }

  console.log('\n11차 — 형제 스크립트의 드라이런도 건너뛴 검사를 밝힌다\n');
  {
    const deployerLc = new ethers.Wallet(KEY_DEPLOY).address.toLowerCase();
    clearRec();
    const f = await boot({ chainId: 56, now: NOW, balances: { [deployerLc]: '0' } });
    const safe = await (await dep('MockSafe', f.deployer, [await f.treasury.getAddress()])).getAddress();
    const tk = await dep('HCOWToken', f.deployer, [safe]);
    const tokenAddr = await tk.getAddress();
    const common = { RPC_URL: f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, DRY_RUN: 'yes' };
    const dt = await run('deploy-token.cjs', { ...common, TREASURY_ADDRESS: safe });
    ok(dt.status === 0 && /CHECKS THIS DRY RUN DID NOT MAKE/.test(dt.out) && /no BNB/.test(dt.out) && /does not exist/.test(dt.out),
      'deploy-token.cjs 드라이런이 건너뛴 잔액·레코드 검사를 밝힌다');
    const da = await run('deploy-anchor.cjs', { ...common, ANCHOR_OWNER: safe, ANCHOR_PUBLISHER: '0x' + '77'.repeat(20) });
    ok(da.status === 0 && /CHECKS THIS DRY RUN DID NOT MAKE/.test(da.out) && /no BNB/.test(da.out),
      'deploy-anchor.cjs 드라이런이 건너뛴 검사를 밝힌다');
    const dc = await run('deploy-claim.cjs', { ...common, HCOW_ADDRESS: tokenAddr, CLAIM_OWNER: safe,
      CLAIM_DEADLINE: String(NOW + 800 * DAY), CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000',
      TGE_TIME: String(WALLNOW + 30 * DAY) });
    ok(dc.status === 0 && /CHECKS THIS DRY RUN DID NOT MAKE/.test(dc.out) && /no BNB/.test(dc.out),
      'deploy-claim.cjs 드라이런이 건너뛴 검사를 밝힌다');
    ok(!/Every check (below runs|above passed)/.test(dt.out + da.out + dc.out), '셋 다 "모든 검사가 돌았다" 고 말하지 않는다');
  }

  console.log('\n12차 — 앵커만 적힌 레코드는 "처음이 아니다" 의 증거가 아니다 (M-1)\n');
  {
    // 레코드를 잃은 뒤 deploy-anchor.cjs 가 FIRST_DEPLOY=1 로 새 파일을 쓰면 그 파일에는
    // 앵커만 있다. 이전 판은 그 파일 하나로 deploy-claim 이 플래그 없이 두 번째 claim 을,
    // deploy.cjs(테스트넷)가 두 번째 토큰을 배포했다.
    clearRec();
    const s = await stageWall();
    const anchorOnly = { chainId: 56, addresses: { HCOWAnchor: ethers.getAddress('0x' + 'a1'.repeat(20)) } };
    writeRec(56, anchorOnly);
    const cenv12 = (extra = {}) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: s.token,
      CLAIM_OWNER: s.treasury, CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000',
      TGE_TIME: String(TGE), CLAIM_DEADLINE: String(TGE + 460 * DAY), ...extra });
    const b0 = await blockNo(s.f.provider);
    says(await run('deploy-claim.cjs', cenv12()), 'names no HCOWToken',
      'deploy-claim 은 앵커만 적힌 레코드로 FIRST_DEPLOY 없이 배포하지 않는다 (12차)');
    ok(b0 === await blockNo(s.f.provider) && !readRec(56).addresses.HCOWClaim, '그리고 아무것도 배포되지 않았다');
    // 대조군: 같은 레코드에서 FIRST_DEPLOY=yes 면 배포하고 앵커를 보존한다.
    const okRun = await run('deploy-claim.cjs', cenv12({ FIRST_DEPLOY: 'yes' }));
    ok(okRun.status === 0 && !!readRec(56).addresses.HCOWClaim &&
       readRec(56).addresses.HCOWAnchor === anchorOnly.addresses.HCOWAnchor,
      '대조군: FIRST_DEPLOY=yes 면 배포하고 앵커를 그대로 둔다 (12차)');

    // deploy.cjs 테스트넷 새 토큰 경로도 같은 규칙.
    clearRec();
    const t = await stageTestnet();
    writeSchedule(ethers.parseUnits('200000000', 18));
    writeRec(97, { chainId: 97, addresses: { HCOWAnchor: ethers.getAddress('0x' + 'a1'.repeat(20)) } });
    const tb = await blockNo(t.f.provider);
    says(await run('deploy.cjs', denv(t, {})), 'names no HCOWToken, and HCOW_ADDRESS is not set',
      'deploy.cjs 도 앵커만 적힌 레코드로 새 토큰을 발행하지 않는다 (12차)');
    ok(tb === await blockNo(t.f.provider), '그리고 아무것도 배포되지 않았다 (12차)');
    const tOk = await run('deploy.cjs', denv(t, { FIRST_DEPLOY: '1' }));
    ok(tOk.status === 0 && !!readRec(97).addresses.HCOWToken, '대조군: FIRST_DEPLOY=1 이면 테스트넷에서 배포한다 (12차)');
  }

  console.log('\n12차 — 스케줄 파일의 공표 수치와 claim 창 (M-2 · L-3)\n');
  {
    // meta.tgeUnlockMustEqual 은 적혀만 있고 아무도 읽지 않았다. Airdrop 행의 조건을
    // 바꾸고 meta 는 그대로 두면 거부되어야 한다.
    clearRec();
    const s = await stageWall();
    writeSchedule(ethers.parseUnits('200000000', 18));
    const published = JSON.parse(fs.readFileSync(SCHED, 'utf8')).meta;
    const claim = await mainReady(s, { over: { 3: { tgeBps: 0, cliffMonths: 12, linearMonths: 36 } } });
    writeSchedule(ethers.parseUnits('200000000', 18), 9,
      { 3: { beneficiary: claim, tgeBps: 0, cliffMonths: 12, linearMonths: 36 } }, published);
    says(await run('deploy.cjs', menv(s)), 'does not match its own published figures',
      'Airdrop 행 조건이 바뀌었는데 공표 수치가 그대로면 메인넷 배포가 거부된다 (12차)');
    ok(!readRec(56).addresses.HCOWVesting, '그리고 베스팅이 배포되지 않았다 (12차)');
    // meta 가 아예 없으면 메인넷에서 거부된다.
    writeSchedule(ethers.parseUnits('200000000', 18), 9, { 3: { beneficiary: claim } },
      { totalsMustEqual: undefined, tgeUnlockMustEqual: undefined });
    says(await run('deploy.cjs', menv(s)), 'meta.tgeUnlockMustEqual is undefined',
      '메인넷에서 공표 TGE 언락 수치가 없으면 거부된다 (12차)');

    // claim 행이 다 풀리는 시점이 마지막으로 열 수 있는 라운드보다 늦으면 거부된다.
    // 테스트 행: 12개월 선형 → TGE+360일. 기한 TGE+400일 · 창 90일 → 마지막 개시 TGE+310일.
    clearRec();
    const s2 = await stageWall();
    await mainReady(s2, { claimOpts: { deadline: TGE + 400 * DAY } });
    says(await run('deploy.cjs', menv(s2)), 'can never be paid by a round',
      'claim 행 종료가 기한 − 창보다 늦으면 메인넷 배포가 거부된다 (12차)');
    ok(!readRec(56).addresses.HCOWVesting, '그리고 베스팅이 배포되지 않았다 (12차 · 대조군은 기본 기한 460일로 통과하는 모든 mainReady 케이스)');

    // deploy-claim: TGE 가 기한 − 창보다 늦으면 0번 라운드를 TGE 에 열 수 없다 (L-3).
    clearRec();
    const s3 = await stageWall();
    mainRec(s3);
    const c3 = (dl, win) => run('deploy-claim.cjs', {
      RPC_URL: s3.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: s3.token,
      CLAIM_OWNER: s3.treasury, CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: String(win),
      TGE_TIME: String(TGE), CLAIM_DEADLINE: String(dl), DRY_RUN: 'yes' });
    says(await c3(TGE + 361 * DAY, 365 * DAY), 'round 0 could not open at TGE',
      'deploy-claim 은 기한 − 창이 TGE 보다 이르면 거부한다 (12차 L-3)');
    const fine3 = await c3(TGE + 361 * DAY, 90 * DAY);
    ok(fine3.status === 0, '대조군: 같은 기한에 창 90일이면 통과한다 (12차)');
  }

  console.log('\n13차 — 토큰만 적힌 레코드로 두 번째 앵커를 배포하지 않는다\n');
  {
    // 12차 M-1 의 거울상. 레코드를 잃은 뒤 deploy-token.cjs 를 FIRST_DEPLOY=1 로 돌리면
    // 토큰만 적힌 새 파일이 생긴다. 이전 판은 그 파일로 두 번째 앵커를 플래그 없이 배포했다.
    clearRec();
    const s = await stageWall();
    const tokenOnly = { chainId: 56, treasury: s.treasury, addresses: { HCOWToken: s.token } };
    writeRec(56, tokenOnly);
    const aEnv = (extra = {}) => ({ RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY,
      ANCHOR_OWNER: s.treasury, ANCHOR_PUBLISHER: '0x' + '77'.repeat(20), ...extra });
    const b = await blockNo(s.f.provider);
    says(await run('deploy-anchor.cjs', aEnv()), 'names no HCOWAnchor',
      'deploy-anchor 는 토큰만 적힌 레코드로 FIRST_DEPLOY 없이 배포하지 않는다 (13차)');
    ok(b === await blockNo(s.f.provider), '그리고 아무것도 배포되지 않았다 (13차)');
    const okA = await run('deploy-anchor.cjs', aEnv({ FIRST_DEPLOY: '1' }));
    ok(okA.status === 0 && !!readRec(56).addresses.HCOWAnchor && readRec(56).addresses.HCOWToken === s.token,
      '대조군: FIRST_DEPLOY=1 이면 배포하고 토큰을 그대로 둔다 (13차)');
  }

  console.log('\n13차 — 베스팅 수치가 없어도 set-root 가 라운드 누계를 본다\n');
  {
    // 12차 판은 베스팅 수치가 없으면 누계를 계산만 하고 무시했다. 재현: 테스트넷,
    // claim 에 1,000 HCOW 직접 송금, 0번·1번 각 1,000 → 1번이 exit 0.
    clearRec();
    const t = await stageTestnet({ eoa: true });
    const claim = await realClaim(t);
    writeRec(97, { chainId: 97, treasury: t.treasury, addresses: { HCOWToken: t.token, HCOWClaim: claim } });
    await (await t.tk.connect(t.f.treasury).transfer(claim, 1000n * E)).wait();
    const { buildRound: brNV } = require('../scripts/merkle.cjs');
    const dirNV = path.join(ROOT, 'build', 'r13-novest');
    fs.rmSync(dirNV, { recursive: true, force: true });
    fs.mkdirSync(dirNV, { recursive: true });
    const plan = [{ id: 0, acct: '0x' + '44'.repeat(20), start: WALL + 10 * DAY }, { id: 1, acct: '0x' + '45'.repeat(20), start: WALL + 20 * DAY }];
    const sum = [];
    for (const r of plan) {
      const tr = brNV(r.id, [{ account: r.acct, amount: (1000n * E).toString() }]);
      fs.writeFileSync(path.join(dirNV, `round-${r.id}.json`), JSON.stringify(
        { roundId: r.id, merkleRoot: tr.root, startTime: r.start, count: tr.count, total: tr.total, claims: tr.claims }, null, 2));
      sum.push({ roundId: r.id, merkleRoot: tr.root, startTime: r.start, count: tr.count, total: tr.total });
    }
    fs.writeFileSync(path.join(dirNV, 'rounds.json'), JSON.stringify({ rounds: sum }, null, 2));
    const srNV = (id) => run('set-root.cjs', { RPC_URL: t.f.node.url, CHAIN_ID: '97', PRINT_ONLY: 'yes' },
      ['--rounds', path.join(dirNV, 'rounds.json'), '--round', String(id)]);
    const r0ok = await srNV(0);
    ok(r0ok.status === 0 && r0ok.out.includes('data   0x'), '대조군: 잔고가 0번만 덮으면 0번은 등록된다 (13차)');
    const r1bad = await srNV(1);
    ok(r1bad.status !== 0 && /there is no sealed vesting figure/.test(r1bad.out) && !r1bad.out.includes('data   0x'),
      '베스팅 수치가 없으면 잔고가 아직 열리지 않은 라운드 합계를 덮는지 본다 (13차)');

    // 14차: 0번을 실제로 등록한 뒤 파일을 재빌드한 상황.
    const live0 = await run('set-root.cjs', { RPC_URL: t.f.node.url, CHAIN_ID: '97', TREASURY_KEY: KEY_TREASURY },
      ['--rounds', path.join(dirNV, 'rounds.json'), '--round', '0']);
    ok(live0.status === 0, '(준비) 0번을 실제로 등록한다');
    const rewrite = (a0, a1, start0 = plan[0].start) => {
      const out = [];
      for (const [r, amt, st] of [[plan[0], a0, start0], [plan[1], a1, plan[1].start]]) {
        const tr = brNV(r.id, [{ account: r.acct, amount: amt.toString() }]);
        fs.writeFileSync(path.join(dirNV, `round-${r.id}.json`), JSON.stringify(
          { roundId: r.id, merkleRoot: tr.root, startTime: st, count: tr.count, total: tr.total, claims: tr.claims }, null, 2));
        out.push({ roundId: r.id, merkleRoot: tr.root, startTime: st, count: tr.count, total: tr.total });
      }
      fs.writeFileSync(path.join(dirNV, 'rounds.json'), JSON.stringify({ rounds: out }, null, 2));
    };
    // 15차 감사 F2: 교체 전 라운드는 **파일의 판으로 센다**. 그 판이 잔고를 넘치게
    // 하면 거부되어야 한다 (교체 전 라운드를 아예 빼고 세는 변이는 아래 대조군만으로는
    // 드러나지 않았다).
    rewrite(1000n * E - 1n, E);
    says(await srNV(1), 'there is no sealed vesting figure',
      '교체 전 라운드의 파일 판이 누계를 넘치게 하면 거부된다 (15차)');
    rewrite(999n * E, E);   // 0번의 루트가 체인과 달라진다
    // 다른 라운드 파일의 claims 가 루트 필드와 맞지 않으면 그 합계를 믿지 않는다.
    const keep0 = fs.readFileSync(path.join(dirNV, 'round-0.json'), 'utf8');
    const forged = JSON.parse(keep0);
    for (const c of Object.values(forged.claims)) c.amount = '1';
    fs.writeFileSync(path.join(dirNV, 'round-0.json'), JSON.stringify(forged, null, 2));
    says(await srNV(1), 'claims rebuild to', '다른 라운드 파일의 claims 가 루트와 맞지 않으면 거부된다 (14차)');
    fs.writeFileSync(path.join(dirNV, 'round-0.json'), keep0);
    const stale = await srNV(1);
    ok(stale.status === 0 && /registered with a different root than this build/.test(stale.out),
      '대조군: 아직 열리지 않은 0번의 루트가 다르면 경고하고 파일 판으로 센다 (14차)');
    // 15차 감사 F1: 열리지 않았어도 이제 교체할 수 없으면(옛 루트가 LEAD 안에 열린다)
    // 옛 루트가 지급한다. 파일 판으로 세지 않고 멈춘다.
    // 16차 감사 L-1: 두 조건을 따로 시험한다. 같은 시각으로 두면 한쪽을 지워도 통과했다.
    //  (i) 파일의 시작이 LEAD 안 (체인의 시작은 멀다): 교체용 setRoot 가 되돌려진다.
    const nowF = (await t.f.provider.getBlock('latest')).timestamp;
    rewrite(999n * E, E, nowF + DAY);
    says(await srNV(1), 'can no longer be replaced in time',
      '파일의 시작이 LEAD 안이면 교체 전 라운드를 셀 수 없어 거부된다 (16차)');
    //  (ii) 체인의 시작이 LEAD 안 (파일은 더 늦게 옮겼다): 옛 루트가 먼저 열린다.
    rewrite(999n * E, E, plan[0].start + 5 * DAY);
    t.f.node.setTime(plan[0].start - 2 * DAY);
    says(await srNV(1), 'can no longer be replaced in time',
      '교체할 시간이 남지 않은 앞 라운드의 루트가 파일과 다르면 거부된다 (15차)');
    t.f.node.setTime(plan[0].start + 60);
    says(await srNV(1), 'has already opened', '이미 열린 앞 라운드의 루트가 파일과 다르면 거부된다 (14차)');
    fs.rmSync(dirNV, { recursive: true, force: true });
  }

  console.log('\n12차 — 코드 없는 기록 claim 을 조용히 덮어쓰지 않는다 (L-2)\n');
  {
    clearRec();
    const s = await stageWall();
    const ghost = ethers.getAddress('0x' + 'c1'.repeat(20));
    mainRec(s, { addresses: { HCOWToken: s.token, HCOWClaim: ghost } });
    const cenvG = (extra = {}) => ({
      RPC_URL: s.f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY, HCOW_ADDRESS: s.token,
      CLAIM_OWNER: s.treasury, CLAIM_NOTICE_SECONDS: '259200', CLAIM_WINDOW_SECONDS: '7776000',
      TGE_TIME: String(TGE), CLAIM_DEADLINE: String(TGE + 460 * DAY), ...extra });
    says(await run('deploy-claim.cjs', cenvG()), 'shows no code',
      '코드 없는 기록 claim 은 REPLACE_CLAIM 없이 덮어쓰지 않는다 (12차)');
    ok(readRec(56).addresses.HCOWClaim === ghost, '그리고 레코드가 그대로다 (12차)');
    const rep = await run('deploy-claim.cjs', cenvG({ REPLACE_CLAIM: 'yes' }));
    const after = readRec(56);
    ok(rep.status === 0 && after.addresses.HCOWClaim !== ghost &&
       Array.isArray(after.abandoned) && after.abandoned.some((a) => a.HCOWClaim === ghost),
      '대조군: REPLACE_CLAIM=yes 면 교체하고 옛 주소를 abandoned 에 남긴다 (12차)');
  }

  console.log('\n12차 — HCOW_RECORD_DIR 는 하네스가 아닌 루프백 노드에서 거부된다 (L-1)\n');
  {
    clearRec();
    const f = await boot({ chainId: 56, now: NOW, harnessMarker: false });
    const safe = await (await dep('MockSafe', f.deployer, [await f.treasury.getAddress()])).getAddress();
    const b = await blockNo(f.provider);
    const r = await run('deploy-token.cjs', { RPC_URL: f.node.url, CHAIN_ID: '56', DEPLOYER_KEY: KEY_DEPLOY,
      TREASURY_ADDRESS: safe, FIRST_DEPLOY: '1' });
    says(r, 'is not the test harness', '루프백이지만 하네스가 아닌 노드에서는 HCOW_RECORD_DIR 를 받지 않는다 (12차)');
    ok(b === await blockNo(f.provider), '그리고 아무것도 배포되지 않았다 (12차 · 대조군은 이 스위트의 다른 모든 실행)');
  }

  // 이 스위트가 운영 레코드 디렉터리를 건드리지 않았다. 시작할 때 떠 둔 목록과 비교한다.
  {
    ok(snapshotDir(path.join(ROOT, 'deployments')) === REAL_DEPLOYMENTS_AT_START,
      '이 스위트는 운영 레코드 디렉터리(deployments/)를 건드리지 않았다 (10차)');
  }

  clearRec();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
