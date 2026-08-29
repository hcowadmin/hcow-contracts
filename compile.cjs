const fs = require('fs'), path = require('path');
// Pinned, and pinned to the same version the other repository uses. The two
// repositories are audited and deployed together, and a compiler difference
// between them is a difference nobody would think to look for.
const solc = require('solc-0834');
function readFile(p) { return fs.readFileSync(p, 'utf8'); }
function resolveImport(imp) {
  if (imp.startsWith('@openzeppelin/')) {
    const p = path.join(__dirname, 'node_modules', imp);
    if (fs.existsSync(p)) return { contents: readFile(p) };
  }
  for (const d of ['contracts', 'contracts/test']) {
    const local = path.join(__dirname, d, path.basename(imp));
    if (fs.existsSync(local)) return { contents: readFile(local) };
  }
  return { error: 'not found: ' + imp };
}
const sources = {};
function walk(dir, base) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, base);
    else if (f.endsWith('.sol')) sources[path.relative(base, p)] = { content: readFile(p) };
  }
}
walk('contracts', 'contracts');
const input = {
  language: 'Solidity', sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // Explicit, not defaulted, and pinned to paris. It must match
    // hardhat.config.cjs and both foundry.toml files exactly, because the
    // compiler settings are part of the BscScan verification input and a
    // mismatch produces different bytecode and a verification failure with no
    // useful error.
    //
    // The earlier note here said a newer target emits opcodes BNB Chain may
    // not have. That was true when it was written and is not true now: BNB
    // Chain has PUSH0, and transient storage and MCOPY arrived with the
    // Feynman and Pascal upgrades. So the choice is portability rather than
    // capability. Nothing in these contracts uses transient storage or memory
    // copying, so cancun would buy a little gas on constant pushes and nothing
    // else, while paris keeps the deployed bytecode free of any opcode that a
    // BSC-compatible fork, an archive node or an auditor's tooling might not
    // implement. For contracts whose security argument is that anybody can
    // re-derive and re-verify them, that is the better trade.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const errs = (out.errors || []).filter(e => e.severity === 'error');
const warns = (out.errors || []).filter(e => e.severity === 'warning');
warns.forEach(w => console.log('WARN:', w.formattedMessage.split('\n')[0]));
if (errs.length) { errs.forEach(e => console.error(e.formattedMessage)); process.exit(1); }
fs.mkdirSync('artifacts', { recursive: true });
for (const [file, cs] of Object.entries(out.contracts || {})) {
  for (const [name, c] of Object.entries(cs)) {
    const size = c.evm.deployedBytecode.object.length / 2;
    console.log(`OK ${name.padEnd(16)} deployed ${String(size).padStart(6)} bytes  (limit 24576)`);
    fs.writeFileSync(path.join('artifacts', name + '.json'),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }));
  }
}
console.log('COMPILE OK');
