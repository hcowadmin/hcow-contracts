'use strict';
/**
 * Merkle tree construction, in two deliberately independent implementations.
 *
 * The spec's last tree-building check is "recompute the root by an independent
 * second path and compare", and the reason it is spelled out is that running
 * the same function twice is not a check. So there are two of everything here:
 *
 *   path A   js-sha3 keccak on Buffers, iterative, level by level, pairs
 *            ordered by Buffer.compare
 *   path B   ethers keccak on hex strings, recursive, pairs ordered by
 *            BigInt comparison
 *
 * They share no code and no library below this file. What they do share is the
 * tree's shape, which has to be identical or the comparison is meaningless:
 *
 *   - leaf = keccak256(abi.encodePacked(uint256 roundId, uint256 index,
 *            address account, uint256 amount)), matching HCOWClaim._claim
 *   - internal node = keccak256(min(a,b) || max(a,b)), matching OpenZeppelin
 *     MerkleProof, which sorts each pair so a proof needs no direction bits
 *   - an odd node at the end of a level is promoted to the next level unpaired
 *
 * A third function, verifyProof, replays a proof from a leaf back up to a root
 * using neither tree builder. Checking every leaf's proof against the root is
 * the second independent derivation, and unlike a rebuild it also proves the
 * proofs that ship to the claim page are the proofs the contract will accept.
 */

const { keccak_256 } = require('js-sha3');
const { ethers } = require('ethers');

// ------------------------------------------------------------------ path A

const u256 = (v) => {
  const b = Buffer.alloc(32);
  let x = BigInt(v);
  if (x < 0n) throw new Error('negative value in leaf preimage');
  for (let i = 31; i >= 0 && x > 0n; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  if (x > 0n) throw new Error('value does not fit in uint256');
  return b;
};

const addr20 = (a) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an address: ${a}`);
  return Buffer.from(a.slice(2), 'hex');
};

const kec = (buf) => Buffer.from(keccak_256.arrayBuffer(buf));

/** leaf hash, path A. */
function leafA(roundId, index, account, amount) {
  return kec(Buffer.concat([u256(roundId), u256(index), addr20(account), u256(amount)]));
}

/**
 * Every level of the tree, path A: leaves at [0], the single root at the end.
 *
 * rootA and proofA both used to walk the tree themselves, so building one
 * proof per leaf rebuilt the whole tree once per leaf. At the real size in
 * spec section 2 -- 20,571 recipients -- that is quadratic and does not
 * finish: the fourth adversarial audit (2026-09-18, B-3) measured 73 seconds
 * at n=4,000 and timed out on the real file. Walking once and keeping the
 * levels makes every proof a lookup.
 *
 * The shape is unchanged, and has to be: an odd node at the end of a level is
 * promoted unpaired, and each pair is ordered by Buffer.compare so that
 * OpenZeppelin's MerkleProof accepts a proof with no direction bits.
 */
function levelsA(leaves) {
  if (leaves.length === 0) throw new Error('cannot build a tree with no leaves');
  const levels = [leaves.slice()];
  let level = levels[0];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; } // odd one up
      const [a, b] = level[i].compare(level[i + 1]) <= 0
        ? [level[i], level[i + 1]]
        : [level[i + 1], level[i]];
      next.push(kec(Buffer.concat([a, b])));
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

/** root over leaf buffers, path A: iterative, Buffer.compare ordering. */
function rootA(leaves) {
  const levels = levelsA(leaves);
  return levels[levels.length - 1][0];
}

/**
 * Proof for one leaf index, from levels already built. A promoted odd node
 * contributes no sibling, which is why the proof length varies between leaves
 * of the same tree.
 */
function proofFromLevels(levels, index) {
  if (index < 0 || index >= levels[0].length) throw new Error(`index ${index} out of range`);
  const proof = [];
  let pos = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const level = levels[d];
    if (pos % 2 === 0 && pos + 1 < level.length) proof.push(level[pos + 1]);
    else if (pos % 2 === 1) proof.push(level[pos - 1]);
    pos = Math.floor(pos / 2);
  }
  return proof.map((p) => '0x' + p.toString('hex'));
}

/** Proof for one leaf index, path A. Builds the tree; prefer proofFromLevels. */
function proofA(leaves, index) {
  return proofFromLevels(levelsA(leaves), index);
}

// ------------------------------------------------------------------ path B

/** leaf hash, path B: ethers ABI packing rather than hand-built buffers. */
function leafB(roundId, index, account, amount) {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'uint256', 'address', 'uint256'],
    [BigInt(roundId), BigInt(index), ethers.getAddress(account), BigInt(amount)],
  );
}

const pairB = (x, y) => {
  const [a, b] = BigInt(x) <= BigInt(y) ? [x, y] : [y, x];
  return ethers.keccak256(ethers.concat([a, b]));
};

/** root over leaf hex strings, path B: recursive, BigInt ordering. */
function rootB(level) {
  if (level.length === 0) throw new Error('cannot build a tree with no leaves');
  if (level.length === 1) return level[0];
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(i + 1 === level.length ? level[i] : pairB(level[i], level[i + 1]));
  }
  return rootB(next);
}

// ------------------------------------------------------- independent replay

/** Replay a proof from leaf to root. Uses neither builder. */
function verifyProof(leafHex, proofHex, rootHex) {
  let h = leafHex.toLowerCase();
  for (const p of proofHex) {
    const q = p.toLowerCase();
    h = BigInt(h) <= BigInt(q)
      ? ethers.keccak256(ethers.concat([h, q]))
      : ethers.keccak256(ethers.concat([q, h]));
  }
  return h.toLowerCase() === rootHex.toLowerCase();
}

/**
 * Build one round's tree from entries [{ account, amount }].
 *
 * Entries are sorted by address first, so the index assigned to an account is
 * a function of the round's membership and nothing else: the same input file
 * in a different order produces the same tree, and a diff between two builds
 * shows what actually changed.
 *
 * Returns { roundId, root, rootB, count, total, claims } where claims is keyed
 * by checksummed address.
 */
function buildRound(roundId, entries) {
  const sorted = entries.slice().sort((x, y) =>
    BigInt(ethers.getAddress(x.account)) < BigInt(ethers.getAddress(y.account)) ? -1 : 1);

  const leavesA = [];
  const leavesB = [];
  const claims = {};
  let total = 0n;

  sorted.forEach((e, index) => {
    const account = ethers.getAddress(e.account);
    const amount = BigInt(e.amount);
    if (amount === 0n) throw new Error(`round ${roundId}: zero amount for ${account} reached the tree`);
    leavesA.push(leafA(roundId, index, account, amount));
    leavesB.push(leafB(roundId, index, account, amount));
    claims[account] = { index, amount: amount.toString(), proof: [] };
    total += amount;
  });

  const levels = levelsA(leavesA);
  const rA = '0x' + levels[levels.length - 1][0].toString('hex');
  const rB = rootB(leavesB);

  sorted.forEach((e, index) => {
    claims[ethers.getAddress(e.account)].proof = proofFromLevels(levels, index);
  });

  return {
    roundId,
    root: rA,
    rootSecondPath: rB,
    count: sorted.length,
    total: total.toString(),
    claims,
    leavesB,
  };
}

module.exports = { leafA, leafB, rootA, rootB, levelsA, proofA, proofFromLevels, verifyProof, buildRound };
