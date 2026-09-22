'use strict';
// Minimal RPC plumbing. This repository has no hardhat: `compile.cjs` drives
// solc directly and the test suites run an in-process EVM, so a deployment
// needs nothing more than a provider, a signer, and the artifacts already on
// disk.
//
//   RPC_URL      required
//   CHAIN_ID     required, and checked against what the node reports. A
//                deployment pointed at the wrong chain is not recoverable and
//                the node will not volunteer that it is the wrong one.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const BSC_MAINNET = 56n;
const BSC_TESTNET = 97n;

async function connect({ needSigner = true, keyVar = 'DEPLOYER_KEY' } = {}) {
  const url = process.env.RPC_URL;
  if (!url) throw new Error('RPC_URL is not set.');
  const want = process.env.CHAIN_ID;
  if (!want) throw new Error('CHAIN_ID is not set. Use 97 for BSC testnet, 56 for mainnet.');

  const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (net.chainId !== BigInt(want)) {
    throw new Error(
      `CHAIN_ID says ${want} but ${url} reports ${net.chainId}. Refusing to continue.`);
  }

  let signer = null;
  if (needSigner) {
    const key = process.env[keyVar];
    if (!key) {
      throw new Error(
        `${keyVar} is not set. ${keyVar === 'DEPLOYER_KEY'
          ? 'Use a throwaway wallet: it publishes bytecode and holds no role afterwards.'
          : 'This is the address that holds the HCOW supply and owns the vesting contract.'}`);
    }
    // NonceManager: these scripts send several transactions in sequence and a
    // cached transaction count is long enough to reuse a nonce.
    signer = new ethers.NonceManager(new ethers.Wallet(key, provider));
  }

  return { provider, signer, net, mainnet: net.chainId === BSC_MAINNET, testnet: net.chainId === BSC_TESTNET };
}

function artifact(name) {
  const p = path.join(__dirname, '..', 'artifacts', `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`no artifact for ${name} at ${p}. Run: node compile.cjs`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function deploy(name, signer, args) {
  const a = artifact(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

function at(name, address, runner) {
  return new ethers.Contract(address, artifact(name).abi, runner);
}

function recordPath(chainId) {
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${chainId}.json`);
}

function readRecord(chainId) {
  const p = recordPath(chainId);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function writeRecord(chainId, obj) {
  const p = recordPath(chainId);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

/**
 * Reads a flag whose job is to SUPPRESS a dangerous action (PRINT_ONLY,
 * DRY_RUN).
 *
 * These are the opposite of ALLOW_GAP / REPLACE_ANCHOR / ALLOW_SAME_ROOT.
 * Those enable something dangerous, so `!== '1'` is right: any spelling the
 * author did not intend leaves the danger switched off. A suppressor compared
 * the same way fails the other direction — `PRINT_ONLY=1` was not the literal
 * 'yes', so the transaction went out for real. The fourth adversarial audit
 * (2026-09-18, C-2) sent a live setRoot that way, and the repository taught
 * the habit itself: seal.cjs wanted 'yes', anchor.cjs wanted '1'.
 *
 * So: accept every ordinary spelling of yes and of no, and THROW on anything
 * else rather than guessing. A typo must not be read as "go ahead".
 */
const DRY_YES = new Set(['yes', 'y', '1', 'true', 'on']);
const DRY_NO = new Set(['', 'no', 'n', '0', 'false', 'off']);
function dryFlag(name) {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const v = String(raw).trim().toLowerCase();
  if (DRY_YES.has(v)) return true;
  if (DRY_NO.has(v)) return false;
  // 7차 감사 L-2. 이 함수는 억제 플래그(DRY_RUN·PRINT_ONLY)와 활성 플래그
  // (REPLACE_CLAIM·ALLOW_UNDERFUNDED…) 양쪽에 쓰인다. 예전 문구는 "억제하려면
  // yes 를 쓰라" 고만 말해서, 활성 플래그에 대해서는 방향을 정반대로 안내했다.
  // 동작은 어느 쪽이든 fail-closed 지만 안내문이 거짓이면 안 된다.
  throw new Error(
    `${name}=${JSON.stringify(raw)} is not a value this script understands. ` +
    `Use one of ${[...DRY_YES].join(' / ')} to turn ${name} ON, one of ` +
    `${[...DRY_NO].filter(Boolean).join(' / ')} to turn it off, or unset it. ` +
    'Refusing to guess, because guessing wrong here sends a real transaction.');
}

/**
 * The two names this repository uses for "do not send anything".
 *
 * 7차 감사 H-3 · H-4 · H-5. Each script had picked one name and silently
 * ignored the other: set-root.cjs knew PRINT_ONLY and not DRY_RUN, anchor.cjs
 * the reverse, deploy-anchor.cjs neither. An operator who learned one name
 * from one script and typed it at another got a real, irreversible
 * transaction while believing it was a rehearsal. Both names now mean the same
 * thing everywhere, and an unrecognised spelling of either still throws.
 */
function suppressed() {
  return dryFlag('DRY_RUN') || dryFlag('PRINT_ONLY');
}

/**
 * Either sends the transaction, or prints what would be sent.
 *
 * PRINT_ONLY exists because on mainnet the owner of the vesting contract is
 * also the treasury, and the treasury is a hardware wallet whose private key
 * is not available to a script and must not be. Printing `to` and `data` lets
 * that wallet submit the same call through its own interface.
 */
async function sendOrPrint(label, contract, method, args, { from }) {
  const data = contract.interface.encodeFunctionData(method, args);
  const to = await contract.getAddress();
  if (suppressed()) {
    console.log(`\n  ${label}`);
    console.log(`    from   ${from}`);
    console.log(`    to     ${to}`);
    console.log(`    value  0`);
    console.log(`    data   ${data}`);
    return null;
  }
  const tx = await contract[method](...args);
  const rc = await tx.wait();
  console.log(`  ${label}  tx ${rc.hash}  gas ${rc.gasUsed}`);
  return rc;
}

module.exports = { connect, artifact, deploy, at, readRecord, writeRecord, sendOrPrint, dryFlag, suppressed, ethers, BSC_MAINNET, BSC_TESTNET };
