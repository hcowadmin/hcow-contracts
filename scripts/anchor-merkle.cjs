'use strict';
/**
 * Hourly anchor batches for HCOWAnchor.
 *
 * The fairness engine produces one roundHash per game round. This file groups
 * an hour of them into a Merkle tree and hands back a root, a leaf count and a
 * proof per round. Only the root goes on chain.
 *
 * The tree's shape is the one HCOWClaim already uses, for one reason: it is
 * what OpenZeppelin's MerkleProof verifies, so the on-chain side is an audited
 * library rather than cryptography written here.
 *
 *   leaf          keccak256(abi.encodePacked(bytes32 roundHash))
 *   internal      keccak256(min(a,b) || max(a,b))
 *   odd node      promoted to the next level unpaired
 *
 * A leaf hashes 32 bytes and an internal node hashes 64, so an internal node
 * cannot be replayed as a leaf. That is the whole of the second-preimage
 * argument, and it is why the leaf is not the roundHash itself.
 *
 * rootA and rootB are the two independent derivations from scripts/merkle.cjs
 * (js-sha3 on Buffers, iterative; ethers on hex strings, recursive). They share
 * no code below this file. Running one function twice is not a check.
 *
 * WHAT THIS FILE DOES NOT CLAIM
 *
 *   A root proves that the rounds in it were fixed before the anchoring
 *   transaction. It does not prove the batch holds every round of its hour.
 *   Nothing here, and nothing in HCOWAnchor, supports that stronger reading.
 */

const { keccak_256 } = require('js-sha3');
const { ethers } = require('ethers');
const { rootA, rootB, proofA, verifyProof } = require('./merkle.cjs');

const PERIOD = 3600;
const HASH64 = /^[0-9a-f]{64}$/;

/** leaf hash, path A: js-sha3 over the raw 32 bytes. */
function leafA(roundHash) {
  return Buffer.from(keccak_256.arrayBuffer(Buffer.from(roundHash, 'hex')));
}

/** leaf hash, path B: ethers over the same 32 bytes, as a hex string. */
function leafB(roundHash) {
  return ethers.keccak256('0x' + roundHash);
}

/**
 * Deterministic order: epochKey, then nonce, then roundHash.
 *
 * Sorting rather than trusting arrival order means the same hour rebuilt from
 * the same records gives the same root, whatever order the rows came out of
 * the store in. Grouping by epoch also puts a withheld round next to its
 * neighbours, where a gap in the nonce sequence is visible to a reader.
 */
function orderRecords(records) {
  return records.slice().sort((x, y) => {
    if (x.epochKey !== y.epochKey) return x.epochKey < y.epochKey ? -1 : 1;
    if (x.nonce !== y.nonce) return x.nonce - y.nonce;
    return x.roundHash < y.roundHash ? -1 : (x.roundHash > y.roundHash ? 1 : 0);
  });
}

/**
 * The two self-checks, pulled out so they can be tested.
 *
 * A consistency check that only fires when something else is already broken
 * cannot be tested with correct input: with rA === rB and every proof valid,
 * deleting the check changes nothing observable, and a mutation of it survives.
 * Both of these survived exactly that way on 2026-09-16. Exported and called
 * from buildBatch, they can be handed the inconsistency they exist to catch.
 */
function assertRootsAgree(rA, rB) {
  if (typeof rA !== 'string' || typeof rB !== 'string') {
    throw new Error('roots must be hex strings');
  }
  if (rA.toLowerCase() !== rB.toLowerCase()) {
    throw new Error(`root mismatch between independent paths: ${rA} vs ${rB}`);
  }
}

function assertProofVerifies(leafHex, proof, root, label) {
  if (!verifyProof(leafHex, proof, root)) {
    throw new Error(`proof for ${label} does not verify against the root`);
  }
}

/**
 * Build one hour's batch.
 *
 * Every guard below exists because the failure it prevents is invisible
 * downstream: on chain one root looks exactly like another, so a batch built
 * from bad input produces a root that is wrong in a way nothing afterwards can
 * detect. They are asserted in test/anchor-merkle.test.cjs by feeding each one
 * the input it exists to reject, in test/HCOWAnchor.test.cjs section 1.
 *
 * @param {number} periodStart aligned unix second
 * @param {Array<{roundHash:string, epochKey:string, nonce:number}>} records
 */
function buildBatch(periodStart, records) {
  if (!Number.isSafeInteger(periodStart) || periodStart <= 0) {
    throw new Error('periodStart must be a positive safe integer');
  }
  if (periodStart % PERIOD !== 0) {
    throw new Error(`periodStart ${periodStart} is not aligned to ${PERIOD}s`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('cannot anchor an empty batch');
  }

  const seenRound = new Set();
  const seenSlot = new Set();

  for (const r of records) {
    if (!r || typeof r !== 'object') throw new Error('record is not an object');
    if (typeof r.roundHash !== 'string' || !HASH64.test(r.roundHash)) {
      throw new Error(`roundHash must be 64 lowercase hex chars: ${JSON.stringify(r.roundHash)}`);
    }
    if (typeof r.epochKey !== 'string' || !HASH64.test(r.epochKey)) {
      throw new Error(`epochKey must be 64 lowercase hex chars: ${JSON.stringify(r.epochKey)}`);
    }
    if (!Number.isSafeInteger(r.nonce) || r.nonce < 0) {
      throw new Error(`nonce must be a non-negative safe integer: ${JSON.stringify(r.nonce)}`);
    }
    // A repeated roundHash means the same round was submitted twice. It would
    // not corrupt the root, but it inflates leafCount, and leafCount is what a
    // reader uses to reason about how much of an hour a batch covers.
    if (seenRound.has(r.roundHash)) throw new Error(`duplicate roundHash ${r.roundHash}`);
    seenRound.add(r.roundHash);
    // Two different roundHashes for one (epochKey, nonce) means one round was
    // played twice with different arguments. Exactly one of them is the real
    // one and this file cannot tell which.
    const slot = `${r.epochKey}:${r.nonce}`;
    if (seenSlot.has(slot)) throw new Error(`duplicate epoch slot ${slot}`);
    seenSlot.add(slot);
  }

  const ordered = orderRecords(records);
  const leavesA = ordered.map((r) => leafA(r.roundHash));
  const leavesB = ordered.map((r) => leafB(r.roundHash));

  const rA = '0x' + rootA(leavesA).toString('hex');
  const rB = rootB(leavesB);
  assertRootsAgree(rA, rB);

  // Third derivation: replay every proof from its leaf back to the root with
  // neither tree builder. This also proves the proofs handed to the
  // verification page are the proofs the contract will accept.
  const rounds = ordered.map((r, index) => {
    const proof = proofA(leavesA, index);
    assertProofVerifies(leafB(r.roundHash), proof, rA, r.roundHash);
    return { roundHash: r.roundHash, epochKey: r.epochKey, nonce: r.nonce, index, proof };
  });

  return {
    periodStart,
    root: rA,
    rootSecondPath: rB,
    leafCount: ordered.length,
    rounds,
  };
}

/**
 * 라운드 해시가 이 루트 안에 있는가. **이것이 공개 검증 진입점이다.**
 *
 * 3차 감사 A-5. 이 모듈이 지금까지 내보낸 유일한 검증 함수는 `verifyProof` 인데,
 * 그것은 **이미 해싱된 잎** 을 받아 아무 래핑도 하지 않는다. 그래서 내부 노드를
 * 잎인 척 넣으면 그대로 true 가 나온다:
 *
 *   verifyProof(internalNode, lift, root)          -> true   (위조 성립)
 *   verifyProof(leafOf(internalNode), lift, root)  -> false  (컨트랙트 경로)
 *
 * 온체인 `verifyRound()` 는 `leafOf()` 로 먼저 해싱하므로 32 vs 64 바이트 길이
 * 분리가 성립해 안전하다. 오프체인만 그 방어가 없었다. 검증 페이지나 외부
 * 도구를 `verifyProof` 위에 올리면 2차 역상 방어가 0 이 된다.
 *
 * 그래서 컨트랙트와 같은 일을 하는 함수를 따로 내보낸다.
 * **외부 코드는 verifyProof 가 아니라 이것을 쓴다.**
 */
function verifyRound(roundHash, proof, root) {
  if (typeof roundHash !== 'string' || !HASH64.test(roundHash)) {
    throw new Error('roundHash must be 64 lowercase hex chars (no 0x)');
  }
  return verifyProof(leafB(roundHash), proof, root);
}

module.exports = {
  PERIOD, leafA, leafB, orderRecords, buildBatch,
  verifyRound,
  // 잎 수준 원시 함수. roundHash 를 받지 않는다. 외부에서 쓰지 말 것 — verifyRound 를 쓴다.
  verifyProof,
  assertRootsAgree, assertProofVerifies,
};
