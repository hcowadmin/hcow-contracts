'use strict';
// Deploys HCOWToken and NOTHING ELSE.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... TREASURY_ADDRESS=0x... \
//   FIRST_DEPLOY=1 node scripts/deploy-token.cjs
//
//   DRY_RUN=yes / PRINT_ONLY=yes    every check runs, nothing is sent
//   REPLACE_TOKEN=1                 required to overwrite a recorded HCOWToken
//   FIRST_DEPLOY=1                  required when no record exists yet
//   ALLOW_EOA_TREASURY=1            required on mainnet for a non-contract treasury
//   EXPECT_SUPPLY=<whole tokens>    overrides the 200,000,000 mainnet assertion
//
// WHY THIS FILE EXISTS.
//
// `deploy.cjs` deploys HCOWToken and HCOWVesting in one run and has no stop
// point between them. That is unusable for the real mainnet order, because
// HCOWVesting takes `expectedScheduleHash` as an IMMUTABLE constructor
// argument and that hash covers all nine beneficiary addresses -- including
// the Community/Airdrop row, which is the HCOWClaim contract. HCOWClaim in
// turn takes the token address as an immutable argument. So the only order
// that can actually be executed is:
//
//     token  ->  HCOWClaim  ->  (recompute hash)  ->  vesting  ->  load  ->  fundAndSeal
//
// and the token has to come out of the same run as the vesting for that to be
// possible. `deploy.cjs` already has the other half of this: give it
// HCOW_ADDRESS and it reuses an existing token instead of deploying one
// (deploy.cjs:146). This script is the piece that produces that address.
//
// Deploying token+vesting first and throwing the vesting away was the
// alternative. It needs no new code, but it leaves a correct-bytecode,
// BscScan-verified HCOWVesting on mainnet that was never funded and never
// sealed, which is a gift to anyone who wants to point people at the wrong
// contract. On a project whose entire position is verifiability that is a real
// cost, so a new file was preferred. See HCOW_Deployment_Order_2026-09-19.md.
//
// WHY IT HAS A DRY RUN WHEN deploy.cjs DOES NOT.
//
// `deploy.cjs` does not import dryFlag and has no early exit, so the most
// irreversible script in the repository cannot be rehearsed without sending
// real transactions. The fourth adversarial audit called that out in
// deploy-claim.cjs (C-1) and fixed it there; deploy.cjs was not in scope and
// still has the defect. A new script must not inherit it.

const { connect, deploy, at, writeRecord, readRecord, dryFlag, ethers } = require('./_connect.cjs');

const E = 10n ** 18n;
const CANONICAL_SUPPLY = 200_000_000n * E;

const addr = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set`);
  if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);
  return ethers.getAddress(v);
};

const tok = (v) => ethers.formatUnits(v, 18);

/**
 * The post-deploy readback, as a pure function of what the chain returned.
 *
 * It is separated ONLY so it can be tested. The script deploys the real
 * HCOWToken every time, so inside the script these checks are unreachable by
 * construction: no test that runs deploy-token.cjs can ever make `symbol()`
 * return something other than "HCOW". Sabotaging either check left the whole
 * suite at 55/55 — they were comments pretending to be guards.
 *
 * Splitting them out lets the decoys in contracts/test/Attackers.sol be pushed
 * through the same code path the script uses. `WrongSupplyHCOW` answers
 * symbol() with "HCOW" and mints 1 ether, which is precisely the shape this is
 * defending against.
 */
function readbackFaults({ sym, dec, supply, held, initial, expectSupply }) {
  const bad = [];
  if (sym !== 'HCOW') bad.push(`symbol is ${JSON.stringify(sym)}, expected "HCOW"`);
  if (Number(dec) !== 18) bad.push(`decimals is ${dec}, expected 18; every schedule and tree is written in 18`);
  if (initial !== supply) {
    bad.push(`INITIAL_SUPPLY ${tok(initial)} does not equal totalSupply ${tok(supply)}; something has minted or burned`);
  }
  if (expectSupply !== null && expectSupply !== undefined && supply !== expectSupply) {
    bad.push(`totalSupply ${tok(supply)} does not equal the expected ${tok(expectSupply)}`);
  }
  // The constructor mints everything to the treasury. If the treasury does not
  // hold all of it the moment the constructor returns, the address that was
  // deployed is not the contract in this repository.
  if (held !== supply) {
    bad.push(`treasury holds ${tok(held)} of ${tok(supply)}; the constructor mints the whole supply to it`);
  }
  return bad;
}

async function main() {
  // DRY_RUN and PRINT_ONLY are suppressors, so dryFlag throws on a spelling it
  // does not recognise rather than reading a typo as "go ahead". See
  // _connect.cjs. Read them FIRST: a throw here must happen before anything is
  // sent, not after.
  const dryRun = dryFlag('DRY_RUN') || dryFlag('PRINT_ONLY');

  const { provider, signer, net, mainnet } = await connect();
  const chainId = Number(net.chainId);
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);

  console.log(`chain     ${chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB`);
  if (bal === 0n && !dryRun) throw new Error('deployer has no BNB');

  // ---- rerun guard ------------------------------------------------------
  // HCOWToken mints the whole supply in its constructor, so a second
  // deployment creates a second 200,000,000 supply on the same chain. Nothing
  // on chain prevents that and nothing about it looks wrong: the new token
  // verifies on BscScan, reports the right symbol and the right supply, and is
  // a different asset. Whoever holds the first one is now holding a token the
  // record no longer names.
  //
  // The guard is REPLACE_TOKEN / FIRST_DEPLOY, strict `!== '1'`, because these
  // ENABLE a dangerous action: any spelling the author did not intend leaves
  // the danger switched off. That is the opposite of dryFlag above, and the
  // asymmetry is deliberate -- see the comment on dryFlag in _connect.cjs.
  const priorRecord = readRecord(chainId);
  const recorded = (priorRecord || {}).addresses?.HCOWToken;
  if (recorded && process.env.REPLACE_TOKEN !== '1') {
    throw new Error(
      `deployments/${chainId}.json already names HCOWToken at ${recorded}. Deploying again mints a ` +
      'SECOND 200,000,000 supply and overwrites the pointer that deploy.cjs, deploy-claim.cjs and ' +
      'set-root.cjs all read, so every later step would be built against the new token while any ' +
      'holder of the old one keeps holding the old one. If you really mean to abandon that ' +
      'deployment, re-run with REPLACE_TOKEN=1.');
  }
  if (!priorRecord && process.env.FIRST_DEPLOY !== '1' && !dryRun) {
    throw new Error(
      `deployments/${chainId}.json does not exist, so this script cannot tell whether an HCOWToken ` +
      'is already deployed on this chain. A missing record is also what a wiped or moved file looks ' +
      'like. If this really is the first deployment on this chain, re-run with FIRST_DEPLOY=1. If it ' +
      'is not, restore the record first.');
  }

  // ---- the treasury -----------------------------------------------------
  const treasury = addr('TREASURY_ADDRESS');
  console.log(`treasury  ${treasury}`);

  if (treasury === ethers.ZeroAddress) {
    throw new Error('TREASURY_ADDRESS must not be the zero address; the constructor mints the whole supply to it.');
  }
  // The deploy key publishes bytecode and then matters to nothing. If it is
  // also the treasury it holds the entire supply, and the whole argument for
  // using a throwaway key collapses. Same check as deploy.cjs:63.
  if (mainnet && treasury.toLowerCase() === me.toLowerCase()) {
    throw new Error('TREASURY_ADDRESS must not be the deploy key on mainnet.');
  }
  // 200,000,000 HCOW lands here in one transaction and the vesting owner is
  // this same address, so a single key holding it is the risk the Safe
  // structure exists to remove (HCOW_Beneficiary_Addresses_2026-09-18.md).
  // A counterfactual Safe has no code yet, which is why this is overridable --
  // but it has to be overridden deliberately, not by accident.
  if (mainnet) {
    const code = await provider.getCode(treasury);
    if (code === '0x') {
      if (process.env.ALLOW_EOA_TREASURY !== '1') {
        throw new Error(
          `TREASURY_ADDRESS ${treasury} has no code on chain ${chainId}, so it is an ordinary wallet ` +
          'or a Safe that has not been deployed yet. The whole supply is minted to it and it also ' +
          'owns the vesting contract, so one leaked key takes everything and one lost key locks ' +
          'everything with no recovery path. Deploy the Safe first (send it one wei so it exists on ' +
          'chain), or re-run with ALLOW_EOA_TREASURY=1 if a hardware wallet really is the intent.');
      }
      console.log('          WARNING: no code at the treasury. ALLOW_EOA_TREASURY is set.');
    } else {
      console.log(`          contract (${(code.length - 2) / 2} bytes of code) -- consistent with a Safe`);
    }
  }

  // ---- what the supply is expected to be --------------------------------
  const expectRaw = process.env.EXPECT_SUPPLY;
  let expectSupply = null;
  if (expectRaw !== undefined) {
    if (!/^[0-9]+$/.test(expectRaw.trim())) {
      throw new Error(`EXPECT_SUPPLY must be whole tokens as digits, not ${JSON.stringify(expectRaw)}.`);
    }
    expectSupply = BigInt(expectRaw.trim()) * E;
  } else if (mainnet) {
    expectSupply = CANONICAL_SUPPLY;
  }
  if (expectSupply !== null) console.log(`expect    ${tok(expectSupply)} HCOW total supply`);

  // ---- dry run ----------------------------------------------------------
  if (dryRun) {
    console.log('\nDRY RUN. Every check above passed. This is the constructor argument that would');
    console.log('be used, and nothing has been sent or written:');
    console.log(`  treasury  ${treasury}`);
    console.log('\nRead that address out loud against the treasury Safe before re-running. The');
    console.log('supply is minted to it in the constructor and there is no way to move it back.');
    console.log('\nRe-run without DRY_RUN / PRINT_ONLY to deploy.');
    return;
  }

  // ---- deploy -----------------------------------------------------------
  const t = await deploy('HCOWToken', signer, [treasury]);
  const token = await t.getAddress();
  console.log(`\nHCOWToken ${token}  tx ${t.deploymentTransaction().hash}`);

  // ---- read it back off chain -------------------------------------------
  // Not off the deployment receipt and not off the constructor arguments: a
  // wrongly encoded argument is silent, and this is the cheap moment to notice.
  // INITIAL_SUPPLY is a public constant, so reading it proves this is a
  // contract that HAS that constant rather than something that merely answers
  // symbol() with "HCOW".
  const tk = at('HCOWToken', token, provider);
  const [sym, dec, supply, held, initial] = await Promise.all([
    tk.symbol(), tk.decimals(), tk.totalSupply(), tk.balanceOf(treasury), tk.INITIAL_SUPPLY(),
  ]);
  console.log(`          ${sym}, ${dec} decimals, supply ${tok(supply)}, treasury holds ${tok(held)}`);

  const bad = readbackFaults({ sym, dec, supply, held, initial, expectSupply });
  if (bad.length) {
    throw new Error(
      'THE DEPLOYED TOKEN DOES NOT READ BACK AS EXPECTED. Do not continue to vesting:\n  ' +
      bad.join('\n  ') +
      `\n\nThe address is ${token} and it is NOT written to the record.`);
  }
  console.log('          reads back correctly from chain');

  // ---- record -----------------------------------------------------------
  // Merge `addresses`, never rebuild it. Rebuilding is what audit 3 A-6 found
  // in deploy.cjs: it erased the HCOWAnchor key, which silently disarmed
  // deploy-anchor.cjs's own rerun guard.
  const rec = {
    ...(priorRecord || {}),
    chainId,
    tokenDeployedAt: new Date().toISOString(),
    tokenDeployedBy: me,
    treasury,
    addresses: { ...((priorRecord || {}).addresses || {}), HCOWToken: token },
    deploymentTxs: {
      ...((priorRecord || {}).deploymentTxs || {}),
      HCOWToken: t.deploymentTransaction().hash,
    },
  };
  console.log(`written to ${writeRecord(chainId, rec)}`);

  console.log('\nNEXT, IN ORDER (HCOW_Deployment_Order_2026-09-19.md):');
  console.log('  2. Verify on BscScan and diff the deployed bytecode against the audited build');
  console.log('     solc 0.8.34, optimizer 200 runs, evmVersion paris');
  console.log(`  3. HCOW_ADDRESS=${token} ... node scripts/deploy-claim.cjs   (DRY_RUN=yes first)`);
  console.log('  4. Put the HCOWClaim address in the Community/Airdrop row and recompute EXPECT_HASH');
  console.log(`  5. HCOW_ADDRESS=${token} ... node scripts/deploy.cjs          deploys vesting only`);
  console.log('\nHCOW MUST NOT MOVE between here and fundAndSeal(). The seal checks the table');
  console.log('against the supply, so one wei out of the treasury makes sealing impossible forever.');
  console.log('\nConstructor argument, ABI-encoded, for BscScan:');
  console.log('  ' + new ethers.AbiCoder().encode(['address'], [treasury]).slice(2));
}

// Exported for test/deploy-token.test.cjs. Running the script directly is the
// normal path; `require`-ing it must not deploy anything.
module.exports = { readbackFaults, CANONICAL_SUPPLY };

if (require.main === module) {
  main().catch((e) => {
    console.error('\n' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}
