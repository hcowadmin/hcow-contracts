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

async function connect({ needSigner = true, keyVar = 'DEPLOYER_KEY', keyHint = null } = {}) {
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

  // 12차 감사 L-1. recordDir() 는 HCOW_RECORD_DIR 를 루프백 RPC 에서만 받는다.
  // 그런데 로컬 BSC 노드 · SSH 터널 · 로컬 RPC 프록시도 127.0.0.1 이고 chainId 56 을
  // 말한다. 재현: 실제 레코드가 토큰을 부르는데 빈 HCOW_RECORD_DIR 와 루프백 RPC
  // 로 돌리니 "record missing" → FIRST_DEPLOY=1 → 두 번째 토큰. 테스트 하네스는
  // 스스로 밝힌다 (hcow_isTestHarness). 그 대답이 없으면 이 변수를 받지 않는다.
  if (process.env.HCOW_RECORD_DIR) {
    let harness = false;
    try { harness = (await provider.send('hcow_isTestHarness', [])) === true; } catch (_) { harness = false; }
    if (!harness) {
      throw new Error(
        `HCOW_RECORD_DIR is set (${process.env.HCOW_RECORD_DIR}) but ${url} is not the test harness ` +
        '(it does not answer hcow_isTestHarness). That variable moves the deployment record away from ' +
        'deployments/ and exists only for the test suites. Against a real node, local or not, every ' +
        'guard would read the wrong file. Unset HCOW_RECORD_DIR.');
    }
  }

  let signer = null;
  if (needSigner) {
    const key = process.env[keyVar];
    if (!key) {
      throw new Error(
        `${keyVar} is not set. ${keyHint ? keyHint : keyVar === 'DEPLOYER_KEY'
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

// 10차 감사. HCOW_RECORD_DIR 로 레코드 위치를 바꿀 수 있다. 이유는 하나다:
// 테스트 스위트가 `deployments/` 를 통째로 지우고 가짜 chainId 56 레코드를
// 써 왔다. 운영자가 실제 체크아웃에서 `npm test` 를 돌리면 메인넷 레코드가
// 지워지고, 중간에 끊기면 하네스 주소가 적힌 가짜 메인넷 레코드가 남았다.
// 모든 가드가 그 파일을 권위로 읽는다. 테스트는 이제 자기 디렉터리를 쓴다.
function recordDir() {
  if (!process.env.HCOW_RECORD_DIR) return path.join(__dirname, '..', 'deployments');
  // 11차 감사. 이 덮어쓰기가 어떤 체인에서든 알림 없이 적용됐다. 운영자 셸에 이
  // 변수가 남아 있으면 실제 deployments/56.json 을 두고 "does not exist" 라고
  // 말하고 FIRST_DEPLOY=1 을 안내했다 — 그대로 따르면 두 번째 200,000,000 이
  // 발행된다 (재현함). 이 변수는 테스트용이다. 테스트는 언제나 로컬 인프로세스
  // 노드(127.0.0.1)를 쓰므로, RPC_URL 이 루프백이 아니면 거부한다.
  let host = '';
  try { host = new URL(process.env.RPC_URL || '').hostname; } catch (_) { /* host stays '' */ }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loopback) {
    throw new Error(
      `HCOW_RECORD_DIR is set (${process.env.HCOW_RECORD_DIR}) while RPC_URL points at ${host || 'nothing'}. ` +
      'That variable moves the deployment record away from deployments/ and exists only for the test ' +
      'suites, which always run against a local node. Against a real chain every guard would read the ' +
      'wrong file. Unset HCOW_RECORD_DIR.');
  }
  return path.resolve(process.env.HCOW_RECORD_DIR);
}

function recordPath(chainId) {
  const dir = recordDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${chainId}.json`);
}

// 이 저장소의 스크립트가 addresses 에 쓰는 이름 전부.
const RECORD_KEYS = ['HCOWToken', 'HCOWVesting', 'HCOWClaim', 'HCOWAnchor'];

/**
 * 레코드를 읽는다. 파일이 없으면 null, 있으면 **검증한 뒤** 돌려주고,
 * 검증에 실패하면 던진다. 어떤 플래그도 이 검증을 건너뛰지 않는다.
 *
 * 10차 감사. 레코드 검증이 스크립트마다 따로 있었고, 한 번 고치면 형제
 * 스크립트는 고쳐지지 않았다 — 7·8·9차에 같은 모양이 반복됐다. 그리고 9차가
 * deploy.cjs 에 넣은 엄격한 판정은 새 사고를 만들었다: 알려진 키 하나만 null
 * 이어도 "names no deployment at all" 이라고 거짓으로 말했고, 그 문구가
 * 운영자를 FIRST_DEPLOY=1 로 안내했고, FIRST_DEPLOY=1 은 기록을 {} 로 취급해
 * 모든 재실행 가드와 봉인 검사를 껐다. 재현: 봉인된 200,000,000 베스팅이
 * 레코드에서 사라지고 두 번째 토큰이 발행됐다. 같은 날 deploy-token.cjs 는
 * `{}` 레코드 위에서 플래그 없이 두 번째 토큰을 발행하고 있었다.
 *
 * 그래서 규칙을 한 곳에 두고 모든 스크립트가 이것만 쓴다.
 *
 *   파일이 없다            → null. "첫 배포" 로 볼 수 있는 유일한 상태다
 *   파일이 있는데 틀렸다    → 던진다. 존재하지만 틀린 레코드는 첫 배포가 아니라
 *                            손상이고, 손으로 고치는 것 말고는 답이 없다
 */
function readRecord(chainId) {
  const p = recordPath(chainId);
  if (!fs.existsSync(p)) return null;
  let r;
  try {
    r = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p} is not valid JSON (${e.message}). Restore the record; no flag skips this.`);
  }
  const bad = recordProblems(r, chainId);
  if (bad.length) {
    throw new Error(
      `${p} exists but is not a record any script here can trust:\n  - ${bad.join('\n  - ')}\n\n` +
      'No flag skips this, FIRST_DEPLOY included. A record that exists but is wrong is not a first ' +
      'deployment: it is a damaged or hand-edited record, and every rerun guard in this repository ' +
      'reads it as the truth. Fix the file by hand against what is actually on chain, or restore it ' +
      'from a backup.');
  }
  return r;
}

/** 레코드의 형식 결함 목록. 순수 함수라 테스트가 직접 먹일 수 있다. */
function recordProblems(r, chainId) {
  const bad = [];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return ['the file is not a JSON object'];
  if (r.chainId === undefined || r.chainId === null) {
    bad.push('it has no chainId field, so nothing shows it belongs to this chain');
  } else if (Number(r.chainId) !== Number(chainId)) {
    bad.push(`its chainId is ${r.chainId}, not ${chainId}`);
  }
  const a = r.addresses;
  if (a === undefined || a === null || typeof a !== 'object' || Array.isArray(a)) {
    bad.push('it has no addresses object');
    return bad;
  }
  const keys = Object.keys(a);
  if (keys.length === 0) bad.push('addresses is empty; no script writes a record that names nothing');
  for (const k of keys) {
    if (!RECORD_KEYS.includes(k)) {
      bad.push(`addresses.${k} is not a name any script here writes`);
      continue;
    }
    const v = a[k];
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
      bad.push(`addresses.${k} is ${JSON.stringify(v)}, not an address`);
    } else if (/^0x0{40}$/.test(v)) {
      bad.push(`addresses.${k} is the zero address`);
    }
  }
  // 정해진 순서에서 HCOWToken 은 언제나 그것에 묶이는 것들보다 먼저 기록된다.
  // HCOWClaim 이나 HCOWVesting 만 있고 토큰이 없는 레코드는 반드시 훼손된 것이다
  // (재현: 이 모양에서 deploy.cjs 가 플래그 없이 두 번째 토큰을 발행했다).
  if ((a.HCOWClaim || a.HCOWVesting) && !a.HCOWToken) {
    bad.push('it names HCOWClaim or HCOWVesting but not the HCOWToken they are bound to');
  }
  if (r.claim && r.claim.token && typeof a.HCOWToken === 'string' &&
      String(r.claim.token).toLowerCase() !== a.HCOWToken.toLowerCase()) {
    bad.push(`claim.token is ${r.claim.token} but addresses.HCOWToken is ${a.HCOWToken}`);
  }
  return bad;
}

/**
 * EIP-7702 위임 EOA 는 코드가 비어 있지 않다: 0xef0100 + 20바이트 주소, 23바이트.
 * `code === '0x'` 만 보는 "EOA 오너 거부" 가드는 위임된 EOA 를 Safe 로 통과시킨다
 * (10차 감사, 재현함). 위임 지정자는 EOA 로 본다.
 */
function isEoaCode(code) {
  return code === '0x' || /^0xef0100[0-9a-fA-F]{40}$/.test(code);
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
  // 8차 감사 L-3. `a() || b()` 는 a 가 참이면 b 를 부르지 않는다. 즉
  // DRY_RUN=yes PRINT_ONLY=mabye 로 돌리면 오타가 검증되지 않고 지나갔다.
  // 이 함수의 요점은 철자를 추측하지 않는 것이므로 둘 다 먼저 읽는다.
  const dry = dryFlag('DRY_RUN');
  const print = dryFlag('PRINT_ONLY');
  return dry || print;
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

module.exports = { connect, artifact, deploy, at, readRecord, recordProblems, recordDir, RECORD_KEYS, isEoaCode, writeRecord, sendOrPrint, dryFlag, suppressed, ethers, BSC_MAINNET, BSC_TESTNET };
