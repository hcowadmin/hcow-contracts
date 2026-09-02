'use strict';
// Independently recomputes the four commitments HCOWVesting takes in its
// constructor, from a schedule file.
//
//   node scripts/commitcheck.cjs schedule/testnet.json
//
// WHY A SECOND IMPLEMENTATION EXISTS.
//
// The four constructor commitments are the only thing standing between a
// mistyped allocation table and a permanently wrong vesting contract. They
// cannot be corrected: expectedScheduleHash is immutable, seal() checks the
// loaded table against it, and a table that cannot satisfy it can never be
// sealed, which means release() is closed forever and there is no sweep.
//
// Computing them once and pasting the answer into the deployment is therefore
// checking your own arithmetic with your own arithmetic. This file exists to
// be a different arithmetic. It shares no code with `vestcommit.cjs`:
//
//   vestcommit.cjs   ethers.solidityPackedKeccak256, @noble/hashes internally
//   this file        bytes assembled by hand, hashed with js-sha3
//
// If the two agree, the packing rules and the keccak implementation have both
// been checked by something that could have disagreed. If they disagree, one
// of them is wrong and nothing should be deployed until it is known which.
//
// THE PACKING RULE THIS FILE ENCODES, WRITTEN OUT.
//
// The contract computes, for each row in order:
//
//   scheduleHash = keccak256(abi.encodePacked(
//       scheduleHash,   // bytes32, 32 bytes
//       beneficiary,    // address, 20 bytes
//       total,          // uint128, 16 BYTES  <-- not 32
//       tgeBps,         // uint16,   2 bytes
//       cliffMonths,    // uint16,   2 bytes
//       linearMonths    // uint16,   2 bytes
//   ));                 // 74 bytes total
//
// `total` being uint128 is the trap. abi.encodePacked writes a uint128 as
// sixteen bytes; computing the same value at 256 bits produces a completely
// different hash, the constructor accepts it because it accepts any non-zero
// bytes32, and the mistake surfaces only when seal() reverts CommitmentMismatch
// against a contract that is already funded.

const fs = require('fs');
const path = require('path');
const { keccak_256 } = require('js-sha3');

const BPS = 10_000n;

const MONTH = 30n * 24n * 60n * 60n;

/**
 * Mirrors HCOWVesting._vestedAt(schedule, ts) exactly, including its integer
 * truncation, so a JS answer and a Solidity answer can be compared for
 * equality rather than for closeness.
 *
 * Months are 30 days. That is a contract constant, not a calendar.
 */
function vestedAt(row, tgeTime, ts) {
  const total = BigInt(row.total);
  const t = BigInt(ts);
  const tge = BigInt(tgeTime);
  if (t < tge) return 0n;

  const tgeAmount = (total * BigInt(row.tgeBps)) / BPS;
  const remainder = total - tgeAmount;
  if (remainder === 0n) return total;

  const cliffEnd = tge + BigInt(row.cliffMonths) * MONTH;
  if (t < cliffEnd) return tgeAmount;

  const duration = BigInt(row.linearMonths) * MONTH;
  if (duration === 0n) return total;

  const elapsed = t - cliffEnd;
  if (elapsed >= duration) return total;

  return tgeAmount + (remainder * elapsed) / duration;
}

/** _vestedAt at exactly tgeTime, which is what seal() commits to. */
function tgeUnlockOf(total, tgeBps, cliffMonths, linearMonths) {
  return vestedAt({ total, tgeBps, cliffMonths, linearMonths }, 0, 0);
}

const hexToBytes = (hex) => {
  const h = hex.replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};

/** Big-endian, exactly `width` bytes, refusing anything that does not fit. */
function uintBytes(value, width) {
  let v = BigInt(value);
  if (v < 0n) throw new Error(`negative value ${value}`);
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`value ${value} does not fit in ${width} bytes`);
  return out;
}

function addressBytes(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`not an address: ${addr}`);
  return hexToBytes(addr);
}

function commitments(rows) {
  let hash = new Uint8Array(32); // bytes32(0)
  let total = 0n;
  let unlock = 0n;

  for (const [i, r] of rows.entries()) {
    const t = BigInt(r.total);
    if (t === 0n) throw new Error(`row ${i} (${r.label}) has a zero total`);
    const buf = new Uint8Array(74);
    buf.set(hash, 0);
    buf.set(addressBytes(r.beneficiary), 32);
    buf.set(uintBytes(t, 16), 52);            // uint128
    buf.set(uintBytes(r.tgeBps, 2), 68);      // uint16
    buf.set(uintBytes(r.cliffMonths, 2), 70); // uint16
    buf.set(uintBytes(r.linearMonths, 2), 72);// uint16
    hash = hexToBytes(keccak_256(buf));
    total += t;
    unlock += tgeUnlockOf(t, r.tgeBps, r.cliffMonths, r.linearMonths);
  }

  return {
    count: BigInt(rows.length),
    total,
    unlock,
    hash: '0x' + Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

function loadSchedule(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = raw.rows || raw;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${file} has no rows`);

  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    for (const k of ['beneficiary', 'total', 'tgeBps', 'cliffMonths', 'linearMonths']) {
      if (r[k] === undefined) throw new Error(`row ${i} is missing ${k}`);
    }
    const key = String(r.beneficiary).toLowerCase();
    // addSchedule reverts ScheduleExists on a duplicate, which would abort the
    // load halfway with part of the table written and no way to remove rows
    // except replaceTable. Cheaper to find here.
    if (seen.has(key)) throw new Error(`duplicate beneficiary ${r.beneficiary} at row ${i}`);
    seen.add(key);
  }
  return { meta: raw.meta || {}, rows };
}

module.exports = { commitments, tgeUnlockOf, vestedAt, loadSchedule, MONTH };

if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, '..', 'schedule', 'testnet.json');
  const { meta, rows } = loadSchedule(file);
  const c = commitments(rows);
  const E = 10n ** 18n;
  const tok = (v) => (v / E).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  console.log(`schedule  ${path.relative(process.cwd(), file)}`);
  if (meta.name) console.log(`name      ${meta.name}`);
  console.log('');
  console.log('  #  allocation              tokens        TGE%   cliff  linear   beneficiary');
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)} ${String(r.label || '').padEnd(22)} ` +
      `${tok(BigInt(r.total)).padStart(12)}  ${(Number(r.tgeBps) / 100).toFixed(2).padStart(6)}  ` +
      `${String(r.cliffMonths).padStart(5)}  ${String(r.linearMonths).padStart(6)}   ${r.beneficiary}`);
  });

  console.log('\nCONSTRUCTOR COMMITMENTS');
  console.log(`  expectedBeneficiaries  ${c.count}`);
  console.log(`  expectedScheduled      ${c.total}        (${tok(c.total)} HCOW)`);
  console.log(`  expectedTgeUnlock      ${c.unlock}        (${tok(c.unlock)} HCOW)`);
  console.log(`  expectedScheduleHash   ${c.hash}`);
  console.log('\nComputed with js-sha3 and hand-packed bytes, independently of');
  console.log('vestcommit.cjs. scripts/deploy.cjs recomputes with ethers and refuses');
  console.log('to deploy unless both agree, so pass these through:');
  console.log('');
  console.log(`  export EXPECT_BENEFICIARIES=${c.count}`);
  console.log(`  export EXPECT_SCHEDULED=${c.total}`);
  console.log(`  export EXPECT_TGE_UNLOCK=${c.unlock}`);
  console.log(`  export EXPECT_HASH=${c.hash}`);
}
