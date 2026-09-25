'use strict';
// Deploys HCOWToken and HCOWVesting. Loads no schedules and seals nothing.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... \
//   TREASURY_ADDRESS=0x... RESCUE_RECIPIENT=0x... TGE_TIME=<unix seconds> \
//   SCHEDULE=schedule/testnet.json \
//   EXPECT_BENEFICIARIES=.. EXPECT_SCHEDULED=.. EXPECT_TGE_UNLOCK=.. EXPECT_HASH=0x.. \
//   node scripts/deploy.cjs
//
//   DRY_RUN=yes / PRINT_ONLY=yes    every check runs, nothing is deployed
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
const { connect, deploy, at, writeRecord, readRecord, suppressed, ethers } = require('./_connect.cjs');
const { commitments } = require('../vestcommit.cjs');
const { loadSchedule, tgeUnlockOf } = require('./commitcheck.cjs');

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
  // 8차 감사 H-1. 이 파일은 DRY_RUN 도 PRINT_ONLY 도 몰랐다. 재현 확인:
  // 두 이름 다 exit 0 으로 끝나면서 토큰과 베스팅이 실제로 배포됐다. 7차 조치로
  // 나머지 여섯 스크립트가 두 이름을 모두 이해하게 됐기 때문에, 한 곳에서 이름을
  // 배운 운영자가 저장소에서 가장 되돌릴 수 없는 스크립트에 그것을 타이핑하면
  // 리허설이라 믿으며 진짜 배포가 나간다. deploy-token.cjs 37행 주석이 이미
  // 이 결함을 적어두고 있었는데 격상되지 않았다.
  //
  // 억제 플래그이므로 알 수 없는 철자에는 throw 한다. 그리고 가장 먼저 읽는다:
  // 여기서 나는 throw 는 무엇이 보내지기 전에 나야 한다.
  const dryRun = suppressed();

  const { provider, signer, net, mainnet } = await connect();
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);

  console.log(`chain     ${net.chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB\n`);
  if (bal === 0n && !dryRun) throw new Error('deployer has no BNB');

  const treasury = addr('TREASURY_ADDRESS');
  const rescue = addr('RESCUE_RECIPIENT');

  // The deploy key publishes bytecode and then matters to nothing. If it is
  // also the treasury it holds the entire supply, and the whole argument for
  // using a throwaway key collapses.
  if (mainnet && treasury.toLowerCase() === me.toLowerCase()) {
    throw new Error('TREASURY_ADDRESS must not be the deploy key on mainnet.');
  }
  // rescueRecipient is immutable. The zero address is refused here; the two
  // values the constructor refuses (the token and the vesting's own address)
  // are refused further down, before anything is deployed.
  // (10차 감사 정정: 이전 주석은 베스팅 주소를 "아무도 예측할 수 없다" 고 했는데
  // CREATE 주소는 배포키와 nonce 로 정해진다. 그 주석 때문에 이 검사가 없었고,
  // 재현하니 rescue 를 예측 주소로 두면 토큰이 배포된 뒤 생성자가
  // InvalidRescueRecipient 로 거부해 고아 토큰이 남았다.)
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

  // ---- 스케줄 합계는 토큰을 배포하기 전에 검사한다 (8차 감사 H-3) ---------
  //
  // 이전 판은 `c.total > supply` 와 `held < c.total` 을 토큰 배포 **뒤** 에 뒀다.
  // 재현 확인: 합계를 200,000,001 로 만들고 돌리면 HCOWToken 이 실제로 배포되고
  // (symbol HCOW, supply 200,000,000, 바이트코드 8,168바이트) 그 다음 exit 1 이며
  // 레코드 파일은 쓰이지 않는다. 즉 거절된 실행이 체인에 BscScan 검증 가능한
  // 고아 토큰을 남기고, 어떤 파일도 그 존재를 모른다. 스케줄을 고쳐 다시 돌리면
  // 레코드가 없으므로 FIRST_DEPLOY=1 이 필요하고 세 번째 토큰이 배포된다.
  // 검증 가능성이 포지셔닝인 프로젝트에서 동일 바이트코드 HCOW 가 메인넷에 둘
  // 이상 서 있는 상태는 실질 비용이다. 이 파일 186행이 스스로 "이 검사들은 전부
  // 첫 배포 트랜잭션보다 앞에 있어야 한다" 고 적어두고 그것을 어기고 있었다.
  //
  // HCOWToken 은 생성자에서 고정량을 발행하고 공급량 인자가 없다. 그래서 이
  // 스크립트가 새로 배포할 토큰의 공급량은 배포 전에 이미 알려져 있고, 상수와
  // 대조할 수 있다. HCOW_ADDRESS 로 기존 토큰을 주는 경로에서는 그 토큰에서 읽은
  // 실제 공급량과 다시 대조한다 (아래).
  const CANONICAL_SUPPLY = 200_000_000n * E;
  if (c.total > CANONICAL_SUPPLY) {
    throw new Error(
      `the table schedules ${c.total} wei (${tok(c.total)} HCOW) but HCOWToken mints ` +
      `${CANONICAL_SUPPLY} wei (${tok(CANONICAL_SUPPLY)} HCOW) and has no mint function. ` +
      'HCOWVesting refuses a table larger than its supplyCap, so this deployment could never be ' +
      'sealed. Nothing has been deployed.');
  }
  // 9차 감사 A-8. 이전 문구는 tok() 로만 말했고 tok 은 정수 나눗셈이다. 이 가드가
  // 실제로 걸릴 가장 흔한 경우가 wei 단위 오차(CLAUDE.md: "1 wei 만 움직여도")라서,
  // 같은 숫자 두 개를 놓고 다르다고 주장하는 문구가 나왔다. wei 를 먼저 말한다.

  // 9차 감사 A-2. H-3 조치는 검사 하나만 앞으로 옮겼고, 토큰 배포와 베스팅 배포
  // 사이에는 여전히 revert 가능한 구간이 남아 있었다. 재현 확인: 201행 테이블은
  // 합계가 정확히 200,000,000 이라 위 검사를 통과하고, HCOWToken 이 실제로
  // 배포된 뒤 생성자가 CommitmentMismatch 로 revert 해서 레코드 없는 고아 토큰이
  // 남았다 (codeLen 8168, exit 1).
  //
  // 그래서 배포 전에 알 수 있는 생성자 거부 조건을 **전부** 여기서 본다.
  // HCOWVesting 생성자(contracts/HCOWVesting.sol:236-241)가 거부하는 다섯 가지
  // 중 rescueRecipient 를 뺀 넷은 모두 스케줄 파일만으로 계산된다.
  const MAX_BENEFICIARIES = 200n;
  const preflight = [];
  if (BigInt(c.count) === 0n) preflight.push('the table has no rows');
  if (BigInt(c.count) > MAX_BENEFICIARIES) {
    preflight.push(`the table has ${c.count} rows and MAX_BENEFICIARIES is ${MAX_BENEFICIARIES}`);
  }
  if (BigInt(c.total) === 0n) preflight.push('the table schedules 0 wei');
  if (BigInt(c.unlock) > BigInt(c.total)) {
    preflight.push(`the TGE unlock ${c.unlock} wei is larger than the scheduled total ${c.total} wei`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(c.hash)) || /^0x0{64}$/.test(String(c.hash))) {
    preflight.push(`the schedule hash is ${c.hash}`);
  }
  if (preflight.length) {
    throw new Error(
      'the HCOWVesting constructor would refuse these arguments:\n  ' + preflight.join('\n  ') +
      '\n\nEvery one of these is computable from the schedule file, so it is checked here rather ' +
      'than after HCOWToken has already been deployed. Nothing has been deployed.');
  }

  // 9차 감사 A-4. 위 검사는 `>` 만 봤다. CLAUDE.md 봉인 불변식은 등식이다:
  // "9개 스케줄의 합계 = totalSupply() = 200,000,000 정확히 일치". 재현 확인:
  // 0 하나가 빠진 20,000,000 테이블로 deploy → load → seal 전 단계가 exit 0 이고,
  // beneficiaryCount()==9 인 채로 공급량의 1/10 만 커밋된 상태로 되돌릴 수 없게
  // 봉인됐다. 테스트넷 스케줄은 합계가 작으므로 메인넷 한정이다.
  if (mainnet && BigInt(c.total) !== CANONICAL_SUPPLY) {
    throw new Error(
      `on mainnet the table must schedule exactly ${CANONICAL_SUPPLY} wei (200,000,000 HCOW). This ` +
      `one schedules ${c.total} wei. The sealing invariant is an equality, not a bound: a table that ` +
      'sums to less seals successfully and leaves the difference permanently uncommitted, with ' +
      'beneficiaryCount() still reading 9. Nothing has been deployed.');
  }
  if (mainnet && Number(c.count) !== 9) {
    throw new Error(
      `on mainnet the table must have exactly 9 rows; this one has ${c.count}. The published ` +
      'allocation is nine and CLAUDE.md forbids changing that number. Nothing has been deployed.');
  }
  // 12차 감사 M-2. 스케줄 파일의 meta 에 "합계는 이 값, TGE 언락 합계는 이 값" 이
  // 적혀 있는데(mainnet.json · testnet.json · mainnet.template.json) 어떤 스크립트도
  // 그 두 값을 읽지 않았다 — 확인한다고 적어 두고 확인하지 않는 검사(백로그 C-2).
  // EXPECT_* 는 같은 파일에서 commitcheck 로 뽑으므로 행 조건이 바뀌면 함께 바뀐다.
  // 재현: claim 주소를 넣으면서 Airdrop 행을 tgeBps 0 · 12개월 클리프로 바꿔도
  // exit 0 이었고, 온체인 expectedTgeUnlock 이 24,000,000 으로 봉인 가능한 상태가
  // 됐다 (공표값 27,000,000, 공개 약속 "시즌 1 HCOW 는 TGE 시점 지급"). 값은 하드코딩이
  // 아니라 파일의 데이터다. 메인넷에서는 두 값이 반드시 있어야 한다.
  if (mainnet) {
    const want = [['totalsMustEqual', c.total, 'the scheduled total'],
                  ['tgeUnlockMustEqual', c.unlock, 'the TGE unlock']];
    const off = [];
    for (const [k, got, what] of want) {
      const v = meta[k];
      if (v === undefined || v === null || !/^\d+$/.test(String(v).trim())) {
        off.push(`meta.${k} is ${JSON.stringify(v)}; on mainnet it must be the published figure in wei`);
      } else if (BigInt(String(v).trim()) !== BigInt(got)) {
        off.push(`${what} is ${got} wei (${tok(BigInt(got))} HCOW) but meta.${k} is ${String(v).trim()} wei ` +
                 `(${tok(BigInt(String(v).trim()))} HCOW)`);
      }
    }
    if (off.length) {
      throw new Error(
        `${file} does not match its own published figures:\n  ${off.join('\n  ')}\n\nA row's terms ` +
        'changed while its figures did not. The Airdrop row decides what the claim contract has at TGE, ' +
        'which is what round 0 pays. Nothing has been deployed.');
    }
  }

  // A-6 (13차 L5). 위 검사는 표 전체의 합계 두 개만 본다. 두 행을 서로 상쇄되게
  // 고치면 통과한다. 재현: Airdrop TGE 3750→0 과 Public TGE 1500→2000 을 같이 바꾸면
  // 합계 200,000,000 · TGE 언락 27,000,000 이 그대로라 exit 0 이었다. 그러면 claim 은
  // TGE 에 아무것도 받지 못하고 시즌 1 "TGE 시점 지급" 약속의 재원이 사라진다.
  // 그래서 공표된 배정표의 행마다 수량 · TGE 언락 · 클리프 · 선형 개월을 파일의 데이터로
  // 적어 두고(meta.rowsMustEqual, 표 순서대로) 행 단위로 대조한다. 값은 하드코딩이 아니라
  // 파일의 데이터다. 메인넷에서는 반드시 있어야 한다.
  if (mainnet) {
    const pub = meta.rowsMustEqual;
    const off = [];
    if (!Array.isArray(pub) || pub.length !== rows.length) {
      off.push(`meta.rowsMustEqual has ${Array.isArray(pub) ? `${pub.length} entries` : JSON.stringify(pub)}; ` +
               `on mainnet it must list the ${rows.length} published rows in table order`);
    } else {
      for (const [i, r] of rows.entries()) {
        const p = pub[i] || {};
        const where = `row ${i} (${r.label ?? 'no label'})`;
        if (String(p.label ?? '') !== String(r.label ?? '')) {
          off.push(`${where}: the published row ${i} is ${JSON.stringify(p.label)}`);
          continue;
        }
        const total = BigInt(r.total);
        const want = [
          ['total', total],
          ['tgeUnlock', tgeUnlockOf(total, r.tgeBps, r.cliffMonths, r.linearMonths)],
          ['cliffMonths', BigInt(r.cliffMonths)],
          ['linearMonths', BigInt(r.linearMonths)],
        ];
        for (const [k, got] of want) {
          const v = p[k];
          if (v === undefined || v === null || !/^\d+$/.test(String(v).trim())) {
            off.push(`${where}: meta.rowsMustEqual[${i}].${k} is ${JSON.stringify(v)}; it must be the published figure`);
          } else if (BigInt(String(v).trim()) !== got) {
            off.push(`${where}: ${k} is ${got} but the published figure is ${String(v).trim()}`);
          }
        }
      }
    }
    if (off.length) {
      throw new Error(
        `${file} does not match its own published rows:\n  ${off.join('\n  ')}\n\nThe table's totals can ` +
        'still add up when two rows are changed against each other, so each row is checked on its own. ' +
        'Nothing has been deployed.');
    }
  }

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
  // 10차 감사. 레코드 검증은 이제 _connect.cjs 의 readRecord 한 곳에 있고 모든
  // 스크립트가 그것을 쓴다. 파일이 없으면 null, 있는데 틀리면 던진다. 8·9차에
  // 이 자리에 있던 usable() 은 두 방향으로 틀렸다: 8차는 {} 를 받아들였고,
  // 9차는 키 하나가 null 인 레코드를 "names no deployment at all" 이라고 거짓으로
  // 불러 운영자를 FIRST_DEPLOY=1 로 안내했다. 그 플래그는 레코드를 {} 로 취급해
  // 봉인 검사까지 껐다. 재현: 봉인된 200,000,000 베스팅이 레코드에서 사라지고
  // 두 번째 토큰이 발행됐다.
  const priorRecord = readRecord(chainIdNum);
  // FIRST_DEPLOY 는 파일이 **없을 때만** 의미가 있다. 파일이 있는데 틀린 경우는
  // readRecord 가 이미 던졌다.
  if (priorRecord === null && process.env.FIRST_DEPLOY !== '1' && !dryRun) {
    throw new Error(
      `deployments/${chainIdNum}.json does not exist. That is what a first deploy looks like, and it ` +
      'is also what a wiped or moved record looks like after something was already deployed here. ' +
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
      'the old one, and neither can ever be changed. Set HCOW_ADDRESS to the token you mean.\n\n' +
      // 8차 감사 M-1. 이전 문구는 "re-run with REPLACE_TOKEN=1" 이라고 안내했는데
      // 그 이름은 저장소 어디에서도 읽히지 않았다 (grep: 이 문자열 안에만 있었다).
      // 재현 확인: 정확한 철자 REPLACE_TOKEN=1 도 같은 문구로 거부됐다. 7차에 넣은
      // 테스트는 오타 다섯 가지만 돌려 전부 거부되는 것을 확인했고, 정확한 철자를
      // 한 번도 시도하지 않았다 (백로그 C-11). 존재하지 않는 탈출구를 안내하는 것과
      // 그 탈출구를 만드는 것 둘 중에서, 공개 약속("운영자가 배포 대상을 임의로
      // 바꿀 수 있는 경로를 만들지 않는다")에 맞는 쪽은 안내를 지우는 것이다.
      'There is deliberately no flag that skips this. Abandoning a recorded token is not an ' +
      'operation this script performs: HCOWVesting and HCOWClaim bind to the token address ' +
      'immutably, so a replacement strands whichever of them already exists. If the recorded token ' +
      'really is to be abandoned, move deployments/' + chainIdNum + '.json aside by hand, ' +
      'deliberately, knowing that any HCOWClaim already deployed can never follow.');
  }
  // 12차 감사 M-1 의 형제. 이 스크립트가 토큰을 새로 배포하는 경로(테스트넷 한정)도
  // "파일이 있는가" 만 보고 있었다. deploy-anchor.cjs 가 쓴 앵커만 적힌 파일이면
  // FIRST_DEPLOY 없이 토큰을 발행했다. deploy-token.cjs · deploy-claim.cjs 와 같은
  // 규칙: 파일이 토큰을 부르지 않으면 새 토큰은 FIRST_DEPLOY=1 을 요구한다.
  if (!process.env.HCOW_ADDRESS && !recordedToken && priorRecord !== null &&
      process.env.FIRST_DEPLOY !== '1' && !dryRun) {
    throw new Error(
      `deployments/${chainIdNum}.json exists but names no HCOWToken, and HCOW_ADDRESS is not set, so ` +
      'this run would deploy a new token. A record without a token is also what a wiped file looks ' +
      'like after deploy-anchor.cjs wrote a fresh one. If this really is the first token on this ' +
      'chain, re-run with FIRST_DEPLOY=1. If not, set HCOW_ADDRESS or restore the record.');
  }
  // 10차 감사. 메인넷에서 이 스크립트는 토큰을 배포하지 않는다. 정해진 순서는
  // deploy-token.cjs → deploy-claim.cjs → 이 스크립트(HCOW_ADDRESS)이고, 그 순서
  // 에서 새 토큰 경로는 쓰일 일이 없다. 그 경로는 한 실행 안에서 토큰과 베스팅을
  // 연달아 배포하므로 그 사이의 어떤 실패도 레코드 없는 고아 토큰을 남긴다.
  // 재현한 것만 셋이다: 배포키 잔액이 토큰 한 건 몫뿐일 때, 벽시계와
  // block.timestamp 가 어긋나 생성자가 TgeTooFar 로 거부할 때, rescueRecipient 가
  // 이번 실행이 배포할(예측 가능한) 주소일 때. 사전 검사로 하나씩 막는 대신
  // 메인넷에서 그 경로 자체를 닫는다. 테스트넷에서는 리허설 편의로 남긴다.
  if (mainnet) {
    // 11차 감사: 이 스크립트는 TREASURY_ADDRESS 를 레코드의 treasury 와 대조하지
    // 않고 덮어썼다. deploy-token.cjs 는 그 주소가 EOA 인지(7702 포함) 검사하고
    // 기록했으므로, 같은 주소여야 그 검사가 이 베스팅의 owner 에도 적용된다.
    if (record.treasury && record.treasury.toLowerCase() !== treasury.toLowerCase()) {
      throw new Error(
        `TREASURY_ADDRESS is ${treasury} but deployments/${chainIdNum}.json records the treasury as ` +
        `${record.treasury} — the address deploy-token.cjs minted the supply to and checked. The ` +
        'vesting owner must be that address or fundAndSeal has nothing to pull. Nothing has been deployed.');
    }
    if (!process.env.HCOW_ADDRESS) {
      throw new Error(
        'on mainnet HCOW_ADDRESS is required. This script does not deploy HCOWToken on mainnet: the ' +
        'deployment order is deploy-token.cjs, then deploy-claim.cjs, then this script with ' +
        'HCOW_ADDRESS set to the token deploy-token.cjs recorded. Deploying the token and the ' +
        'vesting in one run leaves an orphan token behind if anything fails between the two.');
    }
    if (!recordedToken) {
      throw new Error(
        `on mainnet deployments/${chainIdNum}.json must already name the HCOWToken that ` +
        'deploy-token.cjs deployed. It does not, so nothing shows HCOW_ADDRESS is that token.');
    }
  }
  if (recordedVesting && process.env.REPLACE_VESTING !== '1') {
    throw new Error(
      `HCOWVesting is already recorded on chain ${chainIdNum} at ${recordedVesting}. Deploying again ` +
      'produces a second vesting contract that holds nothing, and overwrites the record that ' +
      'load.cjs, seal.cjs and release.cjs read. If the first one really is to be abandoned AND it ' +
      'has not been sealed, re-run with REPLACE_VESTING=1.');
  }
  // 9차 감사 A-5. 바로 위 문구가 "AND it has not been sealed" 라고 조건을 걸면서
  // 봉인 여부를 읽는 코드가 없었다. 재현 확인: sealed:true 인 레코드에
  // REPLACE_VESTING=1 로 돌리면 exit 0 으로 새 베스팅을 기록하고 sealed 를 false 로
  // 덮어써서, 200,000,000 을 들고 봉인된 컨트랙트가 어떤 파일에도 남지 않았다.
  // (레코드의 sealed 플래그는 아무도 읽지 않으므로 체인에서 직접 읽는다.)
  //
  // 봉인된 베스팅은 되돌릴 수 없고 전량을 들고 있다. 그것을 레코드에서 지우는
  // 것은 플래그로 허용할 만한 동작이 아니므로, REPLACE_VESTING 이 있어도 거절한다.
  if (recordedVesting && ethers.isAddress(recordedVesting)) {
    const code = await provider.getCode(recordedVesting);
    if (code === '0x') {
      if (mainnet) {
        throw new Error(
          `deployments/${chainIdNum}.json names HCOWVesting at ${recordedVesting} but there is no ` +
          'contract there. On mainnet that record is wrong, and this script will not replace a ' +
          'contract it cannot see.');
      }
      console.log(`WARNING   deployments/${chainIdNum}.json names HCOWVesting at ${recordedVesting} ` +
                  'but there is no contract there. Treating it as not sealed.');
    } else {
      // 11차 감사: 10차가 자금 검사 블록을 옮기면서 이 else 를 빈 블록으로 닫아
      // 버렸다. 그래서 코드 없는 주소에도 sealed_() 를 읽었고, 바로 위의 "no
      // contract there" 경고 직후에 "there is code at that address" 라는 모순된
      // 문구로 멈췄다 (테스트넷 한정, fail-closed). 괄호를 바로잡는다.
      let wasSealed = null;
      try {
        wasSealed = await at('HCOWVesting', recordedVesting, provider).sealed_();
      } catch (e) {
        throw new Error(
          `deployments/${chainIdNum}.json names HCOWVesting at ${recordedVesting}, there is code at ` +
          `that address, but sealed_() could not be read from it (${e.shortMessage || e.message}). ` +
          'This script will not deploy over something it cannot identify.');
      }
      if (wasSealed) {
        throw new Error(
          `the HCOWVesting recorded on chain ${chainIdNum} at ${recordedVesting} IS SEALED. It holds ` +
          'the whole allocation, its table is frozen, and nothing about it can be undone. Replacing ' +
          'the record would leave it unnamed by any file while load.cjs, seal.cjs and release.cjs ' +
          'went on reading the new one. There is no flag for this, including REPLACE_VESTING.');
      }
      // 10차 감사. 자금이 들어갔지만 봉인되지 않은 베스팅도 버릴 수 없다.
      // release() 는 봉인을 요구하고 rescueForeignToken 은 베스팅 토큰을 거부하므로,
      // 그 안의 HCOW 는 그 컨트랙트가 봉인되지 않는 한 영원히 묶인다. 9차까지 이
      // 경우를 막은 것은 "treasury holds 0 HCOW but the table needs ..." 라는 엉뚱한
      // 문구의 잔고 검사 하나였고, 그 줄에는 "메인넷에서 도달 불가" 라는 틀린
      // 주석이 달려 있었다. 이제 원인을 이름으로 부른다.
      const vTokenAddr = await at('HCOWVesting', recordedVesting, provider).token().catch(() => null);
      if (vTokenAddr) {
        const inside = await at('HCOWToken', vTokenAddr, provider).balanceOf(recordedVesting).catch(() => 0n);
        if (inside > 0n) {
          throw new Error(
            `the HCOWVesting recorded at ${recordedVesting} already holds ${inside} wei of HCOW. An ` +
            'unsealed vesting cannot release and cannot rescue its own token, so abandoning it strands ' +
            'that balance permanently. Seal it or leave it; there is no flag for replacing it, ' +
            'including REPLACE_VESTING.');
        }
      }
    }
  }

  // ---- rescueRecipient vs the addresses this run will create ---------------
  // 10차 감사. HCOWVesting 생성자는 rescueRecipient 가 토큰이거나 자기 자신이면
  // 거부한다. 둘 다 배포 전에 계산된다: 토큰은 HCOW_ADDRESS 이거나 다음 nonce 의
  // CREATE 주소이고, 베스팅은 그 다음 nonce 의 CREATE 주소다.
  {
    const n0 = await provider.getTransactionCount(me, 'pending');
    const willDeployToken = !process.env.HCOW_ADDRESS;
    const tokenAt = willDeployToken
      ? ethers.getCreateAddress({ from: me, nonce: n0 })
      : ethers.getAddress(process.env.HCOW_ADDRESS);
    const vestingAt = ethers.getCreateAddress({ from: me, nonce: willDeployToken ? n0 + 1 : n0 });
    const r = rescue.toLowerCase();
    if (r === tokenAt.toLowerCase() || r === vestingAt.toLowerCase()) {
      throw new Error(
        `RESCUE_RECIPIENT ${rescue} is the address ${r === tokenAt.toLowerCase() ? 'of the token' : 'the vesting contract will be deployed at'}. ` +
        'The HCOWVesting constructor refuses it (InvalidRescueRecipient), and on the new-token path ' +
        'that refusal would come after the token was already deployed. Nothing has been deployed.');
    }
  }

  // ---- token ------------------------------------------------------------
  let token = process.env.HCOW_ADDRESS ? ethers.getAddress(process.env.HCOW_ADDRESS) : null;
  let tokenTx = null;
  if (token) {
    console.log(`HCOWToken     ${token}  (existing)`);
  } else if (dryRun) {
    // 드라이런에서는 배포하지 않는다. 아래의 토큰 신원 검사들은 읽을 대상이
    // 없으므로 돌 수 없고, 그 사실을 배너에서 명시한다. 배포되는 토큰은 이
    // 스크립트가 만드는 것이라 신원을 의심할 이유도 없다.
    console.log('HCOWToken     (would be deployed in this run)');
  } else {
    const t = await deploy('HCOWToken', signer, [treasury]);
    token = await t.getAddress();
    tokenTx = t.deploymentTransaction().hash;
    console.log(`HCOWToken     ${token}  tx ${tokenTx}`);
  }

  let supply = CANONICAL_SUPPLY;
  if (token) {
    const tk = at('HCOWToken', token, provider);
    const [sym, dec, sup, held] = await Promise.all([
      tk.symbol(), tk.decimals(), tk.totalSupply(), tk.balanceOf(treasury),
    ]);
    supply = sup;
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
    if (mainnet && supply !== CANONICAL_SUPPLY) {   // 9차 A-10: 상수를 두 번 쓰지 않는다
      throw new Error(
        `the token at ${token} reports a total supply of ${supply} wei (${tok(supply)} HCOW), not ${CANONICAL_SUPPLY}. HCOW has a ` +
        'fixed supply and no mint function, so this is not HCOW.');
    }
    // 레코드가 이미 아는 토큰과 HCOW_ADDRESS 가 다르면 이 스크립트는 고르지 않는다.
    if (recordedToken && recordedToken.toLowerCase() !== token.toLowerCase()) {
      throw new Error(
        `HCOW_ADDRESS is ${token} but deployments/${chainIdNum}.json already names HCOWToken as ` +
        `${recordedToken}. One of the two is wrong and this script will not pick. seal.cjs and ` +
        'release.cjs read that record as the authoritative token address.');
    }

    // 10차 감사. addSchedule 은 토큰 자신을 수혜자로 거부한다(BadBeneficiary).
    // 토큰 주소를 아는 것은 이 시점이므로 여기서 본다. 적재 단계에서 걸리면 이미
    // 커밋먼트가 박힌 뒤다.
    const tokenRow = rows.find((r) => String(r.beneficiary).toLowerCase() === token.toLowerCase());
    if (tokenRow) {
      throw new Error(
        `row ${JSON.stringify(tokenRow.label || tokenRow.beneficiary)} names the token itself as a ` +
        'beneficiary. addSchedule reverts BadBeneficiary on it, after this script has already fixed ' +
        'the commitments immutably. Nothing has been deployed.');
    }

    // 10차 감사. 레코드에 HCOWClaim 이 있으면 그것이 이 베스팅의 수혜자가 되는
    // 것이 정해진 순서의 요점이다. 세 가지를 체인에 대고 확인한다.
    const recordedClaim = record.addresses?.HCOWClaim;
    // 11차 감사. 메인넷에서 이 스크립트는 HCOWClaim 이 기록돼 있지 않아도 진행했다.
    // 2단계(deploy-claim.cjs)를 빠뜨리면 Airdrop 행이 claim 이 아닌 주소인 채로
    // 커밋먼트가 immutable 로 박히고, 그 뒤 deploy-claim.cjs 는 베스팅이 있다는
    // 이유로(10차) 플래그로도 풀 수 없게 막힌다. 재현함. 정해진 순서는 claim 이
    // 먼저이므로 메인넷에서는 그것을 요구한다.
    if (mainnet && !recordedClaim) {
      throw new Error(
        `on mainnet deployments/${chainIdNum}.json must already name the HCOWClaim that ` +
        'deploy-claim.cjs deployed. The Community / Airdrop row has to pay that contract, and the ' +
        'beneficiary set this script is about to commit can never change. Run deploy-claim.cjs first.');
    }
    if (recordedClaim) {
      const claimCode = await provider.getCode(recordedClaim);
      if (claimCode === '0x') {
        if (mainnet) {
          throw new Error(
            `deployments/${chainIdNum}.json names HCOWClaim at ${recordedClaim} but there is no ` +
            'contract there. On mainnet this record is wrong; fix it before fixing commitments.');
        }
        console.log(`WARNING   recorded HCOWClaim ${recordedClaim} has no code on this chain`);
      } else {
        const cl = at('HCOWClaim', recordedClaim, provider);
        const [clToken, clDeadline, clNotice, clWindow] = await Promise.all(
          [cl.token(), cl.claimDeadline(), cl.minRoundNotice(), cl.minClaimWindow()]);
        // (1) 그 claim 이 이 토큰에 묶여 있다
        if (clToken.toLowerCase() !== token.toLowerCase()) {
          throw new Error(
            `the recorded HCOWClaim ${recordedClaim} is bound to token ${clToken}, not ${token}. A ` +
            'vesting deployed against this token can never fund it. Nothing has been deployed.');
        }
        // (2) 메인넷: 테이블이 그 claim 을 수혜자로 가진다. 없으면 커뮤니티/에어드롭
        //     물량은 영원히 그 claim 에 가지 않는다.
        // 11차 감사: 이전 판은 claim 이 **어느** 행에든 있으면 통과했다. 재현:
        // Airdrop 행과 Team 행의 수혜자를 맞바꿔도 exit 0 이었다. 그러면 Team Safe
        // 가 TGE 에 Airdrop 조건(TGE 언락)으로 받고 claim 은 12개월 클리프에 묶인다.
        // 봉인 뒤에는 되돌릴 수 없다. 이제 claim 은 라벨이 Airdrop 인 행에만,
        // 정확히 한 번 있어야 한다. 행을 찾는 근거는 스케줄 파일의 라벨이다.
        if (mainnet) {
          const isClaim = (r) => String(r.beneficiary).toLowerCase() === recordedClaim.toLowerCase();
          const airdropRows = rows.filter((r) => /airdrop/i.test(String(r.label || '')));
          const claimRows = rows.filter(isClaim);
          if (claimRows.length === 0) {
            throw new Error(
              `the table has no row paying the recorded HCOWClaim ${recordedClaim}. The Community / ` +
              'Airdrop row must name it: the beneficiary set is fixed by the commitments this script is ' +
              'about to make immutable. Nothing has been deployed.');
          }
          if (airdropRows.length !== 1) {
            throw new Error(
              `the table has ${airdropRows.length} rows labelled as Airdrop; exactly one is needed so this ` +
              'script can check that the claim contract is paid on that row\'s terms. Nothing has been deployed.');
          }
          if (claimRows.length !== 1 || !isClaim(airdropRows[0])) {
            throw new Error(
              `the recorded HCOWClaim ${recordedClaim} is the beneficiary of ` +
              `${claimRows.map((r) => JSON.stringify(r.label || r.beneficiary)).join(', ')}, not of the ` +
              `${JSON.stringify(airdropRows[0].label)} row. Whoever holds the Airdrop row would receive the ` +
              'airdrop terms and the claim contract would receive another row\'s, forever once sealed. ' +
              'Nothing has been deployed.');
          }
        }
        // (3) 메인넷: claimDeadline 이 이 베스팅의 TGE 로부터 12개월 이상이다.
        //     deploy-claim.cjs 가 같은 검사를 하지만, 그때 쓴 TGE 는 레코드에 남지
        //     않았고 이 스크립트의 TGE_TIME 과 대조된 적이 없었다. 재현: claim 을
        //     TGE+30일 기준으로 배포하고 여기서 TGE+300일로 배포하니 실제 기한이
        //     TGE 후 3.2개월이 됐다. 이제 체인의 claimDeadline 을 이 TGE 에 대고 잰다.
        const months = (Number(clDeadline) - tge) / (30 * DAY);
        console.log(`claim     ${recordedClaim}  bound to this token; deadline ${months.toFixed(1)} thirty-day months after this TGE`);
        if (mainnet && months < 12) {
          throw new Error(
            `the recorded HCOWClaim's claimDeadline is ${months.toFixed(1)} thirty-day months after ` +
            `TGE_TIME ${tge}. deploy-claim.cjs requires 12 and was run against a different TGE. Either ` +
            'TGE_TIME is wrong here, or extendDeadline the claim contract first. Nothing has been deployed.');
        }
        // 11차 감사: (4) 0번 라운드를 TGE 에 열 수 있는가. 그 claim 의 notice 는
        // immutable 이고, 라운드는 notice 만큼 먼저 등록돼야 한다. 이 TGE 로는 그
        // 시간이 남지 않으면 이 베스팅을 배포해도 TGE 지급을 약속대로 할 수 없다.
        const nowWall = Math.floor(Date.now() / 1000);
        const needAhead = Math.max(DAY, Number(clNotice)) + DAY;
        if (mainnet && tge - nowWall < needAhead) {
          throw new Error(
            `TGE is ${((tge - nowWall) / 3600).toFixed(1)} hours away but the recorded HCOWClaim's ` +
            `minRoundNotice is ${(Number(clNotice) / 3600).toFixed(1)} hours. Round 0 pays at TGE and must be ` +
            `registered that long before it, with set-root.cjs's margin on top: TGE has to be at least ` +
            `${(needAhead / 3600).toFixed(1)} hours out. Nothing has been deployed.`);
        }
        // 12차 감사 M-2 · L-3. (5) 이 claim 의 행이 다 풀린 뒤에도 라운드를 하나 더
        //     열 수 있는가. 라운드는 기한보다 minClaimWindow 만큼 먼저 열려야 한다
        //     (setRoot 가 거부한다). 행의 마지막 언락이 그보다 늦으면 그 몫은 어떤
        //     라운드로도 나가지 못하고 기한 뒤 sweep() 대상이 된다. extendDeadline 로
        //     고칠 수는 있지만 봉인 전에 알 수 있는 것을 봉인 뒤로 미룰 이유가 없다.
        //     L-3(TGE 가 기한 − 창보다 늦음)도 같은 부등식의 특수한 경우다.
        if (mainnet) {
          const row = rows.find((r) => String(r.beneficiary).toLowerCase() === recordedClaim.toLowerCase());
          const vestEnd = tge + (Number(row.cliffMonths) + Number(row.linearMonths)) * 30 * DAY;
          const lastStart = Number(clDeadline) - Number(clWindow);
          if (vestEnd > lastStart) {
            throw new Error(
              `the claim contract's row finishes vesting at ${new Date(vestEnd * 1000).toISOString()}, but the ` +
              `last round it can ever open must start by ${new Date(lastStart * 1000).toISOString()} ` +
              `(claimDeadline − minClaimWindow). Whatever vests after that can never be paid by a round ` +
              'and goes to sweep() after the deadline. extendDeadline the claim contract first, or fix ' +
              'TGE_TIME. Nothing has been deployed.');
          }
        }
      }
    }

    // 이 줄은 메인넷에서 도달 불가하다: 위의 사전 검사가 c.total <= CANONICAL_SUPPLY
    // 를, 바로 앞 줄이 메인넷에서 supply == CANONICAL_SUPPLY 를 보장한다. 테스트넷의
    // 비정상 공급량 토큰에서만 살아 있다 (백로그 C-7).
    if (c.total > supply) {
      throw new Error(`the table schedules ${c.total} wei (${tok(c.total)} HCOW) but supply is ${supply} wei (${tok(supply)} HCOW)`);
    }
    // 10차 감사 정정. 9차가 이 검사에 "메인넷에서 도달 불가" 라는 주석을 달았는데
    // 틀렸다. HCOW_ADDRESS 경로(메인넷의 유일한 경로)에서 트레저리가 1 wei 라도
    // 옮겼으면 여기서 걸린다 — 재현함. 그리고 그 경우 fundAndSeal 이 모자란 몫을
    // 당길 수 없으므로 봉인이 불가능하다. 이 주석을 믿고 "죽은 코드" 로 지웠으면
    // 봉인 불가 베스팅이 배포됐을 것이다. 살아 있는 가드다.
    if (held < c.total) {
      throw new Error(
        `treasury ${treasury} holds ${held} wei (${tok(held)} HCOW) but the table needs ${c.total} wei ` +
        `(${tok(c.total)} HCOW). fundAndSeal pulls from the owner, so the owner must hold it.`);
    }
  }

  // ---- dry run ----------------------------------------------------------
  if (dryRun) {
    // 9차 감사 A-6. 이전 배너는 "돌 수 있는 모든 검사가 통과했다" 고 말했는데
    // 드라이런은 잔액 검사와 레코드 가드를 건너뛴다. 8차 M-7 에서
    // deploy-claim.cjs 에 고친 것과 같은 형태의 거짓 배너였다. 두 면제는
    // 의도된 것이다 — 드라이런은 일회용 배포키에 BNB 를 넣기 전에, 그리고 첫
    // 배포를 리허설할 때도 돌아야 한다 — 그래서 없애지 않고 밝힌다.
    const skipped = [];
    if (bal === 0n) skipped.push('the deployer has no BNB (checked only on the live run)');
    if (priorRecord === null) {
      skipped.push(
        `deployments/${chainIdNum}.json does not exist, which the LIVE run ` +
        'refuses unless FIRST_DEPLOY=1. If something is already deployed on this chain, restore ' +
        'the record before the live run rather than setting that flag.');
    }
    console.log('\nDRY RUN. Nothing was sent and nothing was written. These are the HCOWVesting');
    console.log('constructor arguments that would be used:');
    console.log(`  token      ${token || '(the HCOWToken this run would deploy)'}`);
    console.log(`  tgeTime    ${tge}  (${new Date(tge * 1000).toISOString()})`);
    console.log(`  owner      ${treasury}`);
    console.log(`  rescue     ${rescue}`);
    console.log(`  count      ${c.count}`);
    console.log(`  scheduled  ${c.total}`);
    console.log(`  tgeUnlock  ${c.unlock}`);
    console.log(`  hash       ${c.hash}`);
    if (!token) {
      console.log('\nHCOW_ADDRESS was not set, so the token identity checks (symbol, supply,');
      console.log('treasury balance, record match) had nothing to read and did NOT run. Re-run the');
      console.log('dry run with HCOW_ADDRESS set to exercise them.');
    }
    if (skipped.length) {
      console.log('\nCHECKS THIS DRY RUN DID NOT MAKE:');
      for (const w of skipped) console.log('  - ' + w);
    }
    console.log('\nRe-run without DRY_RUN / PRINT_ONLY to deploy.');
    return;
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
  // 8차 감사 L-1. 이전 문구는 supplyCap 도 "read back correctly" 라고 말했는데,
  // HCOWVesting 생성자는 supplyCap 을 IERC20(token_).totalSupply() 로 스스로
  // 만들고 이 스크립트는 같은 토큰에서 읽은 값과 비교한다. 두 값의 출처가 같아서
  // 절대 틀릴 수 없는 항등식이다 (readbackFaults 는 데코이 값을 먹이는 단위
  // 테스트로 검증되므로 함수 자체는 테스트된다. 거짓이었던 것은 이 문장이다).
  console.log('              commitments, token and rescueRecipient read back correctly');
  console.log('              supplyCap matches the token it was derived from (identity, not a check)\n');

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
