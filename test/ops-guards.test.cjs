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
const { boot, run, dep, ROOT, KEY_DEPLOY, KEY_TREASURY } = require('./harness/fixture.cjs');

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

    fs.rmSync(dir, { recursive: true, force: true });
  }

  clearRec();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
