'use strict';
/* scripts/deploy-token.cjs, exercised as a child process against an
 * in-process chain. Same shape as ops-guards.test.cjs.
 *
 * Every case asserts on the ERROR PHRASE, not merely on a non-zero exit.
 * Several guards stand in a row here and "it failed" is satisfied by any of
 * them, which is how a guard passes its own test for the wrong reason. That is
 * the defect class this repository's professional audit found four times.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { boot, run, dep, ROOT, KEY_DEPLOY } = require('./harness/fixture.cjs');

const NOW = 1900000000, DAY = 86400, E = 10n ** 18n;
const EOA = '0x1111111111111111111111111111111111111111';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const says = (r, needle, m) => {
  const good = r.status !== 0 && r.out.includes(needle);
  ok(good, good ? m : `${m}\n        looked for ${JSON.stringify(needle)}, status ${r.status}, output:\n` +
    r.out.split('\n').map((l) => '        | ' + l).join('\n'));
};

// 10차 감사. 이 스위트는 ROOT/deployments 를 통째로 지우고 가짜 chainId 56
// 레코드를 써 왔다. 그 경로는 _connect.cjs 가 운영 레코드를 두는 곳과 같다.
// 운영자가 실제 체크아웃에서 `npm test` 를 돌리면 메인넷 레코드가 지워지고,
// 중간에 끊기면 하네스 주소가 적힌 가짜 메인넷 레코드가 남았다 (재현함).
// 이제 스위트 전용 디렉터리를 쓰고, 자식 프로세스도 HCOW_RECORD_DIR 로 같은
// 곳을 본다. run() 이 process.env 를 넘기므로 여기서 한 번 정하면 된다.
const REC_DIR = path.join(ROOT, 'build', 'test-deployments', 'deploy-token');
process.env.HCOW_RECORD_DIR = REC_DIR;
// (11차 감사: 상수 두 개를 비교하던 "refusing to run" 검사를 지웠다. 절대 발동하지 않았다.)
// 운영 레코드 디렉터리의 지문. 끝에서 바뀌지 않았는지 본다 (ops-guards 와 같은 방식).
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

async function stage({ chainId = 56 } = {}) {
  const f = await boot({ chainId, now: NOW });
  // A contract treasury, because the mainnet code check demands one.
  const safe = await dep('MockSafe', f.deployer, [await f.treasury.getAddress()]);
  return { f, chainId, safe, treasury: await safe.getAddress(), deployer: await f.deployer.getAddress() };
}
const env = (s, extra = {}) => ({
  RPC_URL: s.f.node.url, CHAIN_ID: String(s.chainId), DEPLOYER_KEY: KEY_DEPLOY,
  TREASURY_ADDRESS: s.treasury, ...extra,
});

(async () => {
  console.log('\ndeploy-token.cjs — dry run\n');
  {
    clearRec();
    const s = await stage();
    for (const flag of ['DRY_RUN', 'PRINT_ONLY']) {
      const r = await run('deploy-token.cjs', env(s, { [flag]: 'yes' }));
      ok(r.status === 0, `${flag}=yes exits 0`);
      ok(r.out.includes('DRY RUN'), `${flag}=yes says DRY RUN`);
      ok(r.out.includes(s.treasury), `${flag}=yes prints the treasury for a human to read back`);
      ok(!hasRec(56), `${flag}=yes writes no record at all`);
    }
    // A dry run must not need FIRST_DEPLOY: refusing to rehearse is how people
    // stop rehearsing.
    ok(!hasRec(56), 'dry run needs no record and creates none');
  }

  console.log('\ndeploy-token.cjs — a mistyped suppressor must not send\n');
  {
    clearRec();
    const s = await stage();
    const r = await run('deploy-token.cjs', env(s, { DRY_RUN: 'ture', FIRST_DEPLOY: '1' }));
    says(r, 'is not a value this script understands', 'DRY_RUN=ture throws instead of deploying');
    ok(!hasRec(56), 'DRY_RUN=ture deployed nothing');
  }

  console.log('\ndeploy-token.cjs — rerun guard\n');
  {
    clearRec();
    const s = await stage();
    const r1 = await run('deploy-token.cjs', env(s));
    says(r1, 'FIRST_DEPLOY=1', 'no record and no FIRST_DEPLOY refuses, naming the flag');
    ok(!hasRec(56), 'the refusal deployed nothing');

    // 12차 감사 M-1. 앵커만 적힌 레코드(레코드를 잃은 뒤 deploy-anchor.cjs 가 새로
    // 쓴 파일의 모양)는 "처음이 아니다" 의 증거가 아니다. 이전 판은 이 파일 하나로
    // 플래그 없이 두 번째 200,000,000 을 발행했다.
    writeRec(56, { chainId: 56, addresses: { HCOWAnchor: '0x' + 'a1'.repeat(20) } });
    const bA = Number(await s.f.provider.send('eth_blockNumber', []));
    const rA = await run('deploy-token.cjs', env(s));
    says(rA, 'names no HCOWToken', '앵커만 적힌 레코드로는 FIRST_DEPLOY 없이 토큰을 발행하지 않는다 (12차)');
    ok(bA === Number(await s.f.provider.send('eth_blockNumber', [])) && !readRec(56).addresses.HCOWToken,
      '그리고 아무것도 배포되거나 기록되지 않았다 (12차)');

    // 대조군: 같은 앵커만 적힌 레코드에서 FIRST_DEPLOY=1 은 배포하고 앵커를 보존한다.
    const r2 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1' }));
    ok(r2.status === 0, 'FIRST_DEPLOY=1 deploys');
    ok(readRec(56).addresses.HCOWAnchor === '0x' + 'a1'.repeat(20), '그리고 레코드의 앵커를 그대로 둔다 (12차)');
    const first = readRec(56).addresses.HCOWToken;
    ok(!!first && ethers.isAddress(first), 'the record names HCOWToken');

    const r3 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1' }));
    says(r3, 'REPLACE_TOKEN=1', 'a recorded token refuses a second deploy, naming the flag');
    says(r3, 'SECOND 200,000,000 supply', 'the refusal says what a second deploy would actually do');
    ok(readRec(56).addresses.HCOWToken === first, 'the refusal left the record untouched');

    // REPLACE_TOKEN ENABLES a dangerous action, so it is strict `!== '1'`:
    // every spelling but the intended one must leave the danger switched off.
    // This is the opposite of DRY_RUN above, and getting the direction backwards
    // is what audit 4 C-2 was.
    for (const spelling of ['yes', 'true', 'on', 'YES', '2', ' 1']) {
      const r = await run('deploy-token.cjs', env(s, { REPLACE_TOKEN: spelling }));
      says(r, 'REPLACE_TOKEN=1', `REPLACE_TOKEN=${JSON.stringify(spelling)} does NOT enable a replace`);
    }
    const r4 = await run('deploy-token.cjs', env(s, { REPLACE_TOKEN: '1' }));
    ok(r4.status === 0, 'REPLACE_TOKEN=1 does deploy');
    ok(readRec(56).addresses.HCOWToken !== first, 'and the record now names the new token');
  }

  console.log('\ndeploy-token.cjs — the treasury\n');
  {
    clearRec();
    const s = await stage();
    const r1 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1', TREASURY_ADDRESS: s.deployer }));
    says(r1, 'must not be the deploy key on mainnet', 'mainnet refuses the deploy key as treasury');

    const r2 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1', TREASURY_ADDRESS: ethers.ZeroAddress }));
    says(r2, 'must not be the zero address', 'the zero address is refused');

    const r3 = await run('deploy-token.cjs', { ...env(s, { FIRST_DEPLOY: '1' }), TREASURY_ADDRESS: '' });
    says(r3, 'TREASURY_ADDRESS must be set', 'a missing treasury is refused');

    const r4 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1', TREASURY_ADDRESS: '0xnot_an_address' }));
    says(r4, 'is not an address', 'a malformed treasury is refused');

    // An EOA treasury on mainnet: the supply lands behind one key and that key
    // also owns the vesting contract.
    const r5 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1', TREASURY_ADDRESS: EOA }));
    says(r5, 'has no code on chain', 'mainnet refuses a treasury with no code');
    says(r5, 'ALLOW_EOA_TREASURY=1', 'and names the override rather than being a dead end');
    ok(!hasRec(56), 'the refusal deployed nothing');

    const r6 = await run('deploy-token.cjs',
      env(s, { FIRST_DEPLOY: '1', TREASURY_ADDRESS: EOA, ALLOW_EOA_TREASURY: '1' }));
    ok(r6.status === 0, 'ALLOW_EOA_TREASURY=1 permits it');
    ok(r6.out.includes('WARNING'), 'and says so loudly');
  }

  console.log('\ndeploy-token.cjs — off mainnet the code check does not apply\n');
  {
    clearRec();
    const s = await stage({ chainId: 97 });
    const r = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1', TREASURY_ADDRESS: EOA }));
    ok(r.status === 0, 'testnet accepts an EOA treasury with no override');
    ok(readRec(97).treasury === EOA, 'and records it');
  }

  console.log('\ndeploy-token.cjs — supply assertion\n');
  {
    clearRec();
    const s = await stage({ chainId: 97 });
    const r1 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '200000000' }));
    ok(r1.status === 0, 'EXPECT_SUPPLY matching the real supply passes');

    clearRec();
    const s2 = await stage({ chainId: 97 });
    // 12차 감사 M-3. 이전 판은 이 경우를 배포 **뒤** 에 잡았다 (단언도 그렇게 적혀
    // 있었다: "DOES NOT READ BACK AS EXPECTED"). 즉 이 테스트는 고아 토큰이 체인에
    // 남는 동작을 정상으로 고정하고 있었다. 이제 배포 전에 거부되고 블록이 늘지 않는다.
    const b2 = Number(await s2.f.provider.send('eth_blockNumber', []));
    const r2 = await run('deploy-token.cjs', env(s2, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '199999999' }));
    says(r2, 'has no supply argument', 'a supply one token out is caught before deploying (12차)');
    ok(b2 === Number(await s2.f.provider.send('eth_blockNumber', [])), 'and no token was deployed for it (12차)');
    ok(!hasRec(97), 'and nothing is recorded');
    const r2d = await run('deploy-token.cjs', env(s2, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '20000000', DRY_RUN: 'yes' }));
    says(r2d, 'has no supply argument', 'the dry run refuses a wrong EXPECT_SUPPLY too (12차)');

    clearRec();
    const s3 = await stage({ chainId: 97 });
    const r3 = await run('deploy-token.cjs', env(s3, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '2e8' }));
    says(r3, 'whole tokens as digits', 'EXPECT_SUPPLY in exponent form is refused, not parsed as 2');

    clearRec();
    const s4 = await stage({ chainId: 97 });
    const r4 = await run('deploy-token.cjs',
      env(s4, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '200000000000000000000000000' }));
    says(r4, 'has no supply argument',
      'EXPECT_SUPPLY given in wei is caught rather than silently accepted');
  }

  console.log('\ndeploy-token.cjs — mainnet asserts 200,000,000 with no EXPECT_SUPPLY\n');
  {
    clearRec();
    const s = await stage();
    const r = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1' }));
    ok(r.status === 0, 'the real token passes the implicit mainnet assertion');
    ok(r.out.includes('200000000.0 HCOW total supply') || r.out.includes('expect    200000000'),
      'and the expectation was stated before deploying, not after');
  }

  console.log('\ndeploy-token.cjs — the record is merged, never rebuilt\n');
  {
    clearRec();
    const s = await stage();
    // Audit 3 A-6: deploy.cjs used to rebuild `addresses` wholesale, which
    // erased HCOWAnchor and silently disarmed deploy-anchor.cjs's own guard.
    writeRec(56, {
      chainId: 56,
      addresses: { HCOWAnchor: '0x2222222222222222222222222222222222222222' },
      deploymentTxs: { HCOWAnchor: '0xdead' },
      keepMe: 'a field no script knows about',
    });
    // 12차 감사 M-1: 이 단언은 "토큰 없는 레코드는 플래그가 필요 없다" 였다. 그것이
    // 바로 레코드를 잃은 뒤 앵커만 적힌 새 파일로 두 번째 토큰을 발행하던 경로다.
    // 이제 토큰을 부르지 않는 레코드는 FIRST_DEPLOY=1 을 요구하고, 여기서 보는 것은
    // 그 플래그로 배포했을 때 레코드가 병합되는가다.
    const r = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1' }));
    ok(r.status === 0, 'an existing record without HCOWToken deploys with FIRST_DEPLOY=1 (12차)');
    const rec = readRec(56);
    ok(rec.addresses.HCOWAnchor === '0x2222222222222222222222222222222222222222',
      'HCOWAnchor survives the write');
    ok(rec.deploymentTxs.HCOWAnchor === '0xdead', 'its deployment tx survives too');
    ok(rec.keepMe === 'a field no script knows about', 'unknown top-level fields survive');
    ok(!!rec.addresses.HCOWToken, 'and HCOWToken was added');
  }

  console.log('\ndeploy-token.cjs — chain confusion\n');
  {
    clearRec();
    const s = await stage({ chainId: 97 });
    const r = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1', CHAIN_ID: '56' }));
    says(r, 'Refusing to continue', 'CHAIN_ID disagreeing with the node refuses');
    ok(!hasRec(56) && !hasRec(97), 'and deploys nothing on either chain');
  }

  console.log('\ndeploy-token.cjs — readbackFaults against the decoys in Attackers.sol\n');
  {
    // These two checks are unreachable from inside the script: it deploys the
    // real HCOWToken every time, so symbol() is always "HCOW" and the treasury
    // always holds everything. Sabotaging either one left the suite at 55/55.
    // readbackFaults is the same code the script calls, pushed the values a
    // hostile or wrong contract would return.
    const { readbackFaults } = require(path.join(ROOT, 'scripts', 'deploy-token.cjs'));
    const S = 200_000_000n * E;
    const good = { sym: 'HCOW', dec: 18n, supply: S, held: S, initial: S, expectSupply: S };
    const only = (o) => readbackFaults({ ...good, ...o });

    ok(readbackFaults(good).length === 0, 'the real token produces no faults');

    const s1 = only({ sym: 'USDT' });
    ok(s1.length === 1 && s1[0].includes('symbol is "USDT"'), 'a wrong symbol is caught, and named');

    const s2 = only({ dec: 6n });
    ok(s2.length === 1 && s2[0].includes('decimals is 6'), 'six decimals is caught');

    // WrongSupplyHCOW: symbol() says HCOW, supply is 1 ether. The decoy that
    // exists precisely because symbol() alone is not identity.
    const s3 = only({ supply: E, held: E, initial: E });
    ok(s3.length === 1 && s3[0].includes('does not equal the expected'),
      'WrongSupplyHCOW shape is caught by the supply check, not by symbol()');
    ok(s3.length === 1 && !s3[0].includes('symbol'), 'and symbol() did NOT catch it — that is the point');

    // The treasury not holding everything: a token whose constructor sent the
    // supply somewhere else, or a proxy in front of one.
    const s4 = only({ held: S - 1n });
    ok(s4.length === 1 && s4[0].includes('the constructor mints the whole supply to it'),
      'one wei short at the treasury is caught');
    const s5 = only({ held: 0n });
    ok(s5.length === 1, 'a treasury holding nothing is caught');

    // INITIAL_SUPPLY disagreeing with totalSupply: something minted or burned
    // between the constructor and the readback.
    const s6 = only({ initial: S + E });
    ok(s6.length === 1 && s6[0].includes('INITIAL_SUPPLY'), 'INITIAL_SUPPLY != totalSupply is caught');

    // expectSupply absent must not disable the other checks.
    const s7 = readbackFaults({ ...good, expectSupply: null, supply: E, held: E, initial: E });
    ok(s7.length === 0, 'with no expectSupply a wrong supply is NOT flagged by that check');
    const s8 = readbackFaults({ ...good, expectSupply: null, sym: 'USDT' });
    ok(s8.length === 1, 'but the other checks still run with expectSupply null');

    // Several at once, so a single early return could not pass this.
    const s9 = only({ sym: 'USDT', dec: 6n, held: 0n });
    ok(s9.length === 3, 'three simultaneous faults produce three messages, not one');
  }

  ok(snapshotDir(path.join(ROOT, 'deployments')) === REAL_DEPLOYMENTS_AT_START,
    '이 스위트는 운영 레코드 디렉터리(deployments/)를 건드리지 않았다 (11차)');
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
