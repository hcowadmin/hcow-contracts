'use strict';
// Deploys HCOWToken and HCOWVesting. Loads no schedules and seals nothing.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... \
//   TREASURY_ADDRESS=0x... RESCUE_RECIPIENT=0x... TGE_TIME=<unix seconds> \
//   SCHEDULE=schedule/testnet.json \
//   EXPECT_BENEFICIARIES=.. EXPECT_SCHEDULED=.. EXPECT_TGE_UNLOCK=.. EXPECT_HASH=0x.. \
//   node scripts/deploy.cjs
//
// Get the four EXPECT_ values from `node scripts/commitcheck.cjs <schedule>`.
// This script recomputes them from the same schedule file using a different
// implementation and refuses to deploy unless both agree. That is the entire
// point of the pair: the commitments are immutable and a wrong one produces a
// contract that can never be sealed, so they are checked by two things that
// could have disagreed rather than by one thing twice.
//
// WHY THE TREASURY IS ALSO THE VESTING OWNER, AND WHY THIS SCRIPT INSISTS.
//
// fundAndSeal() pulls the shortfall from msg.sender, and before TGE
// _authoriseSeal() requires msg.sender == owner(). So the address that holds
// the HCOW must be the address that owns the contract, or the intended atomic
// funding path does not exist at all and the only remaining route is a bare
// transfer followed by a separate seal, which is exactly the window the atomic
// path was written to close. The audit reported this as Vesting Low #5. The
// fix is operational rather than a code change, which is why the deployed
// bytecode is still the audited bytecode, and this check is what makes the
// operational fix real rather than remembered.

const path = require('path');
const { connect, deploy, at, writeRecord, readRecord, ethers } = require('./_connect.cjs');
const { commitments } = require('../vestcommit.cjs');
const { loadSchedule } = require('./commitcheck.cjs');

const DAY = 24 * 60 * 60;

const addr = (k, { required = true } = {}) => {
  const v = process.env[k];
  if (!v) {
    if (!required) return null;
    throw new Error(`${k} must be set`);
  }
  if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);
  return ethers.getAddress(v);
};

/**
 * 되읽기 비교를 순수 함수로 분리한 이유. (7차 감사 조치의 사보타주에서 나옴)
 *
 * 이 스크립트는 언제나 자기가 방금 보낸 인자로 배포한 컨트랙트를 읽는다.
 * 그래서 어떤 비교도 정상 경로에서는 절대 틀리지 않는다 — 비교문을 통째로
 * 지우고 전 스위트를 돌려도 초록이었다. 테스트가 약한 게 아니라 그 분기에
 * 닿을 방법이 없는 것이다 (백로그 C-7). deploy-token.cjs 가 같은 이유로
 * readbackFaults 를 분리했고 여기도 같은 처리를 한다.
 *
 * 인자는 체인에서 읽은 값(on)과 보냈어야 할 값(want)이다. 문자열 비교는
 * 소문자로, 금액은 BigInt 로 한다.
 */
function readbackFaults(on, want) {
  const bad = [];
  const addrNe = (a, b) => String(a).toLowerCase() !== String(b).toLowerCase();
  // token · rescueRecipient · supplyCap 은 전부 immutable 인데 7차 감사 전까지
  // 되읽기가 한 번도 읽지 않았다. rescueRecipient 는 컨트랙트 주석이 직접
  // "immutable 이고 봉인 후엔 owner 도 없으므로 여기서 틀리면 영구적" 이라고
  // 적어둔 값이다.
  if (addrNe(on.oTok, want.token)) bad.push(`token ${on.oTok}, expected ${want.token}`);
  if (addrNe(on.oResc, want.rescue)) bad.push(`rescueRecipient ${on.oResc}, expected ${want.rescue}`);
  if (BigInt(on.oCap) !== BigInt(want.supply)) bad.push(`supplyCap ${on.oCap}, expected the token supply ${want.supply}`);
  if (BigInt(on.ob) !== BigInt(want.count)) bad.push(`expectedBeneficiaries ${on.ob}`);
  if (BigInt(on.os) !== BigInt(want.total)) bad.push(`expectedScheduled ${on.os}`);
  if (BigInt(on.ou) !== BigInt(want.unlock)) bad.push(`expectedTgeUnlock ${on.ou}`);
  if (addrNe(on.oh, want.hash)) bad.push(`expectedScheduleHash ${on.oh}`);
  if (addrNe(on.oo, want.treasury)) bad.push(`owner ${on.oo}, expected the treasury ${want.treasury}`);
  if (BigInt(on.ot) !== BigInt(want.tge)) bad.push(`tgeTime ${on.ot}`);
  return bad;
}

async function main() {
  const { provider, signer, net, mainnet } = await connect();
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);

  console.log(`chain     ${net.chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB\n`);
  if (bal === 0n) throw new Error('deployer has no BNB');

  const treasury = addr('TREASURY_ADDRESS');
  const rescue = addr('RESCUE_RECIPIENT');

  // The deploy key publishes bytecode and then matters to nothing. If it is
  // also the treasury it holds the entire supply, and the whole argument for
  // using a throwaway key collapses.
  if (mainnet && treasury.toLowerCase() === me.toLowerCase()) {
    throw new Error('TREASURY_ADDRESS must not be the deploy key on mainnet.');
  }
  // rescueRecipient is immutable, and the constructor already refuses the two
  // values that make rescue a silent no-op. It does not refuse the treasury,
  // which is fine, or the vesting contract's own future address, which nobody
  // can predict here. Refusing the zero address is the one thing left.
  if (rescue === ethers.ZeroAddress) throw new Error('RESCUE_RECIPIENT must not be the zero address');

  // ---- TGE time ---------------------------------------------------------
  // tgeTime is immutable and everything hangs off it: addSchedule closes at
  // TGE, seal() changes hands at TGE, and every unlock is measured from it.
  const tge = Number(process.env.TGE_TIME || 0);
  if (!Number.isInteger(tge) || tge <= 0) {
    throw new Error('TGE_TIME must be a unix timestamp in SECONDS, not milliseconds and not a date string.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (tge <= now) throw new Error(`TGE_TIME ${tge} is in the past (now ${now})`);
  if (tge > now + 365 * DAY) throw new Error(`TGE_TIME ${tge} is more than 365 days out; the constructor refuses it`);
  const days = ((tge - now) / DAY).toFixed(2);
  console.log(`TGE       ${new Date(tge * 1000).toISOString()}  (${days} days out)`);
  // Loading the table has to finish before TGE or addSchedule closes with a
  // half written table. Nine rows is minutes, but a TGE hours away leaves no
  // room for anything going wrong.
  if (mainnet && tge < now + 2 * DAY) {
    throw new Error(
      `TGE_TIME is less than 2 days away. addSchedule closes at TGE and a table ` +
      `that is not finished by then cannot be completed. Set a later TGE.`);
  }

  // ---- schedule and commitments ----------------------------------------
  const file = process.env.SCHEDULE || 'schedule/testnet.json';
  const { meta, rows } = loadSchedule(path.resolve(file));
  console.log(`schedule  ${file}  (${rows.length} rows)`);
  if (mainnet && /TESTNET ONLY/i.test(meta.warning || '')) {
    throw new Error(`${file} is marked TESTNET ONLY. Refusing to deploy it on mainnet.`);
  }
  if (mainnet && rows.some((r) => /^0x0{40}$/i.test(r.beneficiary))) {
    throw new Error(`${file} still has placeholder zero addresses. Fill in every beneficiary.`);
  }

  const c = commitments(rows.map((r) => ({
    beneficiary: r.beneficiary,
    total: BigInt(r.total),
    tgeBps: r.tgeBps,
    cliffMonths: r.cliffMonths,
    linearMonths: r.linearMonths,
  })));

  const expect = {
    count: process.env.EXPECT_BENEFICIARIES,
    total: process.env.EXPECT_SCHEDULED,
    unlock: process.env.EXPECT_TGE_UNLOCK,
    hash: process.env.EXPECT_HASH,
  };
  if (!expect.count || !expect.total || !expect.unlock || !expect.hash) {
    throw new Error(
      'The four EXPECT_ values are required. Produce them with:\n' +
      `  node scripts/commitcheck.cjs ${file}\n` +
      'and export the four lines it prints. They are checked against a second,\n' +
      'independent computation here before anything is deployed.');
  }
  const disagree = [];
  if (String(c.count) !== String(expect.count)) disagree.push(`beneficiaries ${c.count} vs ${expect.count}`);
  if (String(c.total) !== String(expect.total)) disagree.push(`scheduled ${c.total} vs ${expect.total}`);
  if (String(c.unlock) !== String(expect.unlock)) disagree.push(`tgeUnlock ${c.unlock} vs ${expect.unlock}`);
  if (c.hash.toLowerCase() !== expect.hash.toLowerCase()) disagree.push(`hash ${c.hash} vs ${expect.hash}`);
  if (disagree.length) {
    throw new Error(
      'THE TWO COMMITMENT COMPUTATIONS DISAGREE. Nothing has been deployed.\n  ' +
      disagree.join('\n  ') +
      '\n\nOne of them is wrong. Find out which before deploying anything. The most\n' +
      'common cause is `total` computed at 256 bits: it is uint128 in the preimage.');
  }
  console.log('commit    two independent computations agree\n');

  const E = 10n ** 18n;
  const tok = (v) => (v / E).toLocaleString('en-US');
  console.log(`  beneficiaries  ${c.count}`);
  console.log(`  scheduled      ${tok(c.total)} HCOW`);
  console.log(`  TGE unlock     ${tok(c.unlock)} HCOW  (${(Number(c.unlock * 10000n / c.total) / 100).toFixed(2)}% of the table)`);
  console.log(`  hash           ${c.hash}\n`);

  // ---- has any of this already been deployed? ---------------------------
  //
  // 7차 감사 C-1. 이 파일에는 재실행 가드가 한 줄도 없었다. HCOW_ADDRESS 를
  // 빠뜨린 실행 하나가 두 번째 200,000,000 을 발행하고, 레코드의 HCOWToken 을
  // 조용히 교체하고, exit 0 으로 끝났다. 새 베스팅은 새 토큰에 immutable 로
  // 묶이고 이미 배포된 HCOWClaim 은 옛 토큰에 immutable 로 묶여 영원히 자금을
  // 받지 못한다. 형제인 deploy-claim.cjs 와 deploy-token.cjs 는 둘 다 이
  // 가드를 갖고 있었다.
  //
  // 이 세 검사는 전부 첫 배포 트랜잭션보다 앞에 있어야 한다. 거절된 실행이
  // 체인에 토큰 하나를 남기면 가드가 절반만 작동한 것이다.
  const chainIdNum = Number(net.chainId);
  const priorRecord = readRecord(chainIdNum);
  if (!priorRecord && process.env.FIRST_DEPLOY !== '1') {
    throw new Error(
      `no deployments/${chainIdNum}.json exists. That is what a first deploy looks like, and it is ` +
      'also what a wiped or missing record looks like after something was already deployed here. ' +
      'Every rerun guard below reads that record and none of them can run without it. If this really ' +
      'is the first deploy on this chain, re-run with FIRST_DEPLOY=1. If it is not, restore the record.');
  }
  const record = priorRecord || {};
  const recordedToken = record.addresses?.HCOWToken;
  const recordedVesting = record.addresses?.HCOWVesting;

  if (!process.env.HCOW_ADDRESS && recordedToken) {
    throw new Error(
      `deployments/${chainIdNum}.json already names HCOWToken at ${recordedToken}, and HCOW_ADDRESS ` +
      'is not set. Deploying again mints a SECOND 200,000,000 supply and overwrites the pointer that ' +
      'seal.cjs, release.cjs, deploy-claim.cjs and set-root.cjs all read. The vesting deployed in ' +
      'this run would be bound to the new token while any HCOWClaim already deployed stays bound to ' +
      'the old one, and neither can ever be changed. Set HCOW_ADDRESS to the token you mean, or, if ' +
      'the recorded token really is to be abandoned, re-run with REPLACE_TOKEN=1.');
  }
  if (recordedVesting && process.env.REPLACE_VESTING !== '1') {
    throw new Error(
      `HCOWVesting is already recorded on chain ${chainIdNum} at ${recordedVesting}. Deploying again ` +
      'produces a second vesting contract that holds nothing, and overwrites the record that ' +
      'load.cjs, seal.cjs and release.cjs read. If the first one really is to be abandoned AND it ' +
      'has not been sealed, re-run with REPLACE_VESTING=1.');
  }

  // ---- token ------------------------------------------------------------
  let token = process.env.HCOW_ADDRESS ? ethers.getAddress(process.env.HCOW_ADDRESS) : null;
  let tokenTx = null;
  if (!token) {
    const t = await deploy('HCOWToken', signer, [treasury]);
    token = await t.getAddress();
    tokenTx = t.deploymentTransaction().hash;
    console.log(`HCOWToken     ${token}  tx ${tokenTx}`);
  } else {
    console.log(`HCOWToken     ${token}  (existing)`);
  }

  const tk = at('HCOWToken', token, provider);
  const [sym, dec, supply, held] = await Promise.all([
    tk.symbol(), tk.decimals(), tk.totalSupply(), tk.balanceOf(treasury),
  ]);
  console.log(`              ${sym}, ${dec} decimals, supply ${tok(supply)}, treasury holds ${tok(held)}`);
  if (Number(dec) !== 18) throw new Error(`token reports ${dec} decimals, the schedule is written in 18`);

  // 7차 감사 C-2. 이전 판은 심볼을 출력하고 아무것도 비교하지 않았다. name 이
  // "Tether USD" 이고 symbol 이 "USDT" 인 18자리 디코이가 그대로 통과해
  // HCOWVesting.token 이 그것에 영구 바인딩됐다 (재현함, exit 0). 4차 감사
  // C-4 가 deploy-claim.cjs 에 같은 검사를 넣었는데 이 형제는 고쳐지지 않았다.
  if (sym !== 'HCOW') {
    throw new Error(
      `the token at ${token} calls itself ${JSON.stringify(sym)}, not "HCOW". HCOWVesting.token is ` +
      'immutable, so a vesting contract bound to the wrong token can never release anything and its ' +
      'rescue path moves the wrong asset.');
  }
  if (mainnet && supply !== 200_000_000n * 10n ** 18n) {
    throw new Error(
      `the token at ${token} reports a total supply of ${tok(supply)}, not 200,000,000. HCOW has a ` +
      'fixed supply and no mint function, so this is not HCOW.');
  }
  // 레코드가 이미 아는 토큰과 HCOW_ADDRESS 가 다르면 이 스크립트는 고르지 않는다.
  if (recordedToken && recordedToken.toLowerCase() !== token.toLowerCase()) {
    throw new Error(
      `HCOW_ADDRESS is ${token} but deployments/${chainIdNum}.json already names HCOWToken as ` +
      `${recordedToken}. One of the two is wrong and this script will not pick. seal.cjs and ` +
      'release.cjs read that record as the authoritative token address.');
  }

  if (c.total > supply) throw new Error(`the table schedules ${tok(c.total)} but supply is ${tok(supply)}`);
  if (held < c.total) {
    throw new Error(
      `treasury ${treasury} holds ${tok(held)} HCOW but the table needs ${tok(c.total)}. ` +
      'fundAndSeal pulls from the owner, so the owner must hold it.');
  }

  // ---- vesting ----------------------------------------------------------
  // owner_ is the treasury. See the header.
  const v = await deploy('HCOWVesting', signer, [
    token, tge, treasury, rescue, c.count, c.total, c.unlock, c.hash,
  ]);
  const vesting = await v.getAddress();
  console.log(`HCOWVesting   ${vesting}  tx ${v.deploymentTransaction().hash}`);

  // Read the commitments back off the deployed contract rather than trusting
  // the arguments that were sent. A constructor argument encoded wrongly is
  // silent, and this is the last cheap moment to notice.
  const vc = at('HCOWVesting', vesting, provider);
  const [ob, os, ou, oh, oo, ot, oTok, oResc, oCap] = await Promise.all([
    vc.expectedBeneficiaries(), vc.expectedScheduled(), vc.expectedTgeUnlock(),
    vc.expectedScheduleHash(), vc.owner(), vc.tgeTime(),
    vc.token(), vc.rescueRecipient(), vc.supplyCap(),
  ]);
  const bad = readbackFaults(
    { oTok, oResc, oCap, ob, os, ou, oh, oo, ot },
    { token, rescue, supply, count: c.count, total: c.total, unlock: c.unlock, hash: c.hash, treasury, tge });
  if (bad.length) throw new Error('the deployed contract does not read back as deployed:\n  ' + bad.join('\n  '));
  console.log('              commitments, token, rescueRecipient and supplyCap all read back correctly\n');

  const prev = readRecord(Number(net.chainId)) || {};
  const rec = {
    ...prev,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployedBy: me,
    schedule: file,
    treasury,
    rescueRecipient: rescue,
    tgeTime: tge,
    commitments: {
      beneficiaries: String(c.count),
      scheduled: String(c.total),
      tgeUnlock: String(c.unlock),
      scheduleHash: c.hash,
    },
    // 3차 감사 A-6. 이전 판은 addresses 를 통째로 새로 만들어
    // 기존 HCOWAnchor 키를 지웠다. 그러면 deploy-anchor.cjs 의 REPLACE_ANCHOR
    // 가드가 "기존 배포 없음" 으로 보고 조용히 풀리고, anchor.cjs 의
    // record.addresses?.HCOWAnchor 폴백도 같이 깨진다. 병합한다.
    addresses: { ...(prev.addresses || {}), HCOWToken: token, HCOWVesting: vesting },
    // 7차 감사 M-6. 두 줄 위 addresses 는 3차 A-6 수정으로 병합하는데 이쪽은
    // 재구성이라 HCOWClaim·HCOWAnchor 의 배포 tx 해시가 조용히 사라졌다.
    deploymentTxs: {
      ...(prev.deploymentTxs || {}),
      ...(tokenTx ? { HCOWToken: tokenTx } : {}),
      HCOWVesting: v.deploymentTransaction().hash,
    },
    sealed: false,
  };
  const p = writeRecord(Number(net.chainId), rec);
  console.log(`written to ${p}`);

  console.log('\nNEXT, IN ORDER, BOTH SIGNED BY THE TREASURY:');
  console.log('  1. node scripts/load.cjs     loads the nine schedules');
  console.log('  2. node scripts/seal.cjs     verifies, then approves and calls fundAndSeal');
  console.log('\nNothing is live until step 2. addSchedule closes at TGE, so step 1 must');
  console.log('finish before then. seal() stays callable after TGE deliberately.');
}

module.exports = { readbackFaults };

if (require.main === module) {
  main().catch((e) => {
    console.error('\n' + (e.message || e));
    process.exitCode = 1;
  });
}
