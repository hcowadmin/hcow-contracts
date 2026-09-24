'use strict';
/**
 * Builds the per-round Merkle trees for the Community/Airdrop distribution,
 * and refuses to write anything it cannot prove correct first.
 *
 *   node scripts/build-merkle.cjs <recipients.csv|.json> \
 *        --policy schedule/airdrop-policy.json \
 *        --expect-total <announced total, in wei or decimal HCOW>
 *        [--tge <unix seconds>] [--out build/merkle]
 *
 * WHY THIS FILE IS LONGER THAN THE CONTRACT
 *
 * HCOWClaim verifies one thing, that a leaf is in a root. Everything that
 * decides what the leaves are happens here, unreviewed by the chain, and a
 * wrong number here is indistinguishable on-chain from a right one. So every
 * check the spec lists runs before any output exists, and a failure stops the
 * run rather than printing a warning somebody reads later:
 *
 *   1  every address is a valid EIP-55 checksummed address
 *   2  no address appears twice
 *   3  rows with a zero total are dropped, and no zero amount reaches a tree
 *   4  each account's round amounts sum to exactly its input total
 *   5  the sum over every round equals the input file's total
 *   6  cumulative demand through round n never exceeds what HCOWVesting will
 *      have released into the claim contract by round n's start
 *   7  each root is computed twice by two independent implementations, and
 *      every proof is replayed to the root by a third
 *
 * NO UNLOCK RATIO IS WRITTEN IN THIS FILE. They come from the policy JSON,
 * because the spec says twice that they are not final. See
 * schedule/airdrop-policy.example.json.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { buildRound, leafB, verifyProof } = require('./merkle.cjs');

const BPS = 10_000n;

// ------------------------------------------------------------------- input

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new Error('the input file has no rows');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const need = ['account', 'category', 'totalamount'];
  for (const n of need) {
    if (!header.includes(n)) {
      throw new Error(`CSV header must contain ${need.join(', ')} — got: ${header.join(', ')}`);
    }
  }
  const col = Object.fromEntries(need.map((n) => [n, header.indexOf(n)]));

  return lines.slice(1).map((line, i) => {
    const f = line.split(',').map((v) => v.trim());
    return {
      line: i + 2,
      account: f[col.account],
      category: f[col.category],
      totalAmount: f[col.totalamount],
    };
  });
}

function loadRecipients(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.json')) {
    const j = JSON.parse(text);
    const rows = Array.isArray(j) ? j : j.rows;
    if (!Array.isArray(rows)) throw new Error(`${file}: expected an array, or an object with a "rows" array`);
    return rows.map((r, i) => ({ line: i + 1, account: r.account, category: r.category, totalAmount: r.totalAmount }));
  }
  return parseCsv(text);
}

// 7차 감사 M-8. 카테고리 쪽은 tgeBps/tailRounds 의 범위를 검사하는데 bucket 쪽은
// 키의 존재만 봤다. bucket.tgeBps: 99999 한 글자로 vestedAt(TGE) 가 버킷 총액의
// 10배를 돌려주고, check 6("베스팅이 풀기 전에 배포하지 않는다")이 통째로
// 무력화된다 — 확인한다고 주장하면서 아무것도 확인하지 않는 검사가 된다.
// 정책 파일은 손으로 편집하는 파일이고 예시 자신이 "복사해서 합의된 숫자를
// 채워 넣으라" 고 지시한다. 오타 하나가 여기서 멈춰야 한다.
//
// loadPolicy 와 buildDistribution 양쪽에서 부른다. monthSeconds 검사가 이미
// 같은 이유로 두 곳에 있다: buildDistribution 은 테스트와 메모리상 정책 객체가
// 직접 호출하는 진입점이고, 파일을 거치지 않는다.
// 7차 감사 M-1. 빌더도 set-root 도 minClaimAmount 라는 단어를 몰랐다(양쪽 grep 0건).
// 컨트랙트의 바닥값이 어떤 리프보다 높으면 그 리프는 루트가 동결되는 순간
// 영구 청구 불가다. 대표 결정으로 빌더가 대조하고 중단한다.
//
// 8차 감사 M-3 정정. 7차에 여기 적었던 "round 0 에 1 HCOW 미만 229개, 합 192.19"
// 는 틀린 숫자였다. 아무도 재현하지 않았고, 재현하니 세 번 재서 세 번 달랐다.
// 아래가 실제 빌더를 실입력으로 돌려 나온 값이고, 재현 절차를 같이 적는다.
//
//   입력   TaskOn 리더보드 원본, 포인트 보유 1,291명 / 235,410점
//          그중 Primary EVM 주소 보유 1,205명 / 224,435점 (중복 주소 0건)
//   배분   100,000 HCOW 풀 비례, 계정별 floor
//   정책   schedule/airdrop-policy.example.json 의 taskon (tgeBps 2000, tailRounds 4)
//
//   round 0      1 HCOW 미만 520개, 합 234.909307166220635891 HCOW
//   round 1~4    각 520개, 각 약 234.9093 HCOW
//   전체 5라운드 2,600개, 합 1,174.546535831103181502 HCOW
//   최소 리프    0.424790790535661186 HCOW  (5점 보유자)
//
// 최소 리프가 0.42 HCOW 인 이유는 리더보드 최저 점수가 5점이고 라운드가 다섯이라
// 한 라운드당 1점 몫이 돌아가기 때문이다. 바닥값을 1 HCOW 로 잡으면 2,600개
// 리프가 영구 청구 불가가 된다.
function assertFloor(v) {
  if (v === undefined || v === null) return 0n;
  const raw = String(v).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `policy.minClaimAmount "${v}" must be an integer number of wei, written as a string. ` +
      'It is compared against leaf amounts, which are wei.');
  }
  return BigInt(raw);
}

function assertBucket(b) {
  if (!/^\d+$/.test(String(b.total).trim())) {
    throw new Error(`policy.bucket.total "${b.total}" must be an integer number of wei, written as a string`);
  }
  if (BigInt(String(b.total).trim()) === 0n) {
    throw new Error('policy.bucket.total is 0, so check 6 would pass on any tree at all');
  }
  const bps = Number(b.tgeBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error(
      `policy.bucket.tgeBps must be 0..10000, got ${b.tgeBps}. Out of range it makes vestedAt ` +
      'return more than the bucket holds, and check 6 then passes on any tree.');
  }
  for (const k of ['cliffMonths', 'linearMonths']) {
    const v = Number(b[k]);
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`policy.bucket.${k} must be a non-negative integer, got ${b[k]}`);
    }
  }
  // 8차 감사 H-4. 이 함수가 linearMonths 를 "비음수 정수" 로만 봤다. 0 이 통과하면
  // vestedAt 의 `if (duration === 0n) return total;` 때문에 TGE 시점에 버킷 전액이
  // 풀린 것으로 계산되고, check 6("베스팅이 풀기 전에 배포하지 않는다")이 통째로
  // 무력화된다. 이 가드가 이름을 대놓고 검사하는 필드로 그 검사를 끌 수 있었다.
  //
  // tgeBps 가 10000 이면 TGE 에 전액 언락이 맞고 그때는 linearMonths 가 의미를
  // 갖지 않는다. 그 하나만 예외다.
  if (bps < 10000 && Number(b.linearMonths) === 0) {
    throw new Error(
      `policy.bucket.linearMonths is 0 while tgeBps is ${bps}, which is a contradiction: the bucket ` +
      'says only part of it unlocks at TGE and then says the rest takes no time. vestedAt returns the ' +
      'whole bucket at TGE for a zero duration, so check 6 would pass on any tree at all. ' +
      'Use linearMonths >= 1, or tgeBps 10000 if the bucket really is fully unlocked at TGE.');
  }
}

function loadPolicy(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));

  const month = Number(p.monthSeconds);
  // HCOWVesting.MONTH is 30 days and the round boundaries have to land on the
  // same grid, or a round opens while the tokens funding it are still vesting.
  if (month !== 30 * 24 * 60 * 60) {
    throw new Error(`policy monthSeconds is ${month}; it must be 2592000, the 30-day month HCOWVesting uses`);
  }
  if (!p.categories || !Object.keys(p.categories).length) throw new Error('policy has no categories');

  for (const [key, c] of Object.entries(p.categories)) {
    const bps = Number(c.tgeBps), tail = Number(c.tailRounds);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error(`category ${key}: tgeBps must be 0..10000`);
    if (!Number.isInteger(tail) || tail < 0) throw new Error(`category ${key}: tailRounds must be a non-negative integer`);
    if (tail === 0 && bps !== 10000) {
      throw new Error(
        `category ${key}: tgeBps ${bps} with tailRounds 0 strands ${(10000 - bps) / 100}% of every ` +
        `recipient's balance in no round at all. Either pay it all at TGE or give it tail rounds.`);
    }
  }

  const b = p.bucket || {};
  for (const k of ['total', 'tgeBps', 'cliffMonths', 'linearMonths']) {
    if (b[k] === undefined) throw new Error(`policy.bucket.${k} is required; it is what check 6 measures against`);
  }
  assertBucket(b);
  assertFloor(p.minClaimAmount);
  return p;
}

// ------------------------------------------------------------ the unlocking

/**
 * Split one account's total across rounds according to its category.
 *
 * The remainder of the integer division goes to the last round, so the parts
 * always sum to the whole however the ratio divides. Check 4 re-proves it per
 * account rather than trusting this.
 */
function split(total, cat, dustThreshold) {
  const tail = Number(cat.tailRounds);
  if (tail === 0) return { amounts: [total], consolidated: false };

  const tge = (total * BigInt(cat.tgeBps)) / BPS;
  const rest = total - tge;
  const per = rest / BigInt(tail);

  const amounts = new Array(tail + 1).fill(0n);
  amounts[0] = tge;
  for (let i = 1; i < tail; i++) amounts[i] = per;
  amounts[tail] = rest - per * BigInt(tail - 1);

  // Spec 4-3, option 1: a recipient whose per-round share would cost more in
  // gas than it is worth gets the whole balance in round 0 instead. The
  // threshold is a policy value and defaults to zero, which disables this.
  if (dustThreshold > 0n && amounts.some((a) => a > 0n && a < dustThreshold)) {
    return { amounts: [total], consolidated: true };
  }
  return { amounts, consolidated: false };
}

/** HCOWVesting._vestedAt, reimplemented for the airdrop bucket only. */
function vestedAt(bucket, tgeTime, ts, month) {
  const total = BigInt(bucket.total);
  if (ts < tgeTime) return 0n;
  const tge = (total * BigInt(bucket.tgeBps)) / BPS;
  const rest = total - tge;
  if (rest === 0n) return total;
  const cliffEnd = tgeTime + Number(bucket.cliffMonths) * month;
  if (ts < cliffEnd) return tge;
  const duration = BigInt(Number(bucket.linearMonths) * month);
  if (duration === 0n) return total;
  const elapsed = BigInt(ts - cliffEnd);
  if (elapsed >= duration) return total;
  return tge + (rest * elapsed) / duration;
}

// ------------------------------------------------------------------- build

/**
 * Normalise, validate, split, and build every round's tree.
 *
 * Throws on the first thing that is wrong. Returns
 * { rounds, dropped, consolidated, totalIn, warnings }.
 */
function buildDistribution(rawRows, policy, { tgeTime, expectTotal } = {}) {
  const month = Number(policy.monthSeconds);
  // loadPolicy checks this too. It is repeated here because buildDistribution
  // is also called directly by the tests and by anything that builds a policy
  // object in memory, and a calendar month silently shifts every round off the
  // grid HCOWVesting releases on.
  if (month !== 30 * 24 * 60 * 60) {
    throw new Error(`monthSeconds is ${month}; it must be 2592000, the 30-day month HCOWVesting uses`);
  }
  assertBucket(policy.bucket || {});
  const tge = Number(tgeTime ?? policy.tgeTime);
  if (!Number.isInteger(tge) || tge <= 0) {
    throw new Error('tgeTime is required, in unix SECONDS. Pass --tge or set it in the policy file.');
  }
  const dust = BigInt(policy.dustThreshold ?? 0);

  // ---- check 1, 2, 3: addresses, duplicates, zero rows ------------------
  const seen = new Map();
  const rows = [];
  const dropped = [];
  let totalIn = 0n;

  for (const r of rawRows) {
    const where = `row ${r.line}`;
    if (!r.account) throw new Error(`${where}: missing account`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.account)) throw new Error(`${where}: ${r.account} is not a 20-byte address`);

    let account;
    try {
      account = ethers.getAddress(r.account);
    } catch (_) {
      throw new Error(`${where}: ${r.account} fails its EIP-55 checksum. A mistyped address that passes as lowercase is a payment to nobody.`);
    }
    if (r.account !== account) {
      throw new Error(
        `${where}: ${r.account} is not checksummed. Expected ${account}. ` +
        'Checksums are the only thing standing between a typo and a burn, so they are required, not normalised away.');
    }
    // 7차 감사 H-6. 영 주소는 전부 0이라 대문자가 없고, 그래서 EIP-55 검사를
    // 통과한다. 트리에 들어가면 그 리프는 ERC20 의 zero-receiver 거부로 영구히
    // 리버트하고 isClaimed 도 찍히지 않는다. 풀이 고정이므로 그 지분만큼
    // 진짜 수취인들이 받지 못한다. 재현 확인: 500 HCOW 리프가 수락됐고
    // 빌더는 "grand total exact" 를 출력했다.
    if (account === ethers.ZeroAddress) {
      throw new Error(
        `${where}: the zero address is not a recipient. It passes the EIP-55 check because it has ` +
        'no uppercase to get wrong, and the leaf it produces can never be claimed: ERC20 refuses a ' +
        'zero receiver, so the claim reverts forever and that share is lost to the real recipients.');
    }
    const prev = seen.get(account);
    if (prev) {
      throw new Error(
        `${where}: ${account} already appeared at row ${prev}. One row per address. ` +
        'Two rows means two leaves in the same round and two claims against one entitlement; ' +
        'merge them upstream into a single row with a single category.');
    }
    seen.set(account, r.line);

    // 7차 감사 H-7. String() 을 먼저 하면 JSON 숫자형이 이미 IEEE754 로
    // 뭉개진 뒤라 그 다음의 어떤 검사도 소용이 없다. 재현 확인:
    // 2123953952678305934 -> "2123953952678306000" (+66 wei), 검사 7개 전부 통과.
    // 위험 구간이 정확히 1e18~1e21, 즉 개인 배분 금액대다. 작은 값도 예외를
    // 두지 않는다 — 두면 "작은 값은 괜찮다" 를 배우게 되고 큰 값에서 조용히 틀린다.
    if (typeof r.totalAmount === 'number') {
      throw new Error(
        `${where}: totalAmount is a JSON number (${r.totalAmount}). Write it as a quoted string. ` +
        'A number above 2^53 has already lost its exact value before this script sees it, and wei ' +
        'amounts in this distribution are around 1e18 to 1e21, so the loss lands exactly on the ' +
        'per-person figures.');
    }
    const raw = String(r.totalAmount ?? '').trim();
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${where}: totalAmount "${r.totalAmount}" must be an integer number of wei — no decimal point, no units, no separators`);
    }
    const total = BigInt(raw);
    if (total === 0n) { dropped.push({ account, line: r.line }); continue; }

    const key = String(r.category ?? '').trim();
    const cat = policy.categories[key];
    if (!cat) {
      throw new Error(`${where}: unknown category "${key}". The policy file defines: ${Object.keys(policy.categories).join(', ')}`);
    }
    rows.push({ account, category: key, cat, total });
    totalIn += total;
  }
  if (!rows.length) throw new Error('every row was dropped or empty; there is nothing to distribute');

  // ---- split ------------------------------------------------------------
  const roundCount = Math.max(...rows.map((r) => Number(r.cat.tailRounds) + 1));
  const buckets = Array.from({ length: roundCount }, () => []);
  const consolidated = [];
  const warnings = [];

  for (const r of rows) {
    const { amounts, consolidated: c } = split(r.total, r.cat, dust);
    if (c) consolidated.push(r.account);

    // ---- check 4: the parts sum to the whole, per account ---------------
    const sum = amounts.reduce((a, b) => a + b, 0n);
    if (sum !== r.total) {
      throw new Error(`${r.account}: round amounts sum to ${sum} but its total is ${r.total}`);
    }
    // ---- check 3 again: no zero reaches a tree --------------------------
    amounts.forEach((amt, roundId) => {
      if (amt > 0n) buckets[roundId].push({ account: r.account, amount: amt });
    });
    if (dust > 0n && r.total < dust) {
      warnings.push(`${r.account} has ${r.total} wei in total, below the ${dust} wei dust threshold; it is one round but still small`);
    }
  }

  // ---- trees, and check 7 -----------------------------------------------
  const rounds = [];
  let totalOut = 0n;

  for (let roundId = 0; roundId < roundCount; roundId++) {
    const entries = buckets[roundId];
    if (!entries.length) {
      warnings.push(`round ${roundId} has no recipients and is not registered`);
      rounds.push(null);
      continue;
    }
    const t = buildRound(roundId, entries);

    if (t.root.toLowerCase() !== t.rootSecondPath.toLowerCase()) {
      throw new Error(
        `round ${roundId}: the two independent root computations disagree.\n` +
        `  path A (js-sha3, iterative)  ${t.root}\n` +
        `  path B (ethers, recursive)   ${t.rootSecondPath}\n` +
        'Nothing has been written. One of them is wrong and neither may be trusted until you know which.');
    }
    for (const [account, c] of Object.entries(t.claims)) {
      const leaf = leafB(roundId, c.index, account, c.amount);
      if (!verifyProof(leaf, c.proof, t.root)) {
        throw new Error(`round ${roundId}: the proof generated for ${account} does not replay to the root`);
      }
    }

    totalOut += BigInt(t.total);
    rounds.push({
      roundId,
      startTime: tge + roundId * month,
      merkleRoot: t.root,
      // Path B's root, kept rather than discarded. (Audit 4, B-2.)
      //
      // Read this for what it is. The check above refuses to write anything
      // unless the two roots are equal, so whenever this field exists it
      // equals merkleRoot, and no reader can tell from the file alone whether
      // it was really computed by path B. It records that a second path ran;
      // it does not prove it. The proof of that is re-running the build, and
      // the claims in this file are what a reviewer re-runs it from.
      rootSecondPath: t.rootSecondPath,
      count: t.count,
      total: t.total,
      claims: t.claims,
    });
  }

  // ---- check 4, against the TREES this time ------------------------------
  //
  // The per-account check above compares split()'s output to split()'s input,
  // four lines apart. It is a real check of split() and no check at all of
  // what reached a leaf: the fourth adversarial audit (2026-09-18, B-1) swapped
  // two accounts' amounts between split() and the tree and all seven checks
  // passed, because check 5 only compares totals and totals were preserved.
  //
  // This reads the amounts back out of the built trees, which is the only
  // place the published proofs come from, and compares them per account.
  const paidByTrees = new Map();
  for (const r of rounds) {
    if (!r) continue;
    for (const [account, c] of Object.entries(r.claims)) {
      paidByTrees.set(account, (paidByTrees.get(account) || 0n) + BigInt(c.amount));
    }
  }
  const wrong = [];
  for (const r of rows) {
    const paid = paidByTrees.get(r.account) ?? 0n;
    if (paid !== r.total) wrong.push(`${r.account}: the trees pay ${paid} wei, the input says ${r.total} wei`);
    paidByTrees.delete(r.account);
  }
  for (const [account, amt] of paidByTrees) {
    wrong.push(`${account}: ${amt} wei across the trees and no row in the input at all`);
  }
  if (wrong.length) {
    throw new Error(
      `the trees do not pay what the input says, for ${wrong.length} account(s). Nothing has been written.\n  ` +
      wrong.slice(0, 20).join('\n  ') + (wrong.length > 20 ? `\n  ... and ${wrong.length - 20} more` : ''));
  }

  // ---- check 5: nothing created and nothing lost -------------------------
  //
  // Now redundant, and kept deliberately. The per-account check immediately
  // above compares every account's tree total against its input row and also
  // refuses any account in a tree with no row at all, which together force
  // these two sums to be equal -- deleting this leaves the suite green, and
  // that is why the note is here rather than the deletion. If the check above
  // is ever narrowed, this is the one that still catches a whole missing or
  // duplicated round, and nobody should remove it believing the other one
  // covers it. (Audit 4, B-1 and P07.)
  if (totalOut !== totalIn) {
    throw new Error(`the rounds distribute ${totalOut} wei but the input file totals ${totalIn} wei`);
  }

  // ---- check 6: the tokens are here before the round opens ---------------
  // The whole-bucket comparison comes first. It is the cruder of the two and
  // its message is the one that actually explains an over-allocated input,
  // whereas the per-round check would report the same file as a timing problem.
  if (totalIn > BigInt(policy.bucket.total)) {
    throw new Error(`the input totals ${totalIn} wei, more than the whole ${policy.bucket.label || 'bucket'} allocation of ${policy.bucket.total} wei`);
  }
  let cumulative = 0n;
  for (const r of rounds) {
    if (!r) continue;
    cumulative += BigInt(r.total);
    const available = vestedAt(policy.bucket, tge, r.startTime, month);
    if (cumulative > available) {
      throw new Error(
        `round ${r.roundId} opens at ${new Date(r.startTime * 1000).toISOString()} with ${cumulative} wei ` +
        `claimable in total by then, but HCOWVesting will only have released ${available} wei into the claim ` +
        'contract. The round would open on money that does not exist. Move demand later or reduce it.');
    }
    r.vestedByStart = available.toString();
    r.cumulative = cumulative.toString();
  }

  // ---- check 8. 바닥값 (7차 M-1) ----------------------------------------
  //
  // 리프 하나라도 컨트랙트의 바닥값보다 작으면 그 리프는 회차가 열리는 순간
  // 영구 청구 불가가 된다. 루트는 동결되고 트리로는 고칠 수 없다.
  const floor = assertFloor(policy.minClaimAmount);
  if (floor > 0n) {
    let below = 0, smallest = null, example = null;
    for (const r of rounds) {
      if (!r) continue;
      for (const [account, c] of Object.entries(r.claims)) {
        const amt = BigInt(c.amount);
        if (amt < floor) {
          below += 1;
          if (smallest === null || amt < smallest) { smallest = amt; example = `${account} in round ${r.roundId}`; }
        }
      }
    }
    if (below > 0) {
      throw new Error(
        `${below} leaf/leaves are below policy.minClaimAmount ${floor} wei. The smallest is ` +
        `${smallest} wei (${example}). A round's root freezes when it opens, so every one of those ` +
        'entries would be permanently unclaimable. Lower the floor, consolidate those recipients ' +
        'into a single round, or raise their amounts. Nothing has been written.');
    }
  }

  // ---- check 9. 공표 총액 (7차 M-2 · 8차 M-2) ----------------------------
  //
  // check 5 는 같은 rows 에서 나온 두 합을 비교하므로 상류의 반올림 방향을
  // 볼 수 없다. 실측: floor / round-half / ceil 세 입력이 전부 "grand total
  // exact" 를 출력했다. 유일한 상한이던 policy.bucket.total 은 실제 배포의
  // 85배였다. 공표한 숫자를 밖에서 넣어야 이 구멍이 닫힌다.
  //
  // 8차 감사 M-2. 7차 판은 wei 정수만 받았고, 그래서 **실제 1차 트랜치로는 절대
  // 만족시킬 수 없었다.** 재현: 주소 보유 1,205명 비례 floor 배분의 합은
  // 95337921073871118473546 wei 이고 공표 숫자 95,337.92 HCOW 는
  // 95337920000000000000000 wei 다. 차이 약 0.00107 HCOW. 공표 숫자를 넣으면 항상
  // 실패하고, 빌더가 출력한 숫자를 되넣으면 검사가 자기참조가 되어 존재 이유를
  // 잃는다. 실제로 두 번 재서 86 wei 차이가 났다 — 사람이 독립적으로 재현할 수
  // 있는 숫자가 아니다.
  //
  // 그래서 공표한 **단위와 자리수 그대로** 받는다.
  //
  //   --expect-total 95337921073871118473546   wei 정확일치 (빌드 후 트리 옆에 기록할 값)
  //   --expect-total 95337.92                  HCOW, 소수 2자리까지 일치
  //
  // 소수 형태는 "totalIn 을 그 자리수에서 절단한 값이 공표 숫자와 정확히 같다" 로
  // 해석한다. 절단이므로 totalIn 은 [공표값, 공표값 + 1단위) 안에 있어야 하고,
  // 공표값보다 작으면 실패한다.
  //
  // 이 검사가 무엇을 잡고 무엇을 못 잡는지 정직하게: 공표 자리수보다 **굵은**
  // 오차는 전부 잡는다 (자리수 밀림, 사람 단위로 반올림한 상류, 명단 누락·중복).
  // 리프당 1 wei 짜리 floor/ceil 차이는 못 잡는다 — 1,205개 리프 전체로도 1,205
  // wei, 즉 1.2e-15 HCOW 이고, 소수 2자리 공표로는 원리적으로 구분되지 않는다.
  // 그것까지 묶으려면 wei 정확일치 형태를 쓰는 수밖에 없다.
  if (expectTotal !== undefined && expectTotal !== null) {
    const raw = String(expectTotal).trim();
    const asWei = /^\d+$/.test(raw);
    const m = /^(\d+)\.(\d{1,18})$/.exec(raw);
    if (!asWei && !m) {
      throw new Error(
        `expectTotal "${expectTotal}" is neither an integer number of wei nor a decimal HCOW figure ` +
        'with 1 to 18 decimal places. Pass the announced figure exactly as it was announced ' +
        '(for example 95337.92), or the exact wei total. No thousands separators, no units, no sign.');
    }
    if (asWei) {
      const want = BigInt(raw);
      if (totalIn !== want) {
        const diff = totalIn > want ? totalIn - want : want - totalIn;
        throw new Error(
          `the input distributes ${totalIn} wei but --expect-total says ${want} wei, a difference of ` +
          `${diff} wei. Passed as an integer this is an exact-wei comparison. If you meant the ` +
          'announced HCOW figure, pass it with its decimal point instead. Nothing has been written.');
      }
    } else {
      const places = m[2].length;
      const unit = 10n ** BigInt(18 - places);
      const want = BigInt(m[1]) * 10n ** 18n + BigInt(m[2].padEnd(18, '0'));
      const truncated = (totalIn / unit) * unit;
      if (truncated !== want) {
        const sign = totalIn < want ? 'less' : 'more';
        throw new Error(
          `the input distributes ${totalIn} wei. Truncated to ${places} decimal places that is ` +
          `${truncated} wei, and the announced figure ${raw} is ${want} wei. The distribution is ` +
          `${sign} than announced by at least one unit in the last announced decimal place. ` +
          'Nothing has been written.');
      }
    }
  }

  return { rounds, dropped, consolidated, warnings, totalIn, tgeTime: tge, month };
}

// --------------------------------------------------------------------- cli

const E = 10n ** 18n;
const hcow = (v) => (Number(BigInt(v) * 10000n / E) / 10000).toLocaleString('en-US');

function main(argv) {
  const args = argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  const flag = (name, dflt) => (opts[name] === undefined ? dflt : opts[name]);
  const input = positional[0];
  if (!input) {
    console.error('usage: node scripts/build-merkle.cjs <recipients.csv|.json> --policy <policy.json> --expect-total <wei|HCOW.dd> [--tge <unix>] [--out build/merkle]');
    process.exitCode = 1;
    return;
  }
  const policyFile = flag('policy', 'schedule/airdrop-policy.example.json');
  const outDir = flag('out', 'build/merkle');
  const tgeArg = flag('tge', undefined);
  // 7차 감사 M-2. 기본값을 두지 않는다. 기본값이 있으면 그게 곧 검사를 끄는
  // 방법이 되고, 이 검사는 공지한 숫자와 트리를 잇는 유일한 연결이다.
  const expectTotal = flag('expect-total', undefined);
  if (expectTotal === undefined) {
    console.error(
      'missing --expect-total. It is the figure the distribution was announced with, and the build ' +
      'refuses to run without it. Pass it exactly as announced: a decimal HCOW figure such as ' +
      '95337.92 is compared at that many decimal places, an integer is compared as an exact wei ' +
      'total. Every other total check here compares the input with itself; this is the only one that ' +
      'reaches outside the input at all.');
    process.exitCode = 1;
    return;
  }

  const policy = loadPolicy(path.resolve(policyFile));
  const rows = loadRecipients(path.resolve(input));
  console.log(`input     ${input}  (${rows.length} rows)`);
  console.log(`policy    ${policyFile}`);
  if (/EXAMPLE|NOT SIGNED OFF|TESTNET/i.test(policy.meta?.warning || '')) {
    console.log(`          ${policy.meta.warning.split('.')[0]}.`);
  }

  const d = buildDistribution(rows, policy, { tgeTime: tgeArg ? Number(tgeArg) : undefined, expectTotal });

  console.log(`TGE       ${new Date(d.tgeTime * 1000).toISOString()}   months are ${d.month}s, as in HCOWVesting\n`);
  console.log('  round  opens                       recipients        distributed        vested by then');
  for (const r of d.rounds) {
    if (!r) continue;
    console.log(
      `  ${String(r.roundId).padStart(5)}  ${new Date(r.startTime * 1000).toISOString().slice(0, 16)}Z  ` +
      `${String(r.count).padStart(10)}  ${hcow(r.total).padStart(17)}  ${hcow(r.vestedByStart).padStart(20)}`);
  }
  console.log(`\n  total distributed  ${hcow(d.totalIn)} HCOW`);
  if (d.dropped.length) console.log(`  dropped            ${d.dropped.length} rows with a zero total`);
  if (d.consolidated.length) console.log(`  consolidated       ${d.consolidated.length} accounts paid in full in round 0 (dust rule)`);
  for (const w of d.warnings) console.log(`  note               ${w}`);

  console.log('\n  checks   addresses checksummed, no duplicates, no zero leaves,');
  console.log('           every account paid exactly its input total BY THE TREES,');
  console.log('           grand total exact, every round');
  console.log('           funded by vesting before it opens, and every root agreed');
  console.log('           by two independent implementations with every proof replayed');

  fs.mkdirSync(outDir, { recursive: true });
  const live = d.rounds.filter(Boolean);
  for (const r of live) {
    fs.writeFileSync(path.join(outDir, `round-${r.roundId}.json`),
      JSON.stringify({
        roundId: r.roundId, merkleRoot: r.merkleRoot, rootSecondPath: r.rootSecondPath,
        startTime: r.startTime, count: r.count, total: r.total, claims: r.claims,
      }, null, 2) + '\n');
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    input, policy: policyFile,
    tgeTime: d.tgeTime, monthSeconds: d.month,
    totalDistributed: d.totalIn.toString(),
    rounds: live.map((r) => ({
      roundId: r.roundId, merkleRoot: r.merkleRoot, rootSecondPath: r.rootSecondPath,
      startTime: r.startTime, count: r.count, total: r.total,
      vestedByStart: r.vestedByStart, cumulative: r.cumulative,
    })),
  };
  fs.writeFileSync(path.join(outDir, 'rounds.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nwritten to ${outDir}/  (rounds.json + ${live.length} round files)`);
  console.log('setRoot arguments are in rounds.json. Check each root against this output before signing.');
}

if (require.main === module) {
  try { main(process.argv); }
  catch (e) { console.error('\n' + (e.message || e)); process.exitCode = 1; }
}

module.exports = { buildDistribution, loadPolicy, loadRecipients, split, vestedAt, parseCsv };
