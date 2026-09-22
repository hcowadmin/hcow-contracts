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

const recPath = (c) => path.join(ROOT, 'deployments', `${c}.json`);
const clearRec = () => fs.rmSync(path.join(ROOT, 'deployments'), { recursive: true, force: true });
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

    const r2 = await run('deploy-token.cjs', env(s, { FIRST_DEPLOY: '1' }));
    ok(r2.status === 0, 'FIRST_DEPLOY=1 deploys');
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
    const r2 = await run('deploy-token.cjs', env(s2, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '199999999' }));
    says(r2, 'DOES NOT READ BACK AS EXPECTED', 'a supply one token out is caught');
    says(r2, 'is NOT written to the record', 'and the failure says the address was not recorded');
    ok(!hasRec(97), 'a token that fails readback is not recorded');

    clearRec();
    const s3 = await stage({ chainId: 97 });
    const r3 = await run('deploy-token.cjs', env(s3, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '2e8' }));
    says(r3, 'whole tokens as digits', 'EXPECT_SUPPLY in exponent form is refused, not parsed as 2');

    clearRec();
    const s4 = await stage({ chainId: 97 });
    const r4 = await run('deploy-token.cjs',
      env(s4, { FIRST_DEPLOY: '1', EXPECT_SUPPLY: '200000000000000000000000000' }));
    says(r4, 'DOES NOT READ BACK AS EXPECTED',
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
    const r = await run('deploy-token.cjs', env(s));
    ok(r.status === 0, 'an existing record without HCOWToken needs no flag');
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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
