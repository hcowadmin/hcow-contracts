'use strict';
/* A local JSON-RPC node backed by @ethereumjs/vm, so the real operator scripts
 * can be run unmodified. There is no network access in this environment: every
 * external RPC endpoint is blocked by the proxy, so the chain is in-process.
 * CHAIN_ID is whatever we say it is, which is the point -- it lets us test the
 * chain-confusion behaviour of the scripts.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { TransactionFactory } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, privateToAddress } = require('@ethereumjs/util');

const ROOT = path.join(__dirname, '..', '..');
const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', `${n}.json`), 'utf8'));

// 9차 감사. balances: 주소(소문자) -> wei 문자열/BigInt 로 잔액을 덮어쓴다.
// 이 노드는 모든 주소에 1 BNB 를 리턴했고, 그래서 저장소 네 곳의
// `bal === 0n && !dryRun` 가드는 테스트로 닿을 수 없었다 (그 중 하나는 실제로
// 빠져 있었고 아무도 몰랐다 — 9차 B-F1).
// 12차 감사 L-1. harnessMarker: 이 노드가 테스트 하네스임을 스스로 밝힌다
// (hcow_isTestHarness → true). _connect.cjs 는 HCOW_RECORD_DIR 가 설정돼 있으면
// 이 대답을 요구한다. 루프백 주소만으로는 로컬 BSC 노드나 SSH 터널과 구분되지
// 않았다. false 로 끄면 "루프백이지만 하네스가 아닌 노드" 를 흉내낸다.
// logRangeLimit: eth_getLogs 가 한 번에 받는 블록 범위의 상한. 공개 BSC RPC 는 이
// 범위를 제한한다 (예: 5000). 설정하면 그보다 넓은 요청을 에러로 돌려준다.
// logFailEvery: n 번째 eth_getLogs 마다 일시적 오류를 낸다 (불안정한 공개 RPC 흉내).
// hideLogBlocks: 이 블록들의 로그를 eth_getLogs 가 돌려주지 않는다 (일부를 빠뜨리는 노드 흉내).
async function makeNode({ chainId, now, balances: balancesIn = {}, harnessMarker = true, logRangeLimit = 0,
  faithfulHead = false, logFailEvery = 0, hideLogBlocks = [] }) {
  let getLogsCalls = 0;
  const hidden = new Set(hideLogBlocks.map((b) => BigInt(b)));
  // 10차 감사: 키를 대소문자 그대로 조회해서, 체크섬 표기로 넣은 0 이 조용히
  // 1 BNB 로 떨어졌다. 소문자로 정규화한다.
  const balances = Object.fromEntries(
    Object.entries(balancesIn).map(([k, v]) => [String(k).toLowerCase(), v]));
  const common = Common.custom({ chainId, networkId: chainId }, { hardfork: Hardfork.Paris, baseChain: Chain.Mainnet });
  const vm = await VM.create({ common, setHardfork: false });
  let ts = BigInt(now);
  let blockNumber = 1n;
  const receipts = new Map();
  const headNum = () => (faithfulHead ? (blockNumber > 0n ? blockNumber - 1n : 0n) : blockNumber);

  const mkBlock = () => Block.fromBlockData(
    { header: { timestamp: ts, gasLimit: 30000000n, baseFeePerGas: 0n, number: blockNumber } },
    { common, skipConsensusFormatValidation: true });

  const api = {
    vm, common,
    setTime: (t) => { ts = BigInt(t); },
    hideLogs: (b) => hidden.add(BigInt(b)),
    showAllLogs: () => hidden.clear(),
    now: () => ts,
    async callRaw(to, data, from) {
      const r = await vm.evm.runCall({
        to: to ? new Address(hexToBytes(to)) : undefined,
        caller: new Address(hexToBytes(from || '0x' + '11'.repeat(20))),
        origin: new Address(hexToBytes(from || '0x' + '11'.repeat(20))),
        data: hexToBytes(data || '0x'), gasLimit: 29000000n, block: mkBlock(),
      });
      return r;
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let reqs;
      try { reqs = JSON.parse(body); } catch (e) { res.end('{}'); return; }
      const one = !Array.isArray(reqs);
      const list = one ? [reqs] : reqs;
      const out = [];
      for (const r of list) out.push(await handle(r));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(one ? out[0] : out));
    });
  });

  async function handle(r) {
    const id = r.id, m = r.method, p = r.params || [];
    const ok = (v) => ({ jsonrpc: '2.0', id, result: v });
    const err = (msg) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: msg } });
    try {
      switch (m) {
        case 'eth_chainId': return ok('0x' + chainId.toString(16));
        case 'net_version': return ok(String(chainId));
        case 'hcow_isTestHarness': return harnessMarker ? ok(true) : err('unsupported method ' + m);
        // RoundSet 조회 재검 F5: 이 노드는 "다음에 쓸 블록 번호" 를 돌려준다. 실제 노드는
        // 마지막으로 채굴된 블록을 돌려준다. 그 차이 때문에 머리 블록을 빠뜨리는 버그가
        // 보이지 않았다. faithfulHead 로 켜면 실제 노드처럼 돌려준다. 기본값으로 바꾸지 않는
        // 이유: 이 노드는 새 블록을 스스로 만들지 않으므로, ethers 의 tx.wait() 가 캐시된
        // 옛 블록 번호로 확인 수 0 을 계산하면 오지 않을 다음 블록을 영원히 기다린다.
        case 'eth_blockNumber': return ok('0x' + headNum().toString(16));
        case 'eth_gasPrice': return ok('0x1');
        case 'eth_getBalance': {
          const key = String(p[0]).toLowerCase();
          const v = Object.prototype.hasOwnProperty.call(balances, key) ? BigInt(balances[key]) : 10n ** 18n;
          return ok('0x' + v.toString(16));
        }
        case 'eth_getCode': {
          const a = new Address(hexToBytes(p[0]));
          const c = await vm.stateManager.getContractCode(a);
          return ok(bytesToHex(c));
        }
        case 'eth_getTransactionCount': {
          const a = new Address(hexToBytes(p[0]));
          const acct = await vm.stateManager.getAccount(a);
          return ok('0x' + (acct ? acct.nonce : 0n).toString(16));
        }
        case 'eth_getBlockByNumber': {
          return ok({
            number: '0x' + headNum().toString(16),
            hash: '0x' + '22'.repeat(32), parentHash: '0x' + '00'.repeat(32),
            timestamp: '0x' + ts.toString(16), gasLimit: '0x1c9c380', gasUsed: '0x0',
            miner: '0x' + '00'.repeat(20), extraData: '0x', transactions: [],
            difficulty: '0x0', nonce: '0x0000000000000000',
          });
        }
        case 'eth_call': {
          const c = p[0];
          // runCall mutates the state manager, so an eth_call has to be
          // bracketed or a staticCall would silently persist.
          await vm.stateManager.checkpoint();
          let rr;
          try { rr = await api.callRaw(c.to, c.data, c.from); }
          finally { await vm.stateManager.revert(); }
          if (rr.execResult.exceptionError) {
            const d = bytesToHex(rr.execResult.returnValue || new Uint8Array());
            return { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: d } };
          }
          return ok(bytesToHex(rr.execResult.returnValue));
        }
        case 'eth_estimateGas': return ok('0x' + (8000000).toString(16));
        case 'eth_sendRawTransaction': {
          const tx = TransactionFactory.fromSerializedData(hexToBytes(p[0]), { common });
          const rr = await vm.runTx({ tx, block: mkBlock(), skipBalance: true, skipBlockGasLimitValidation: true, skipNonce: false });
          const hash = bytesToHex(tx.hash());
          const created = rr.createdAddress ? rr.createdAddress.toString() : null;
          receipts.set(hash, {
            transactionHash: hash, transactionIndex: '0x0',
            blockHash: '0x' + '22'.repeat(32), blockNumber: '0x' + blockNumber.toString(16),
            from: tx.getSenderAddress().toString(), to: tx.to ? tx.to.toString() : null,
            cumulativeGasUsed: '0x' + rr.totalGasSpent.toString(16),
            gasUsed: '0x' + rr.totalGasSpent.toString(16),
            contractAddress: created, logs: (rr.execResult.logs || []).map((l, i) => ({
              address: bytesToHex(l[0]), topics: l[1].map(bytesToHex), data: bytesToHex(l[2]),
              blockNumber: '0x' + blockNumber.toString(16), transactionHash: hash,
              transactionIndex: '0x0', blockHash: '0x' + '22'.repeat(32), logIndex: '0x' + i.toString(16), removed: false,
            })),
            logsBloom: '0x' + '00'.repeat(256),
            status: rr.execResult.exceptionError ? '0x0' : '0x1',
            type: '0x0', effectiveGasPrice: '0x1',
          });
          blockNumber += 1n;
          if (rr.execResult.exceptionError) {
            const d = bytesToHex(rr.execResult.returnValue || new Uint8Array());
            return { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: d } };
          }
          return ok(hash);
        }
        case 'eth_getTransactionReceipt': return ok(receipts.get(p[0]) || null);
        case 'eth_getLogs': {
          if (logFailEvery && ++getLogsCalls % logFailEvery === 0) return err('temporarily unavailable, try again');
          const q = p[0] || {};
          const num = (v, dflt) => (v === undefined || v === 'latest' || v === 'pending' || v === 'safe' || v === 'finalized')
            ? dflt : v === 'earliest' ? 0n : BigInt(v);
          const last = blockNumber - 1n;
          const from = num(q.fromBlock, last), to = num(q.toBlock, last);
          if (logRangeLimit && to - from + 1n > BigInt(logRangeLimit)) {
            return err(`block range too large: ${to - from + 1n} > ${logRangeLimit}`);
          }
          const addrs = q.address ? (Array.isArray(q.address) ? q.address : [q.address]).map((a) => a.toLowerCase()) : null;
          const t0 = q.topics && q.topics[0] ? (Array.isArray(q.topics[0]) ? q.topics[0] : [q.topics[0]]).map((t) => t.toLowerCase()) : null;
          const out = [];
          for (const rc of receipts.values()) {
            if (rc.status !== '0x1') continue;
            const bn = BigInt(rc.blockNumber);
            if (bn < from || bn > to || hidden.has(bn)) continue;
            for (const l of rc.logs) {
              if (addrs && !addrs.includes(l.address.toLowerCase())) continue;
              if (t0 && !t0.includes(String(l.topics[0]).toLowerCase())) continue;
              out.push(l);
            }
          }
          return ok(out);
        }
        case 'eth_getTransactionByHash': {
          const rc = receipts.get(p[0]);
          if (!rc) return ok(null);
          return ok({ hash: p[0], blockHash: rc.blockHash, blockNumber: rc.blockNumber, from: rc.from, to: rc.to,
            gas: '0x0', gasPrice: '0x1', input: '0x', nonce: '0x0', value: '0x0', type: '0x0', chainId: '0x' + chainId.toString(16) });
        }
        default: return err('unsupported method ' + m);
      }
    } catch (e) { return err(String(e && e.message || e)); }
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api.port = server.address().port;
  api.url = `http://127.0.0.1:${api.port}`;
  api.close = () => server.close();
  return api;
}

module.exports = { makeNode, art };
