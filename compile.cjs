const fs = require('fs'), path = require('path'), solc = require('solc');
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
