'use strict';
// Deploys HCOWAnchor. Anchors nothing and holds no tokens when it finishes.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... \
//   ANCHOR_OWNER=0x<treasury Safe> ANCHOR_PUBLISHER=0x<hot key> \
//   FIRST_DEPLOY=1 node scripts/deploy-anchor.cjs
//
// FIRST_DEPLOY=1 is needed exactly once, for the first anchor on a chain: from
// audit 13 on, the script asks for it whenever deployments/<chain>.json does
// not name an HCOWAnchor, whatever else the file names. Run with DRY_RUN=yes
// first; the dry run does not need the flag.
//
// THIS ONE IS NOT ORDER-SENSITIVE
//
// Unlike the claim contract, nothing in HCOWVesting points at this address, so
// it can be deployed before or after seal() and before or after TGE. It has no
// relationship to any audited contract at all. Deploying it early only means
// starting to anchor earlier, and the first anchored hour is the first hour the
// project can prove anything about.
//
// THE TWO ADDRESSES ARE NOT THE SAME KIND OF KEY
//
//   publisher   a hot key on whatever server runs the hourly job. It will be
//               on disk. It can append and nothing else. Treat it as burnable.
//   owner       rotates the publisher and nothing else. Treasury Safe.
//
// Passing the same address for both defeats the split: the point of the split
// is that the key living on a server cannot rotate itself after it leaks.
//
// WHAT IT CANNOT CHECK
//
// Whether ANCHOR_OWNER is really the treasury Safe. That is the same open
// question as in deploy-claim.cjs and the same answer: ownership transfers
// need the new owner to accept, so a wrong owner here is recoverable while the
// old key is still held.

const { connect, deploy, at, writeRecord, readRecord, ethers, suppressed, isEoaCode } = require('./_connect.cjs');

const addr = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set`);
  if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);
  return ethers.getAddress(v);
};

async function main() {
  // 8차 감사 M-8. 억제 플래그는 가장 먼저 읽는다. 아래 재실행 가드가 이 값을
  // 보기 때문이고, 오타로 인한 throw 도 무엇이 보내지기 전에 나야 한다.
  const dryRun = suppressed();

  const { provider, signer, net, mainnet } = await connect();
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);
  const chainId = Number(net.chainId);

  console.log(`chain     ${chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB\n`);
  if (bal === 0n && !dryRun) throw new Error('deployer has no BNB');

  // 기존 배포가 있으면 멈춘다. 덮어쓰면 anchor.cjs 가 lastPeriodStart=0 인
  // 새 컨트랙트로 옮겨가고, 과거 모든 시간을 다른 루트로 다시 앵커할 수 있게 된다.
  // 스토리지의 루트는 못 고쳐도 "우리 앵커는 이 주소다" 라는 포인터를 바꾸면
  // 역사가 사실상 갈아끼워진다. 필요한 권한은 배포키 하나뿐이다. 감사 A-M4.
  // 3차 감사 A-6. 이 가드는 로컬 파일 하나에 의존한다. 파일이 지워지거나
  // 다른 스크립트가 addresses 를 덮어써서 키가 사라지면 가드가 조용히 풀린다.
  // 그래서 파일이 아니라 **레코드의 존재 여부** 를 먼저 본다: 레코드가 아예
  // 없으면 그것도 이상한 상태이므로 명시적 확인을 요구한다.
  const priorRecord = readRecord(chainId);
  const existing = (priorRecord || {}).addresses?.HCOWAnchor;
  // 8차 감사 M-8. `&& !dryRun` 이 없어서 깨끗한 체인에서 드라이런을 돌리면
  // "레코드가 없다" 는 이유로 거절됐다. 드라이런의 존재 이유가 첫 배포 리허설인데
  // 첫 배포에서만 쓸 수 없었다. deploy-token.cjs 131행에는 이 조건이 있다.
  // 11차 감사: REPLACE_ANCHOR=1 이 이 "레코드 없음" 가드까지 풀었다. 교체
  // 플래그는 교체를 허락할 뿐, 레코드가 없다는 사실을 설명하지 않는다.
  // 13차 감사 M. 12차 M-1 의 거울상. 이 가드는 "파일이 있는가" 를 봤다. 레코드를
  // 잃은 뒤 deploy-token.cjs 를 FIRST_DEPLOY=1 로 정직하게 돌리면(토큰은 정말
  // 처음이다) 토큰만 적힌 새 파일이 생기고, 그 파일이 이 가드를 풀어 두 번째 앵커가
  // 플래그 없이 배포됐다 (재현함). 과거 모든 시간을 다른 루트로 다시 앵커할 수 있게
  // 되는 바로 그 경로다 (A-M4). 형제 스크립트와 같은 규칙: 파일이 앵커를 부르지
  // 않으면 FIRST_DEPLOY=1. 정상적인 첫 앵커 배포도 이 플래그를 한 번 요구한다.
  if (!existing && process.env.FIRST_DEPLOY !== '1' && !dryRun) {
    throw new Error(
      (priorRecord
        ? `deployments/${chainId}.json exists but names no HCOWAnchor, `
        : `deployments/${chainId}.json does not exist, `) +
      'so this script cannot tell whether an HCOWAnchor is already deployed on this chain. A record ' +
      'without an anchor is also what a wiped file looks like after another script wrote a fresh ' +
      'one, and deploying over a live anchor moves the hourly job to a fresh contract whose ' +
      'lastPeriodStart is 0. If this really is the first anchor on this chain, re-run with ' +
      'FIRST_DEPLOY=1. If it is not, restore the record first.');
  }
  if (existing && process.env.REPLACE_ANCHOR !== '1') {
    throw new Error(
      `deployments/${chainId}.json already names HCOWAnchor at ${existing}. ` +
      'Deploying again and overwriting that record would silently move the hourly job to a fresh ' +
      'contract whose lastPeriodStart is 0, letting every past hour be re-anchored with a different ' +
      'root. If you really mean to replace it, re-run with REPLACE_ANCHOR=1 and say so publicly.');
  }

  const owner = addr('ANCHOR_OWNER');
  const publisher = addr('ANCHOR_PUBLISHER');

  if (owner === ethers.ZeroAddress) throw new Error('ANCHOR_OWNER must not be the zero address');
  if (publisher === ethers.ZeroAddress) throw new Error('ANCHOR_PUBLISHER must not be the zero address');
  if (owner.toLowerCase() === publisher.toLowerCase()) {
    throw new Error(
      'ANCHOR_OWNER and ANCHOR_PUBLISHER are the same address. The publisher key lives on a ' +
      'server and will eventually leak; the owner exists to rotate it afterwards. One address ' +
      'cannot do both jobs.');
  }

  const ownerCode = await provider.getCode(owner);
  // 10차 감사: EIP-7702 위임 EOA 는 코드를 가진다. 그래도 EOA 다.
  console.log(`owner     ${owner}  ${isEoaCode(ownerCode) ? 'EOA' : `contract, ${(ownerCode.length - 2) / 2} bytes of code`}`);
  if (mainnet && isEoaCode(ownerCode)) {
    console.log('          WARNING: this is an EOA. The owner rotates the publisher key and belongs in the Safe.');
  }
  if (mainnet && owner.toLowerCase() === me.toLowerCase()) {
    throw new Error('ANCHOR_OWNER is the deploy key. Publisher rotation belongs to the treasury Safe.');
  }
  if (publisher.toLowerCase() === me.toLowerCase()) {
    throw new Error(
      'ANCHOR_PUBLISHER is the deploy key. The deploy key is a throwaway; the publisher signs ' +
      'every hour for years. They are not the same key.');
  }

  const pubCode = await provider.getCode(publisher);
  console.log(`publisher ${publisher}  ${isEoaCode(pubCode) ? 'EOA' : 'contract'}`);
  if (!isEoaCode(pubCode)) {
    console.log('          NOTE: a contract publisher must be able to call anchor(); an EOA is the expected case.');
  }
  const pubBal = await provider.getBalance(publisher);
  console.log(`          ${ethers.formatEther(pubBal)} BNB`);
  if (pubBal === 0n) {
    console.log('          WARNING: the publisher has no BNB and cannot anchor until it is funded.');
  }

  // 7차 감사 H-5. 이 스크립트에는 드라이런이 아예 없었다. dryFlag 를 import
  // 조차 하지 않아 DRY_RUN=yes 도 PRINT_ONLY=yes 도 정의되지 않은 환경변수로
  // 무시되고 실제 배포가 나갔다. deploy-token.cjs 헤더가 "새 스크립트는 이
  // 결함을 물려받으면 안 된다" 고 적어둔 바로 그 결함이다. 여기는 모든 검사가
  // 끝난 지점이므로, 드라이런은 "전부 통과했고 이 인자로 배포한다" 를 보여준다.
  if (dryRun) {
    // 10차 감사: 배너가 "Every check above passed" 라고 했지만 드라이런은 잔액
    // 검사와 레코드 부재 가드를 건너뛴다.
    const skipped = [];
    if (bal === 0n) skipped.push('the deployer has no BNB (checked only on the live run)');
    if (!existing) {
      // 14차 감사 L-2: 문구가 실제 거부 문구와 같은 질문을 던지게 한다.
      skipped.push(`deployments/${chainId}.json ${priorRecord ? 'names no HCOWAnchor' : 'does not exist'}, which the LIVE run refuses unless ` +
                   'FIRST_DEPLOY=1. Set it only if this really is the first anchor on this chain; if an anchor ' +
                   'was deployed before, restore its address to the record instead.');
    }
    console.log('\nDRY RUN. Nothing has been sent or written. These are the constructor arguments');
    console.log('that would be used:');
    console.log(`  owner      ${owner}`);
    console.log(`  publisher  ${publisher}`);
    if (skipped.length) {
      console.log('\nCHECKS THIS DRY RUN DID NOT MAKE:');
      for (const w of skipped) console.log('  - ' + w);
    }
    console.log('\nRe-run without DRY_RUN / PRINT_ONLY to deploy.');
    return;
  }

  const c = await deploy('HCOWAnchor', signer, [owner, publisher]);
  const address = await c.getAddress();

  const period = await c.PERIOD();
  const onChainOwner = await c.owner();
  const onChainPub = await c.publisher();
  const count = await c.batchCount();

  console.log(`\nHCOWAnchor ${address}`);
  console.log(`  PERIOD      ${period} seconds`);
  console.log(`  owner       ${onChainOwner}`);
  console.log(`  publisher   ${onChainPub}`);
  console.log(`  batchCount  ${count}`);

  if (onChainOwner !== owner) throw new Error('deployed owner does not match ANCHOR_OWNER');
  if (onChainPub !== publisher) throw new Error('deployed publisher does not match ANCHOR_PUBLISHER');
  if (count !== 0n) throw new Error('a freshly deployed anchor should hold no batches');
  const lastPeriod = await c.lastPeriodStart();
  if (lastPeriod !== 0n) throw new Error('a freshly deployed anchor should have no lastPeriodStart');
  // 컨트랙트의 PERIOD 와 빌더의 PERIOD 가 갈라지면 런타임에 PeriodNotAligned 로만
  // 드러난다. 배포 직후에 대조한다.
  const { PERIOD: builderPeriod } = require('./anchor-merkle.cjs');
  if (Number(period) !== builderPeriod) {
    throw new Error(`contract PERIOD ${period} does not match the builder's ${builderPeriod}`);
  }

  const record = readRecord(chainId) || {};
  // 9차 감사 A-7. 이 스크립트는 레코드를 처음 만들 때 chainId 를 쓰지 않았고,
  // 그래서 deploy.cjs 의 chainId 교차검사가 "앵커만 적힌 레코드" 에서 정확히
  // 침묵했다 — 다른 체인에서 복사해 온 파일이 바로 그 형태다.
  record.chainId = chainId;
  record.addresses = { ...(record.addresses || {}), HCOWAnchor: address };
  writeRecord(chainId, record);
  console.log(`\nrecorded in deployments/${chainId}.json`);
  console.log('\nNext: verify on BscScan, then run scripts/anchor.cjs on the hourly schedule.');
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
