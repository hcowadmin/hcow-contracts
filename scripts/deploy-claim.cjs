'use strict';
// Deploys HCOWClaim. Registers no round and holds no tokens when it finishes.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... \
//   HCOW_ADDRESS=0x... CLAIM_OWNER=0x<treasury Safe> CLAIM_DEADLINE=<unix seconds> \
//   TGE_TIME=<unix seconds> CLAIM_NOTICE_SECONDS=259200 CLAIM_WINDOW_SECONDS=7776000 \
//   node scripts/deploy-claim.cjs
//
//   DRY_RUN=yes   runs every check below and deploys nothing.
//   PRINT_ONLY=yes  is accepted as the same thing, because the rest of this
//   repository uses that name and the fourth adversarial audit (2026-09-18,
//   C-1) found that this script silently ignored both and deployed for real.
//   Do a dry run first. The deploy is not reversible.
//
// WHY THIS RUNS BEFORE seal(), AND WHY IT CHECKS
//
// The Community/Airdrop schedule's beneficiary is this contract's address, and
// HCOWVesting fixes every beneficiary at seal() forever. So the order is deploy
// here, point the schedule at what this prints, then seal. If the vesting
// contract is already sealed, the address it was sealed with is the only
// address that will ever receive that bucket and a claim contract deployed now
// can never be funded by it. This script reads sealed_() and refuses in that
// case, because the alternative is a contract that looks right, verifies on
// BscScan, and silently never receives a token.
//
// WHAT IT CANNOT CHECK
//
// Whether CLAIM_OWNER is really the treasury Safe, and whether CLAIM_DEADLINE
// is the agreed length. Both are open in spec section 10 and both are
// one-way: ownership transfers need the new owner to accept, and the deadline
// extends but never shortens.

const { connect, deploy, at, writeRecord, readRecord, dryFlag, ethers, suppressed, isEoaCode } = require('./_connect.cjs');

const DAY = 24 * 60 * 60;
const E = 10n ** 18n;

const addr = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set`);
  if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);
  return ethers.getAddress(v);
};

async function main() {
  // 9차 감사 B-F3. 8차 L-3 은 _connect.cjs 의 suppressed() 만 고쳤고 이 줄은
  // 단축평가 판을 그대로 들고 있었다. DRY_RUN=yes PRINT_ONLY=mabye 가
  // deploy.cjs 에서는 멈추고 여기서는 조용히 진행했다.
  const dryRun = suppressed();

  const { provider, signer, net, mainnet } = await connect();
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);
  const chainId = Number(net.chainId);

  // 10차 감사: "Every check below runs" 는 거짓이었다. 드라이런은 잔액 검사와
  // 레코드 부재 가드를 건너뛴다. 건너뛴 것은 마지막에 이름으로 출력한다.
  console.log(dryRun
    ? '\n*** DRY RUN. Nothing is deployed and nothing is written. Checks skipped in a dry run are listed at the end. ***\n'
    : '\n*** LIVE. This deploys a contract. Run with DRY_RUN=yes first if you have not. ***\n');
  console.log(`chain     ${chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : '  (TESTNET)'}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB\n`);
  // 9차 감사 B-F1. 형제 셋(deploy.cjs · deploy-token.cjs · deploy-anchor.cjs)은
  // 모두 드라이런을 면제하는데 이 파일만 빠져 있었다. deploy-token.cjs 헤더가
  // 직접 "DRY_RUN=yes first" 를 지시하므로, 그 리허설을 하려고 일회용 배포키에
  // 먼저 BNB 를 넣어야 했고 배너는 "Every check below runs" 를 찍은 직후
  // 첫 검사에서 멈췄다. immutable 인자들을 자금 이동 전에 검증할 유일한 경로다.
  if (bal === 0n && !dryRun) throw new Error('deployer has no BNB');

  const priorRecord = readRecord(chainId);
  const record = priorRecord || {};

  // ---- has this already been deployed? ----------------------------------
  //
  // deploy-anchor.cjs has this guard and this script did not, so a second run
  // deployed a second contract, overwrote the record, and left the FIRST
  // address recorded nowhere. If the schedule was already pointed at the
  // first one, set-root.cjs then reads the record and registers the round on
  // the empty contract. (Audit 4, C-3.)
  const recordedClaim = record.addresses?.HCOWClaim;
  // 12차 감사 L-2. 이전 판은 기록된 주소에 코드가 있을 때만 REPLACE_CLAIM 을
  // 요구했다. 뒤처진 RPC 노드나 틀린 레코드가 '0x' 를 돌려주면 기록된 claim 이
  // 플래그도 경고도 없이 덮어써졌다 (재현함). deploy.cjs 는 메인넷에서 같은 상황을
  // 거부한다. 이제 기록된 claim 은 코드 유무와 무관하게 명시적 교체를 요구하고,
  // 교체하면 옛 주소를 레코드의 "abandoned" 목록에 남긴다.
  const recordedClaimCode = recordedClaim ? await provider.getCode(recordedClaim) : null;
  if (recordedClaim) {
    if (!dryFlag('REPLACE_CLAIM')) {
      throw new Error(
        recordedClaimCode !== '0x'
          ? `HCOWClaim is already deployed on chain ${chainId} at ${recordedClaim} and has code there. ` +
            'Deploying again produces a second contract that vesting will never fund, and overwrites the ' +
            'record that set-root.cjs and the schedule both read. If the first one really is to be ' +
            'abandoned AND the schedule has not been sealed against it, re-run with REPLACE_CLAIM=yes.'
          : `deployments/${chainId}.json names HCOWClaim at ${recordedClaim} but this RPC shows no code ` +
            'there. Either the node is behind, or the record is wrong. Find out which before deploying: ' +
            'if a claim is really there, a second one is one vesting will never fund. If the record is ' +
            'really wrong, re-run with REPLACE_CLAIM=yes and the old address is kept in the record\'s ' +
            '"abandoned" list.');
    }
    console.log(`REPLACE_CLAIM is set. The record currently names ${recordedClaim}` +
                `${recordedClaimCode === '0x' ? ' (no code there)' : ''}; it will be moved to "abandoned".`);
  }
  // 12차 감사 M-1. "파일이 있는가" 가 아니라 "파일이 토큰을 부르는가" 를 본다.
  // 정해진 순서에서 이 스크립트는 deploy-token.cjs 다음이므로 레코드는 이미
  // HCOWToken 을 부른다. 레코드를 잃은 뒤 deploy-anchor.cjs 가 앵커만 적힌 새 파일을
  // 쓰면, 이전 판은 그 파일을 "처음이 아니다" 의 증거로 받아 플래그 없이 두 번째
  // claim 을 배포했다 (재현함). 그 파일에 HCOWVesting 이 없으므로 바로 아래의
  // "베스팅이 이미 있다" 가드도 함께 풀렸다.
  const recordNamesToken = !!record.addresses?.HCOWToken;
  if (!recordNamesToken && !dryFlag('FIRST_DEPLOY') && !dryRun) {
    throw new Error(
      (priorRecord
        ? `deployments/${chainId}.json exists but names no HCOWToken. `
        : `no deployments/${chainId}.json exists. `) +
      'That is what a first deploy looks like, and it is also ' +
      'what a wiped record looks like after something was already deployed here (deploy-anchor.cjs ' +
      'writes a fresh file with only the anchor in it). The checks below that need the record ' +
      '(vesting already deployed, TGE comparison, treasury match) cannot run without it. If this ' +
      'really is the first deploy on this chain, re-run with FIRST_DEPLOY=yes. If it is not, ' +
      'restore the record first.');
  }

  // ---- the token --------------------------------------------------------
  const token = process.env.HCOW_ADDRESS ? addr('HCOW_ADDRESS') : record.addresses?.HCOWToken;
  if (!token) throw new Error('HCOW_ADDRESS must be set, or deployments/<chain>.json must already name HCOWToken');

  if ((await provider.getCode(token)) === '0x') throw new Error(`${token} has no code on chain ${chainId}`);
  const tk = at('HCOWToken', token, provider);
  const [sym, dec, supply] = await Promise.all([tk.symbol(), tk.decimals(), tk.totalSupply()]);
  console.log(`token     ${token}  ${sym}, ${dec} decimals, supply ${ethers.formatUnits(supply, dec)}`);
  if (Number(dec) !== 18) throw new Error(`token reports ${dec} decimals; every amount in the trees is written in 18`);

  // HCOWClaim.token is immutable. The previous version of this script printed
  // the symbol and compared nothing, so an 18-decimal decoy passed and the
  // claim contract was wired to it forever. (Audit 4, C-4.)
  if (sym !== 'HCOW') {
    throw new Error(
      `the token at ${token} calls itself ${JSON.stringify(sym)}, not "HCOW". HCOWClaim.token is ` +
      'immutable, so a claim contract bound to the wrong token can never pay anyone and its sweep ' +
      'moves the wrong asset.');
  }
  if (mainnet && supply !== 200_000_000n * E) {
    throw new Error(
      `the token at ${token} reports a total supply of ${ethers.formatUnits(supply, 18)}, not 200,000,000. ` +
      'HCOW has a fixed supply and no mint function, so this is not HCOW.');
  }
  // A record that already names a token is the value seal.cjs and release.cjs
  // treat as authoritative. Replacing it from an environment variable without
  // saying so is how the authoritative value becomes the unverified one.
  const recordedToken = record.addresses?.HCOWToken;
  if (recordedToken && recordedToken.toLowerCase() !== token.toLowerCase()) {
    throw new Error(
      `HCOW_ADDRESS is ${token} but deployments/${chainId}.json already names HCOWToken as ` +
      `${recordedToken}. One of the two is wrong and this script will not pick. Other scripts read ` +
      'that record as the authoritative token address.');
  }

  // ---- the owner --------------------------------------------------------
  const owner = addr('CLAIM_OWNER');
  if (owner === ethers.ZeroAddress) throw new Error('CLAIM_OWNER must not be the zero address');
  if (mainnet && owner.toLowerCase() === me.toLowerCase()) {
    throw new Error(
      'CLAIM_OWNER is the deploy key. setRoot, sweep and extendDeadline are the whole of this ' +
      "contract's trust surface and they belong to the treasury Safe, not to a throwaway key.");
  }
  const ownerCode = await provider.getCode(owner);
  // 10차 감사: EIP-7702 위임 EOA 는 0xef0100… 코드를 가진다. `=== '0x'` 만 보면
  // 위임 EOA 가 Safe 처럼 통과했다 (재현함).
  const ownerIsEoa = isEoaCode(ownerCode);
  console.log(`owner     ${owner}  ${ownerIsEoa ? (ownerCode === '0x' ? 'EOA' : 'EOA (EIP-7702 delegated)') : `contract, ${(ownerCode.length - 2) / 2} bytes of code`}`);

  // The record already carries the treasury address and this script already
  // holds the record, and it compared nothing. (Audit 4, H-6.)
  if (record.treasury && record.treasury.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `CLAIM_OWNER is ${owner} but deployments/${chainId}.json records the treasury as ` +
      `${record.treasury}. setRoot, sweep and extendDeadline are the whole trust surface of this ` +
      'contract and ownership cannot be renounced, so a wrong owner here is permanent. If the ' +
      'treasury really has moved, update the record first so both agree.');
  }
  if (mainnet && ownerIsEoa) {
    if (!dryFlag('ALLOW_EOA_OWNER')) {
      throw new Error(
        'CLAIM_OWNER is an externally owned account on mainnet. Spec 4-7 says the owner is a ' +
        'multisig (Safe), and this key would hold setRoot, sweep and extendDeadline permanently ' +
        'with no way to renounce. A warning printed here was ignorable; this is not. Set ' +
        'ALLOW_EOA_OWNER=yes only if a single key really is the intended owner.');
    }
    console.log('          WARNING: this is an EOA and ALLOW_EOA_OWNER is set. Proceeding.');
  }

  // ---- the deadline -----------------------------------------------------
  const deadline = Number(process.env.CLAIM_DEADLINE || 0);
  if (!Number.isInteger(deadline) || deadline <= 0) {
    throw new Error('CLAIM_DEADLINE must be a unix timestamp in SECONDS, not milliseconds and not a date string.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now) throw new Error(`CLAIM_DEADLINE ${deadline} is already in the past`);
  if (deadline > now + 3650 * DAY) throw new Error(`CLAIM_DEADLINE ${deadline} is more than 10 years out; the constructor refuses it`);
  console.log(`deadline  ${new Date(deadline * 1000).toISOString()}  (${((deadline - now) / DAY).toFixed(1)} days out)`);

  // The last round opens five 30-day months after TGE under the policy as
  // drafted. A deadline before that would close claiming on rounds that have
  // not opened. The deadline extends but never shortens, so erring long costs
  // nothing and erring short cannot be undone.
  // 7차 감사 M-4. 이 대조는 record.tgeTime 에만 의존했고, 그 값을 쓰는 곳은
  // 저장소 전체에서 deploy.cjs 하나뿐이다. 정해진 배포 순서는
  // token -> HCOWClaim -> vesting 이므로 이 스크립트가 도는 시점에 tgeTime 은
  // 구조적으로 항상 없었다. 즉 "no TGE recorded" 가 예외가 아니라 상시였고,
  // claimDeadline 은 연장만 되고 줄일 수 없으므로 "너무 짧게 잡았다" 를 잡아
  // 줄 유일한 검사가 한 번도 돌지 않았다. 대표 결정으로 env 로 직접 받는다.
  const envTge = process.env.TGE_TIME;
  if (envTge !== undefined && !/^\d+$/.test(String(envTge).trim())) {
    throw new Error(`TGE_TIME "${envTge}" must be a unix timestamp in SECONDS, not milliseconds and not a date string.`);
  }
  const tgeFromEnv = envTge === undefined ? null : Number(String(envTge).trim());
  // 8차 감사 M-6. 이전 판은 숫자 정규식만 봤다. deploy.cjs 는 같은 값에 대해
  // 과거 거부 · 365일 초과 거부 · 메인넷 2일 미만 거부를 한다. 형제 비대칭이고
  // 결과가 나쁘다: 아래의 "deadline 이 TGE 후 12개월 이상" 검사는 claimDeadline 을
  // 너무 짧게 잡은 것을 잡아낼 유일한 검사인데, TGE 를 과거로 잘못 넣으면
  // 그 검사가 잘못된 기준으로 통과한다. TGE_TIME 을 여기서 받기로 한 것이
  // 7차 M-4 의 조치였으므로, 그 값의 상식 검사도 여기 있어야 한다.
  //
  // 밀리초는 /^\d+$/ 를 통과한다. 13자리는 서기 4만년대이므로 범위 검사가
  // 잡아내고, 그때 문구가 CLAIM_DEADLINE 을 탓하지 않도록 여기서 먼저 잡는다.
  if (tgeFromEnv !== null) {
    if (!Number.isInteger(tgeFromEnv) || tgeFromEnv <= 0) {
      throw new Error(`TGE_TIME ${envTge} is not a positive integer number of seconds.`);
    }
    if (tgeFromEnv <= now) {
      throw new Error(
        `TGE_TIME ${tgeFromEnv} is in the past (now ${now}). HCOWVesting refuses a tgeTime in the ` +
        'past, so a TGE handed to this script can never be one, and the deadline-versus-TGE check ' +
        'below would pass against a TGE that does not exist.');
    }
    // env 로 받은 값은 **벽시계** 로 잰다. 사람이 방금 타이핑한 값이므로 실세계
    // 시간이 근거다. 레코드에서 온 값은 아래에서 체인 시계로 재는데, 그쪽은
    // 이미 deploy.cjs 가 자기 규칙으로 검증해서 쓴 값이고 그 뒤로 시간이
    // 흘렀다는 사실을 다시 문제 삼는 것은 의미가 없기 때문이다.
    if (tgeFromEnv > now + 365 * DAY) {
      throw new Error(
        `TGE_TIME ${tgeFromEnv} is more than 365 days out; the HCOWVesting constructor refuses it, ` +
        'so a claim contract sized against it would be sized against a TGE that cannot happen. ' +
        'A 13-digit value is milliseconds, not seconds.');
    }
  }
  // 10차 감사 정정 (9차 B-F4 를 되돌린다). 9차는 이 스크립트에 메인넷 "TGE 2일
  // 하한" 의 근거가 없다고 보고 그 가드를 지웠다. 틀렸다. 이 claim 을 자금으로
  // 채울 베스팅은 이 스크립트 **다음에** deploy.cjs 로 배포되고, deploy.cjs 는 TGE
  // 가 2일 안이면 거부한다. 재현: TGE 36시간 전에 이 스크립트는 exit 0 으로
  // claim 을 배포하고, 다음 단계 deploy.cjs 는 같은 TGE 로 거부했다. 결과는
  // 영원히 자금을 받지 못하는 claim 하나다. 그리고 9차가 근거로 든 "TGE 직전
  // 재배포로 immutable 인자 오류를 고친다" 는 경로도 없다 — 베스팅이 이미 있으면
  // 새 claim 은 수혜자가 될 수 없다 (위 참조). 그래서 규칙을 되살리되, 이번에는
  // 그 규칙이 여기 있어야 하는 진짜 이유를 적는다.
  if (tgeFromEnv !== null && mainnet && tgeFromEnv < now + 2 * DAY) {
    throw new Error(
      `TGE_TIME is less than 2 days away. The vesting contract that funds this claim contract is ` +
      'deployed AFTER it, by deploy.cjs, and deploy.cjs refuses a TGE under 2 days away because the ' +
      'nine schedules must be loaded before TGE. A claim contract deployed now would be one that no ' +
      'vesting can ever fund. Set a later TGE.');
  }

  // 둘 다 있으면 일치해야 한다. 이 스크립트가 고르지 않는다.
  if (tgeFromEnv !== null && record.tgeTime && Number(record.tgeTime) !== tgeFromEnv) {
    throw new Error(
      `TGE_TIME is ${tgeFromEnv} but deployments/${chainId}.json records tgeTime as ${record.tgeTime}. ` +
      'One of the two is wrong and this script will not pick. deploy.cjs writes that value when it ' +
      'deploys the vesting, which fixes tgeTime as immutable, so while that vesting is the recorded ' +
      'one the recorded value is what the chain holds. (12차 L-4: if that vesting was abandoned by ' +
      'hand, its tgeTime belongs in the same "abandoned" entry, not at the top level.)');
  }
  const tge = tgeFromEnv ?? (record.tgeTime ? Number(record.tgeTime) : null);
  // 9차 감사 B-F2. 8차 판의 상식 검사는 env 값만 봤고 record.tgeTime 은 무검증이었다.
  // 재현 확인: record.tgeTime 을 400일 과거로 두면 실제 TGE 대비 2.2개월인
  // CLAIM_DEADLINE 이 "16.5개월" 로 계산돼 메인넷에 그대로 배포됐다. 같은 deadline 이
  // TGE_TIME 으로 줄 때는 거부된다. 검사가 "정직하게 env 로 준 사람만" 막고 있었다.
  //
  // 해결은 값을 거부하는 쪽이 아니다. TGE 가 이미 지났다면 "TGE 로부터 12개월" 은
  // 애초에 맞는 잣대가 아니고, 맞는 잣대는 "지금으로부터 12개월" 이다. 그래서
  // 잣대를 바꾸고 그렇게 말한다. TGE 이후의 정당한 재배포도 막지 않는다.
  if (tge !== null) {
    const source = tgeFromEnv !== null ? 'TGE_TIME' : `deployments/${chainId}.json`;
    if (!Number.isInteger(tge) || tge <= 0) {
      throw new Error(
        `the TGE in use is ${tge}, which is not a positive integer number of seconds. ` +
        `It came from ${source}.`);
    }
    // 상한은 **체인 시계** 로 잰다. 벽시계로 재면 안 되는 이유: 레코드의 tgeTime 은
    // deploy.cjs 가 쓸 때 이미 자기 규칙(미래·365일 이내·2일 이상)으로 검증한 값이고,
    // 그 뒤로 흐른 시간을 다시 문제 삼는 것은 의미가 없다. 반면 밀리초 값이나 다른
    // 체인에서 복사된 값은 어느 시계로 재도 터무니없다. 그리고 이 값을 실제로
    // 강제한 것은 block.timestamp 이므로 그쪽이 근거다.
    const chainNow = (await provider.getBlock('latest')).timestamp;
    if (tge > chainNow + 365 * DAY) {
      throw new Error(
        `the TGE in use is ${tge}, which is more than 365 days past the chain's latest block ` +
        `(${chainNow}). The HCOWVesting constructor refuses a tgeTime that far out, so no vesting ` +
        `contract can ever hold this value. It came from ${source}. A 13-digit value is ` +
        'milliseconds, not seconds.');
    }
  }
  if (tge) {
    const past = tge <= now;
    const yardstick = past ? now : tge;
    const monthsAfterTge = (deadline - tge) / (30 * DAY);
    const monthsAhead = (deadline - yardstick) / (30 * DAY);
    console.log(`          ${monthsAfterTge.toFixed(1)} thirty-day months after TGE ${tgeFromEnv !== null ? '(TGE_TIME)' : '(recorded)'}`);
    if (past) {
      console.log(`          that TGE is already past, so the deadline is measured from NOW instead: ` +
                  `${monthsAhead.toFixed(1)} thirty-day months ahead`);
    }
    if (deadline <= tge) throw new Error('CLAIM_DEADLINE is at or before TGE; no round would ever be claimable');
    if (mainnet && monthsAhead < 12) {
      throw new Error(
        `CLAIM_DEADLINE is ${monthsAhead.toFixed(1)} thirty-day months ${past ? 'from now' : 'after TGE'}. ` +
        "The drafted policy's last round opens at month 4, and a deadline this close reads as a " +
        'countdown. It extends later but never shortens, so set it long and extend if you need to.');
    }
    // 8차 감사 M-7. 이전 판은 `mainnet && !dryRun` 이었다. 배너가
    // "DRY RUN. Every check below runs." 라고 찍는데 메인넷 드라이런에서는
    // 이 필수 검사가 통째로 빠졌다. claimDeadline 은 연장만 되므로 TGE 대조는
    // 너무 짧은 기한을 잡은 것을 잡아낼 유일한 검사이고, 리허설에서 빠지면
    // 리허설이 초록인 이유가 검사가 통과한 것인지 돌지 않은 것인지 알 수 없다.
  } else if (mainnet) {
    throw new Error(
      'TGE_TIME must be set, in unix SECONDS, or deployments/<chain>.json must already record tgeTime. ' +
      'CLAIM_DEADLINE can only ever be extended, so the comparison against TGE is the one check that ' +
      'can catch a deadline set too short, and on mainnet it is not optional. In the deployment order ' +
      'this repository uses, the claim contract is deployed before vesting exists, so the record does ' +
      'not have tgeTime yet and the value has to come from here.');
  } else {
    console.log('          no TGE given and none recorded; the deadline is not being compared to it');
  }

  // ---- the notice period ------------------------------------------------
  //
  // Audit 4, A-1. setRoot is the owner's second route to the balance and it is
  // not time-locked the way sweep() is. That route cannot be removed: a
  // distributor whose operator chooses the root cannot tell an honest
  // recipient list from a dishonest one. What the notice buys is that no round
  // can open in the block it was registered, so every root is a public
  // RoundSet event before it can pay anyone -- and, the reason it was actually
  // chosen, that a mistyped startTime can no longer freeze a wrong root
  // instantly. It is immutable once deployed.
  const notice = Number(process.env.CLAIM_NOTICE_SECONDS || 0);
  if (!Number.isInteger(notice) || notice <= 0) {
    throw new Error(
      'CLAIM_NOTICE_SECONDS must be set, in SECONDS. It is how far ahead a round must be ' +
      'registered before it can open, it is immutable after deployment, and the contract ' +
      'accepts 3600 (1 hour) to 2592000 (30 days). The recommendation on record is 259200 (72 hours).');
  }
  if (notice < 3600 || notice > 30 * DAY) {
    throw new Error(`CLAIM_NOTICE_SECONDS ${notice} is outside the contract's [3600, ${30 * DAY}] range`);
  }
  console.log(`notice    ${notice}s  (${(notice / 3600).toFixed(1)} hours a round must wait before it can open)`);
  if (mainnet && notice < 24 * 3600) {
    throw new Error(
      `CLAIM_NOTICE_SECONDS is ${(notice / 3600).toFixed(1)} hours. Under a day gives nobody time to ` +
      'read a new root before it can pay, which is the entire point of the parameter. The hour floor ' +
      'exists for testnet rehearsal. Set it deliberately or use the recommended 259200.');
  }

  // ---- the claim window -------------------------------------------------
  //
  // Every round must open at least this long before CLAIM_DEADLINE. Without it
  // the deadline and the round schedule are unrelated numbers, and a deadline
  // earlier than the last round's start puts sweep() in reach of tokens no
  // round has opened to pay out. Immutable once deployed, like the notice.
  const window = Number(process.env.CLAIM_WINDOW_SECONDS || 0);
  if (!Number.isInteger(window) || window <= 0) {
    throw new Error(
      'CLAIM_WINDOW_SECONDS must be set, in SECONDS. It is how long every round must stay ' +
      'claimable before sweep() can open, it is immutable after deployment, and the contract ' +
      'accepts 3600 (1 hour) to 31536000 (365 days).');
  }
  if (window < 3600 || window > 365 * DAY) {
    throw new Error(`CLAIM_WINDOW_SECONDS ${window} is outside the contract's [3600, ${365 * DAY}] range`);
  }
  console.log(`window    ${window}s  (${(window / DAY).toFixed(1)} days every round stays claimable)`);
  if (mainnet && window < 30 * DAY) {
    throw new Error(
      `CLAIM_WINDOW_SECONDS is ${(window / DAY).toFixed(1)} days. Under 30 days on mainnet means the ` +
      'last round could close to sweep() before slow claimants arrive. The hour floor exists for ' +
      'testnet rehearsal.');
  }
  if (deadline < now + notice + window) {
    throw new Error(
      `CLAIM_DEADLINE ${deadline} is earlier than now + CLAIM_NOTICE_SECONDS + CLAIM_WINDOW_SECONDS ` +
      `(${now + notice + window}). The constructor refuses it: no round could ever be registered.`);
  }

  // 11차 감사. TGE 와 notice 를 서로 대조하지 않았다. 0번 라운드(TGE 지급)는
  // TGE 에 열려야 하고, 그러려면 TGE 보다 최소 notice 만큼 먼저 등록돼야 한다.
  // 그 사이에 베스팅 배포 · 적재 · 봉인이 모두 끝나야 set-root 가 자금을 확인할
  // 수 있다(봉인 전 베스팅은 자금으로 세지 않는다). set-root.cjs 는 여기에 여유
  // max(1일, notice) 를 요구한다. 재현: TGE 2.5일 전 · notice 72시간으로 배포하면
  // exit 0 이었고, 0번 라운드는 TGE 에 결코 열 수 없었다 — notice 는 immutable 이다.
  if (tge && tge > now) {
    const needAhead = Math.max(DAY, notice) + DAY;
    if (mainnet && tge - now < needAhead) {
      throw new Error(
        `TGE is ${((tge - now) / 3600).toFixed(1)} hours away and CLAIM_NOTICE_SECONDS is ` +
        `${(notice / 3600).toFixed(1)} hours. Round 0 pays at TGE, so it must be registered at least ` +
        `the notice before TGE, and set-root.cjs keeps max(1 day, notice) of margin for the Safe to ` +
        `execute. That needs TGE at least ${(needAhead / 3600).toFixed(1)} hours out, with the vesting ` +
        'deployed, loaded and sealed inside that time. notice is immutable, so a claim contract ' +
        'deployed now could never open round 0 at TGE. Use a later TGE or a shorter notice.');
    }
  }
  // 12차 감사 L-3. 라운드는 기한보다 minClaimWindow 만큼 먼저 열려야 한다 (setRoot
  // 가 거부한다). 12개월 기한 하한과 365일 창 상한을 각각 지켜도 둘의 조합은
  // "TGE 에 여는 0번 라운드" 를 불가능하게 만들 수 있었다. 재현: 창 365일 · 기한
  // TGE+361일이 exit 0. extendDeadline 로 고칠 수 있지만 TGE 직전의 Safe 트랜잭션
  // 하나를 더 요구한다. 행 전체가 풀린 뒤의 라운드까지는 deploy.cjs 가 본다
  // (이 스크립트는 아직 스케줄 행을 모른다).
  if (mainnet && tge && tge > deadline - window) {
    throw new Error(
      `CLAIM_DEADLINE − CLAIM_WINDOW_SECONDS is ${new Date((deadline - window) * 1000).toISOString()}, ` +
      `earlier than TGE ${new Date(tge * 1000).toISOString()}. Every round must open at least the window ` +
      'before the deadline, so round 0 could not open at TGE. Use a later deadline or a shorter window.');
  }

  // ---- has a vesting contract already been deployed? ---------------------
  //
  // 10차 감사. 이전 판은 sealed_() 만 봤다. 그런데 수혜자 집합은 봉인이 아니라
  // **베스팅 배포 시점에** expectedScheduleHash 로 immutable 이 된다. 그 해시에는
  // 9개 수혜자 주소가 전부 들어간다. 그러니 베스팅이 이미 있으면, 봉인 전이라도,
  // 지금 배포하는 claim 은 그 베스팅의 수혜자가 될 수 없다. 재현: 베스팅 배포 뒤
  // REPLACE_CLAIM=yes 로 돌리니 exit 0 으로 새 claim 이 배포되고 레코드가 그쪽을
  // 가리켰다. set-root.cjs 는 인자 없이 돌면 잔액 0 인 새 claim 에 루트를 등록한다.
  const vesting = record.addresses?.HCOWVesting;
  if (vesting) {
    const v = at('HCOWVesting', vesting, provider);
    const vCode = await provider.getCode(vesting);
    const sealed = vCode === '0x' ? null : await v.sealed_().catch(() => null);
    console.log(`vesting   ${vesting}  ${sealed === true ? 'SEALED' : sealed === false ? 'not sealed' : 'unreadable'}`);
    throw new Error(
      `HCOWVesting is already recorded on chain ${chainId} at ${vesting}${sealed ? ' and it is SEALED' : ''}. ` +
      'Its beneficiary set was fixed when it was DEPLOYED, not when it is sealed: expectedScheduleHash ' +
      'is immutable and contains all nine addresses. A claim contract deployed now can never be one of ' +
      'them, so vesting would never fund it. The order is claim first, then vesting ' +
      '(HCOW_Deployment_Order). There is no flag for this, REPLACE_CLAIM included. If the vesting is ' +
      'unsealed and holds nothing and really is to be abandoned, that is a decision made by hand on the ' +
      'record, not by a flag here: move the addresses.HCOWVesting value and the top-level tgeTime into ' +
      'one entry of a top-level "abandoned" list in the file (so the contract stays named somewhere), ' +
      'delete both from where they were, then run deploy.cjs again. The claim contract does not need ' +
      'replacing: it is bound only to the token, and the new vesting names it in the Airdrop row just ' +
      'as the old one did. (12차 L-4: the earlier text also told you to redeploy the claim, which ' +
      'was unnecessary, and left tgeTime behind, which then blocked any new TGE.)');
  }
  console.log('vesting   not recorded for this chain (correct: the claim contract comes first)');

  // ---- deploy -----------------------------------------------------------
  if (dryRun) {
    const skipped = [];
    if (bal === 0n) skipped.push('the deployer has no BNB (checked only on the live run)');
    if (!recordNamesToken) {
      skipped.push(`deployments/${chainId}.json ${priorRecord ? 'names no HCOWToken' : 'does not exist'}, which the LIVE run refuses unless ` +
                   'FIRST_DEPLOY=yes. If anything is already deployed on this chain, restore the record instead.');
    }
    console.log('\nDRY RUN. Nothing has been sent or written. These are the constructor arguments');
    console.log('that would be used:');
    console.log(`  token          ${token}`);
    console.log(`  owner          ${owner}`);
    console.log(`  claimDeadline  ${deadline}  (${new Date(deadline * 1000).toISOString()})`);
    console.log(`  minRoundNotice ${notice}  (${(notice / 3600).toFixed(1)} hours)`);
    console.log(`  minClaimWindow ${window}  (${(window / DAY).toFixed(1)} days)`);
    if (skipped.length) {
      console.log('\nCHECKS THIS DRY RUN DID NOT MAKE:');
      for (const w of skipped) console.log('  - ' + w);
    }
    console.log('\nRe-run without DRY_RUN / PRINT_ONLY to deploy.');
    return;
  }
  const c = await deploy('HCOWClaim', signer, [token, owner, deadline, notice, window]);
  const claim = await c.getAddress();
  const tx = c.deploymentTransaction().hash;
  // set-root.cjs 는 RoundSet 이벤트를 이 블록부터 읽는다. 영수증에서 매번 다시 찾게
  // 하지 않는 이유: 노드는 오래된 트랜잭션 색인을 지운다 (geth 기본 약 235만 블록,
  // BSC 로 약 20일). 그 뒤에는 영수증이 null 이다. (RoundSet 조회 재검 F4)
  const deployedBlock = (await c.deploymentTransaction().wait()).blockNumber;
  console.log(`\nHCOWClaim ${claim}  tx ${tx}  block ${deployedBlock}`);

  // Read the constructor arguments back off the chain rather than trusting
  // what was sent. A wrongly encoded argument is silent and this is the last
  // cheap moment to notice: token and owner cannot be changed afterwards and
  // the deadline can only move one way.
  const cc = at('HCOWClaim', claim, provider);
  const [oTok, oOwner, oDeadline, oMin, oNotice, oWindow] = await Promise.all([
    cc.token(), cc.owner(), cc.claimDeadline(), cc.minClaimAmount(),
    cc.minRoundNotice(), cc.minClaimWindow(),
  ]);
  const bad = [];
  if (oTok.toLowerCase() !== token.toLowerCase()) bad.push(`token ${oTok}`);
  if (oOwner.toLowerCase() !== owner.toLowerCase()) bad.push(`owner ${oOwner}`);
  if (oDeadline !== BigInt(deadline)) bad.push(`claimDeadline ${oDeadline}`);
  if (oMin !== 0n) bad.push(`minClaimAmount ${oMin}, expected 0`);
  // Both are immutable. A wrongly encoded one is silent and cannot be fixed.
  if (oNotice !== BigInt(notice)) bad.push(`minRoundNotice ${oNotice}, expected ${notice}`);
  if (oWindow !== BigInt(window)) bad.push(`minClaimWindow ${oWindow}, expected ${window}`);
  if (bad.length) throw new Error('the deployed contract does not read back as deployed:\n  ' + bad.join('\n  '));
  console.log('          token, owner, deadline, notice, window and a zero minClaimAmount all read back correctly');

  const rec = {
    ...record,
    chainId,
    ...(recordedClaim ? { abandoned: [...(Array.isArray(record.abandoned) ? record.abandoned : []),
      { HCOWClaim: recordedClaim, replacedAt: new Date().toISOString(), replacedBy: claim }] } : {}),
    addresses: { ...(record.addresses || {}), HCOWToken: token, HCOWClaim: claim },
    deploymentTxs: { ...(record.deploymentTxs || {}), HCOWClaim: tx },
    claim: {
      deployedAt: new Date().toISOString(),
      deployedBlock,
      deployedBy: me,
      owner,
      claimDeadline: deadline,
      token,
    },
  };
  console.log(`written to ${writeRecord(chainId, rec)}`);

  // 11차 감사: 이 목록은 deploy.cjs 와 commitcheck 를 빠뜨렸고, setRoot 를 TGE
  // 뒤에 두었다. 그 순서로는 0번 라운드를 TGE 에 열 수 없다 (notice 때문에).
  console.log('\nNEXT, IN ORDER:');
  console.log(`  1. Put ${claim} in the Community / Airdrop row of the schedule file`);
  console.log('     (and nowhere else). deploy.cjs fixes the beneficiary set immutably.');
  console.log('  2. node scripts/commitcheck.cjs <schedule>   → the four EXPECT_ values');
  console.log('  3. node scripts/deploy.cjs  (HCOW_ADDRESS set, DRY_RUN=yes first)');
  console.log('  4. node scripts/load.cjs, then node scripts/seal.cjs  (PRINT_ONLY for the Safe)');
  console.log('  5. node scripts/build-merkle.cjs <recipients> --policy <policy.json> --tge <tge>');
  console.log(`  6. BEFORE TGE minus ${Math.max(DAY, notice) / 3600} hours: node scripts/set-root.cjs --round 0`);
  console.log('  7. At or after TGE: node scripts/release.cjs RELEASE=yes, so tokens arrive here');
  console.log('\nVerify on BscScan with solc 0.8.34, optimizer 200 runs, evmVersion paris.');
  console.log('Constructor arguments, ABI-encoded:');
  console.log('  ' + new ethers.AbiCoder().encode(['address', 'address', 'uint256', 'uint256', 'uint256'],
    [token, owner, deadline, notice, window]).slice(2));
}

main().catch((e) => { console.error('\n' + (e.message || e)); process.exitCode = 1; });
