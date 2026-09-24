'use strict';
/* Boots the in-process chain, deploys HCOWToken (+ optionally HCOWVesting),
 * then execs one of the real operator scripts with the env the README gives.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { makeNode, art } = require('./rpcnode.cjs');

const ROOT = path.join(__dirname, '..', '..');
const KEY_DEPLOY = '0x' + '11'.repeat(32);
const KEY_TREASURY = '0x' + '22'.repeat(32);
const KEY_OTHER = '0x' + '33'.repeat(32);

async function dep(name, signer, args) {
  const a = art(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function boot({ chainId = 56, now = 1900000000, balances = {}, harnessMarker = true } = {}) {
  const node = await makeNode({ chainId, now, balances, harnessMarker });
  const provider = new ethers.JsonRpcProvider(node.url, undefined, { staticNetwork: true });
  const deployer = new ethers.NonceManager(new ethers.Wallet(KEY_DEPLOY, provider));
  const treasury = new ethers.NonceManager(new ethers.Wallet(KEY_TREASURY, provider));
  const other = new ethers.NonceManager(new ethers.Wallet(KEY_OTHER, provider));
  return { node, provider, deployer, treasury, other, dep };
}

// spawnSync would deadlock: the RPC node lives in this process's event loop.
function run(script, env, argv = []) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...argv],
      { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (status) => resolve({ status, out }));
  });
}

module.exports = { boot, run, dep, art, KEY_DEPLOY, KEY_TREASURY, KEY_OTHER, ROOT };
