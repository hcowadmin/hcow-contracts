'use strict';
// Deploys HCOWAnchor. Anchors nothing and holds no tokens when it finishes.
//
//   RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... \
//   ANCHOR_OWNER=0x<treasury Safe> ANCHOR_PUBLISHER=0x<hot key> \
//   node scripts/deploy-anchor.cjs
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

const { connect, deploy, at, writeRecord, readRecord, ethers } = require('./_connect.cjs');

const addr = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set`);
  if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);
  return ethers.getAddress(v);
};

async function main() {
  const { provider, signer, net, mainnet } = await connect();
  const me = await signer.getAddress();
  const bal = await provider.getBalance(me);
  const chainId = Number(net.chainId);

  console.log(`chain     ${chainId}${mainnet ? '  (BNB CHAIN MAINNET)' : ''}`);
  console.log(`deployer  ${me}`);
  console.log(`balance   ${ethers.formatEther(bal)} BNB\n`);
  if (bal === 0n) throw new Error('deployer has no BNB');

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
  if (!priorRecord && process.env.REPLACE_ANCHOR !== '1' && process.env.FIRST_DEPLOY !== '1') {
    throw new Error(
      `deployments/${chainId}.json does not exist, so this script cannot tell whether an ` +
      'HCOWAnchor is already deployed on this chain. A missing record is also what a wiped or ' +
      'moved file looks like, and deploying over a live anchor moves the hourly job to a fresh ' +
      'contract whose lastPeriodStart is 0. If this really is the first deployment on this chain, ' +
      're-run with FIRST_DEPLOY=1. If it is not, restore the record first.');
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
  console.log(`owner     ${owner}  ${ownerCode === '0x' ? 'EOA' : `contract, ${(ownerCode.length - 2) / 2} bytes of code`}`);
  if (mainnet && ownerCode === '0x') {
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
  console.log(`publisher ${publisher}  ${pubCode === '0x' ? 'EOA' : 'contract'}`);
  if (pubCode !== '0x') {
    console.log('          NOTE: a contract publisher must be able to call anchor(); an EOA is the expected case.');
  }
  const pubBal = await provider.getBalance(publisher);
  console.log(`          ${ethers.formatEther(pubBal)} BNB`);
  if (pubBal === 0n) {
    console.log('          WARNING: the publisher has no BNB and cannot anchor until it is funded.');
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
  record.addresses = { ...(record.addresses || {}), HCOWAnchor: address };
  writeRecord(chainId, record);
  console.log(`\nrecorded in deployments/${chainId}.json`);
  console.log('\nNext: verify on BscScan, then run scripts/anchor.cjs on the hourly schedule.');
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
