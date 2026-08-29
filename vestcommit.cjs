// Computes the four figures HCOWVesting now takes as constructor arguments.
//
// They used to be seal() arguments, which meant a test could read them straight
// back off the contract it had just loaded. That is exactly the self-referential
// form the audit flagged, so the helper deliberately derives them from the table
// instead, the same way the deployment runbook requires a human to.
const { ethers } = require('ethers');

const MONTH = 30n * 24n * 60n * 60n;
const BPS = 10_000n;
const ZERO32 = '0x' + '00'.repeat(32);

/** Mirrors HCOWVesting._vestedAt(schedule, tgeTime). */
function tgeUnlockOf(total, tgeBps, cliffMonths, linearMonths) {
  const tgeAmount = (total * BigInt(tgeBps)) / BPS;
  const remainder = total - tgeAmount;
  if (remainder === 0n) return total;
  if (BigInt(cliffMonths) > 0n) return tgeAmount;
  if (BigInt(linearMonths) === 0n) return total;
  return tgeAmount;
}

/**
 * @param rows [{ beneficiary, total, tgeBps, cliffMonths, linearMonths }]
 * @returns { count, total, unlock, hash }
 */
function commitments(rows) {
  let hash = ZERO32;
  let total = 0n;
  let unlock = 0n;
  for (const r of rows) {
    hash = ethers.solidityPackedKeccak256(
      ['bytes32', 'address', 'uint128', 'uint16', 'uint16', 'uint16'],
      [hash, r.beneficiary, r.total, r.tgeBps, r.cliffMonths, r.linearMonths]
    );
    total += r.total;
    unlock += tgeUnlockOf(r.total, r.tgeBps, r.cliffMonths, r.linearMonths);
  }
  return { count: BigInt(rows.length), total, unlock, hash };
}

module.exports = { commitments, tgeUnlockOf, ZERO32 };
