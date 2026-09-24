# HCOW Contracts — HCOWToken, HCOWVesting, HCOWClaim and HCOWAnchor

Reference implementations written by HashCow. Solidity 0.8.34, OpenZeppelin 5.0.2.
The first two compile clean with zero warnings and pass 161 assertions, plus 20 Foundry tests
(14 invariant properties + 6 tests). `HCOWClaim` and `HCOWAnchor` were added afterwards and are
additive: they change nothing about the two contracts above.

**682 assertions across nine suites, all green. Measured 22 September 2026.**

```
npm test           # compiles, runs every suite below, then forge test
node compile.cjs   # solc 0.8.34 pinned, optimizer on, 200 runs, evmVersion paris

node test.cjs                        # functional, token and vesting          94
node audit.cjs                       # adversarial and property               67
node test/HCOWClaim.test.cjs         # the sixteen tests of the claim spec   108
node test/claim-boundaries.test.cjs  # the claim contract at its edges        82
node test/build-merkle.test.cjs      # the seven tree-generator checks        31
node test/builder-guards.test.cjs    # the generator's own guards             35
node test/ops-guards.test.cjs        # the operator scripts, run for real    109
node test/HCOWAnchor.test.cjs        # the round anchor                       93
node test/deploy-token.test.cjs      # the token-only deploy script           63
                                                                      total  682

forge test         # 14 machine-searched invariants + 6 tests, 32,768 calls each
npm run test:fuzz:deep   # the same, 2000 runs x 400 calls
npm run test:mutate      # deletes each guard in turn and checks the suite notices
```

`test/ops-guards.test.cjs` runs the real operator scripts as child processes
against an in-process chain, so a guard that only exists in a comment fails
there. Audit 7 (2026-09-22) added 22 cases to it for `deploy.cjs`, which until
then had never been audited at all even though it is the only sanctioned
mainnet deployment path.

**The compiler is pinned, and pinned to the same version `hcow-protocol` uses.**
Both repositories are audited and deployed together, and a compiler difference
between them is a difference nobody would think to look for. `evmVersion` is set
to `paris` explicitly rather than defaulted: a newer default target emits
opcodes BNB Chain may not have, and the failure mode is a contract that deploys
and then reverts on a path nobody exercised on a local chain that did have
them.

`forge test` needs the Foundry standard library once, because it is not
committed:

```bash
git clone --depth 1 https://github.com/foundry-rs/forge-std foundry/lib/forge-std
```

The Foundry suite is not more of the same. The two suites above replay
sequences their author thought of, and a sequence nobody thought of is not
tested. `foundry/` states the properties instead and lets a machine look for
counterexamples, in both phases: the sealed contract, and the loading phase
where an irreversible mistake about 200,000,000 tokens gets made.

Before trusting any property, delete the guard it claims to protect and check
that it fails. That is how the gaps in this suite were found, and it is now
`npm run test:mutate` rather than an instruction: the runner applies each
mutation, runs the suite that should catch it, restores the file, and refuses
to call a mutation caught unless the suite failed **on the assertion that names
it**. Two assertions in this repository were found to be passing for the wrong
reason that way. One checked that the vesting token could not be rescued, but
the contract held none of it, so the refusal came from `NothingToRescue` and
the assertion passed with the guard deleted. Both now assert the error by
name.

`npm test` compiles first, deliberately. `test.cjs` and `audit.cjs` read
prebuilt artifacts from disk, so running them without compiling tests whatever
was built last. That is not hypothetical: with the compile step missing, the
`NotSealed` gate was deleted from the source and all 84 assertions still
passed.

Slither, run against this revision and committed as `slither-report.txt`:
16 results across 7 detectors, **zero High and zero Medium**. The three that
look like findings are a missing zero-check inside the test doubles, a
`missing-inheritance` note about the interface those doubles declare, and a
`costly-loop` on `addSchedule` inside `addSchedules` — which is bounded at
`MAX_BENEFICIARIES` and whose worst case is measured rather than argued:
sealing a full two-hundred-schedule table costs 458,729 gas.

```
slither contracts/ --solc /usr/local/bin/solc \
  --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/" --exclude-dependencies
```

Deployed sizes: HCOWToken 4,083 bytes, HCOWVesting 8,636 bytes. Limit is 24,576.

These two contracts were reviewed for the first time on 25 August 2026, as part
of a system-level pass across both repositories. That review found one Critical
and three High findings here, all of them now fixed and all of them regression
tested in `audit.cjs` section G. Section 14 of `SECURITY.md` in the
`hcow-protocol` repository is the full write-up.

**They were then audited externally.** SolidProof's first report, 28 August
2026, covered this repository at commit `4a3e373` and raised two Mediums here,
both about the loading phase rather than the vesting arithmetic: a partial
funding could strand the contract permanently, and a mistyped row could not be
corrected before sealing. Both are fixed, by `fundAndSeal()` and
`replaceTable()` respectively, and section 20 of `SECURITY.md` in
`hcow-protocol` records every finding including the one that was declined.

**The first fix for the second Medium was itself a High severity defect.** It
was a bare `resetTable()`, and it created a permanent total-loss path this
contract did not have: measured, one call stranded 3,000,000 HCOW. Every suite
was green when it was written. Section 21 of that `SECURITY.md` is the write-up.
**The fixes are after the audited commit and have not themselves been reviewed
externally.**

---

## HCOWToken

Fixed supply of 200,000,000. Minted once in the constructor. There is no mint
function and no minter role, so supply can only ever go down through burning.

**No owner.** No Ownable, no pausable, no blacklist, no upgrade path. There is
nothing to administer, so there is no admin key to lose or misuse. It is also
the cheapest thing to audit.

**No transfer tax, and no burn mechanism anywhere.** The 20 percent fee burn
and the 50 percent native payment burn described in older marketing material
are **not implemented in any deployed contract**, here or in `hcow-protocol`.
Nothing calls `token.burn()`. The only on-chain burn in the whole system is the
bonded-deposit deduction in `HCOWProfitShare`, which transfers to
`0x…dEaD` and therefore does **not** reduce `totalSupply()`: any circulating or
burned figure must read `balanceOf(0xdEaD)` rather than subtracting from
supply. A transfer tax was rejected deliberately, because it breaks routers,
exchange listings and accounting. Do not restate the fee burn as a live
mechanism in any document until something implements it.

**The supply goes where you tell it.** The constructor takes a `treasury`
address and mints the whole supply there. It does not mint to `msg.sender`.

> Whoever holds `treasury` at genesis holds the entire supply, and that fact is
> permanently visible on chain. Because the address is a constructor parameter,
> a third party can deploy the contract without ever holding the supply, which
> removes the usual reason for that to look wrong on BscScan.
>
> A multisig is the safest choice for `treasury`. If a single key is used it
> must be a hardware wallet, and it should be the same person who completed
> team KYC, since exchange review compares the two.

---

## HCOWVesting

TGE unlock, then cliff, then linear release. Months are 30 days, stated
explicitly so nobody has to guess.

**Non-revocable.** Once a schedule is created it cannot be cancelled, reduced
or reassigned. There is no revoke, cancel, sweep or emergency withdraw
function, and the test suite asserts their absence.

**The owner can only add schedules, and only until sealed, and never at or
after TGE.** After `seal()` no schedule can ever be added, by anyone, including
the owner. From that moment the owner has no remaining power over the contract:
`transferOwnership`, `acceptOwnership` and `renounceOwnership` are all refused,
and `seal()` clears any pending owner.

**`seal()` has no deadline.** `addSchedule` is what closes at `tgeTime`, which
is where the danger was: a schedule written moments before a seal could
otherwise unlock in the same block. Sealing itself must never become
impossible, because `release()` is gated on it and there is no sweep. An
earlier version refused to seal after `tgeTime`, which meant a missed calendar
date locked the entire funded balance forever, with no recovery by anyone. Seal
early anyway, for the reason at the end of the deployment order below, but a
slip is now a delay rather than a total loss.

**A schedule with no cliff and no linear period must unlock 100% at TGE.**
`(total, 1500, 0, 0)` is refused, because with nothing left to vest it would
release the whole allocation at TGE while `totalTgeUnlock()` reported fifteen
percent. It is what a dropped fifth argument looks like. `(total, 10000, 0, 0)`
is fine: it says what it does.

**`totalTgeUnlock()` runs the real vesting maths**, not a sum of basis points,
so the figure `seal()` commits to is the figure that actually releases.

**Release is permissionless.** Anyone may call `release(beneficiary)`. Tokens
always go to the beneficiary, never to the caller.

**Funding and sealing happen in ONE transaction.** `fundAndSeal()` pulls
exactly `totalScheduled - totalReleased`, or nothing if the contract is already
funded, and seals in the same call. It exists because the audit found that
funding and sealing as two steps left a window, and because a treasury that
sent the balance it held rather than the figure it was asked for stranded the
contract permanently: the transfer succeeded, `seal()` could never pass, and
there is no sweep. There is now no figure for a human to type, so there is no
wrong one to type. Anyone may call it; the tokens come from the caller.

`totalScheduled()` still tells you how much the contract needs,
`fundingShortfall()` how much is missing, and `committedTotalIsFundable()`
whether live supply is even large enough, which is checked again at seal and
reported by its own error rather than as underfunding.

**A mistyped row can be corrected before sealing.** `replaceTable()` swaps the
whole table, before the seal and before TGE. Before it existed, one wrong digit
meant deploying again from scratch. It cannot run after either boundary.

It clears and reloads in ONE call, deliberately. The first attempt at this was a
bare `resetTable()` that only cleared, and it created a permanent total-loss
path the contract did not have: clear a funded table, fail to rebuild it before
TGE, and `addSchedule` is closed, `seal()` reverts `NoSchedules` forever,
`release()` is gated on the seal, and there is no sweep. Measured on that
version, one call stranded 3,000,000 HCOW.

Its own comment claimed it granted the owner no power it did not already have,
and that was wrong in a way worth naming: declining to seal is **recoverable**,
which is why `seal()` has no deadline and becomes permissionless at TGE.
Emptying a funded table is not. Guarding it on the contract being empty was the
obvious second fix and also wrong, because anyone can send one wei here before
the table is loaded and disable the correction path for good. This form has
neither problem: the empty table is not a reachable state, funded or not.

**A schedule cannot run past ten years.** `cliffMonths + linearMonths` is
bounded at `MAX_VESTING_MONTHS = 120`, checked on entry, because a mistyped
period is otherwise permanent.

**`totalTgeUnlock()`** sums the TGE unlock across every schedule. Call it
before deploying and check it against the published TGE circulating supply.

**A foreign token sent here by mistake can be recovered; HCOW never can.**
`rescueForeignToken(other)` is callable by anyone and always sends to an
address fixed at deployment. It refuses `address(token)`, and that refusal is
the point: a sweep of the vesting token is a withdrawal path out of a contract
whose entire promise is that it has none. The audit suggested including it and
that half is declined, with the reason stated rather than the suggestion
silently dropped.

---

## The allocation the tests assert

| Bucket | Tokens | TGE | Cliff | Linear | TGE unlock | Fully vested |
|---|---:|---:|---:|---:|---:|---:|
| Public | 60,000,000 | 15% | 0 | 12 | 9,000,000 | month 12 |
| Private | 40,000,000 | 7.5% | 6 | 12 | 3,000,000 | month 18 |
| Seed | 20,000,000 | 25% | 0 | 3 | 5,000,000 | month 3 |
| Community / Airdrop | 8,000,000 | 37.5% | 0 | 6 | 3,000,000 | month 6 |
| Community / Incentives | 12,000,000 | 0% | 0 | 24 | 0 | month 24 |
| Ecosystem & R&D | 20,000,000 | 0% | 6 | 42 | 0 | month 48 |
| Foundation | 16,000,000 | 0% | 12 | 36 | 0 | month 48 |
| Liquidity | 14,000,000 | 50% | 0 | 12 | 7,000,000 | month 12 |
| Team | 10,000,000 | 0% | 12 | 36 | 0 | month 48 |
| **Total** | **200,000,000** | | | | **27,000,000** | |

27,000,000 is 13.5 percent of supply. `test.cjs` asserts both figures exactly.

> **Community is two schedules, not one.** The 20,000,000 Community allocation
> is split into an 8,000,000 Airdrop and Launch tranche and a 12,000,000
> Ongoing Ecosystem Incentives tranche. They have different terms, so they are
> two separate `addSchedule` calls to two separate addresses. Adding them as a
> single 20,000,000 schedule produces the wrong TGE unlock and cannot be undone
> after `seal()`.

> **Read this before writing marketing copy.** Team, Foundation and Ecosystem
> and R&D all finish at month 48. Every bucket held by an outside participant
> (Public month 12, Private month 18, Seed month 3, Community month 24)
> finishes earlier. So "the team is the last money out" is accurate here
> without qualification. Seed is the fastest bucket in the entire schedule at
> month 3, so do not write copy that implies early investors are locked longer
> than the public.

---

## Deployment order

1. Prepare the treasury address. A Safe multisig is preferred; a hardware
   wallet is the minimum. This address will hold 200,000,000 HCOW.
2. Deploy `HCOWToken(treasury = <treasury address>)`.
3. Verify the source on BscScan and confirm the deployed bytecode matches
   what was audited. Do this before any value moves.
4. Deploy `HCOWVesting(token, tgeTime, owner, rescueRecipient,
   expectedBeneficiaries, expectedScheduled, expectedTgeUnlock,
   expectedScheduleHash)`. **The four commitments are computed from the signed
   off table before deploying, not read back off a loaded contract.** Reading
   them back makes the check a tautology, which is exactly the defect that put
   them in the constructor. `vestcommit.cjs` computes all four; the formula is
   in step 8 below and `total` is `uint128`.
   **`tgeTime` is not the listing time.** Set it deliberately. If the exchange
   listing is at T, setting `tgeTime` to T plus two hours means no beneficiary
   can release a single token during the first two hours of trading. Whatever
   value is chosen must be published in the sale terms before the sale opens,
   so that participants know the claim schedule in advance. It cannot be
   changed after deployment.
5. Add every schedule from the treasury address. There are NINE schedules,
   not eight. See the note above about the Community split.
6. Call `beneficiaryCount()`, `totalScheduled()` and `totalTgeUnlock()` and
   check all three against the schedule list operations signed off on, then
   read every schedule back individually with `schedules(address)` and compare
   the total, the basis points, the cliff and the linear period field by field.

   The count matters as much as the totals. Merging the two Community tranches
   into one entry leaves `totalScheduled` and `totalTgeUnlock` **exactly
   right** while the airdrop's six month linear silently becomes twenty four
   and the whole tranche lands on one address. Only the count and the per
   schedule readback catch it.

   > **Decide the expected figures in advance.** For the published allocation
   > they are nine schedules, 200,000,000 scheduled and 27,000,000 unlocked at
   > TGE. If a sale round did not sell out its remainder stays in the treasury
   > and is not scheduled, so the real figures are lower. Work out that exact
   > triple beforehand, have operations sign it, and hold the deployment to it.
   > Never accept "it is smaller, and that is expected" on the day.
7. Approve the vesting contract for the scheduled total from the treasury.
8. Call **`fundAndSeal()`** from the treasury. It pulls exactly what is owed
   and seals in the same transaction. Do not fund and seal as two calls: the
   window between them is one where the owner key can write a schedule for
   itself at a full TGE unlock, and ordering alone cannot close it.

   The contract still checks all four commitments, which are now fixed in the
   constructor from step 4, so the sign off is an on chain assertion rather
   than something read off a screen at four in the morning.

   The fourth argument is a running hash over every schedule, field by field,
   in the order they were added. Read it from `scheduleHash()` after step 5 and
   compare it against the value computed from the signed off table:

   ```
   h = 0x00...00
   for each row, in the order it was added:
     h = keccak256(abi.encodePacked(bytes32 h, address beneficiary,
                                    uint128 total, uint16 tgeBps,
                                    uint16 cliffMonths, uint16 linearMonths))
   ```

   **The widths matter and `total` is `uint128`, not `uint256`.**
   `abi.encodePacked` is width sensitive: the contract packs 32 + 20 + 16 + 2 +
   2 + 2 = 74 bytes per row. Computing it with a 256 bit `total`, which is what
   the `ScheduleAdded` event declares and therefore the natural thing to reach
   for, produces a different hash, `seal()` reverts `CommitmentMismatch`, and
   the obvious four in the morning recovery is to read `scheduleHash()` off the
   contract and paste it back in, which makes the fourth argument a tautology
   and defeats the whole check. In ethers:

   ```js
   h = ethers.solidityPackedKeccak256(
     ['bytes32', 'address', 'uint128', 'uint16', 'uint16', 'uint16'],
     [h, beneficiary, total, tgeBps, cliffMonths, linearMonths]);
   ```

   The other three are all invariant under a transposition of `cliffMonths` and
   `linearMonths`, which is the likeliest mistake in a five argument call with
   two adjacent same typed arguments. Loaded that way, Seed's `cliff 0 /
   linear 3` becomes `cliff 3 / linear 0` and drops 15,000,000 in one block,
   while Team's lockup silently becomes 36 months of nothing, and the count,
   the total and the TGE unlock are all still exactly right. This is the only
   value that moves.

Sealing has no deadline: `addSchedule` is what closes at `tgeTime`, so a date
that slips is a delay rather than the permanent loss of everything the contract
holds. Seal before TGE anyway, for the reason in the next paragraph. Step 6 is
the last chance to fix a mistake, `replaceTable()` is how a mistake found there
is fixed, and step 8 removes the ability to make one.

From `tgeTime` onward `seal()` is permissionless. The table is frozen by then
and all four commitments have to match figures that are already public, so the
only thing another caller can do is finish a job that was left undone. That is
deliberate: an owner key that is lost or frozen between funding and sealing
would otherwise hold every beneficiary's tokens with no sweep and no recovery.

**Steps 7 and 8 are one transaction, not one signing session.** Between funding
and sealing the owner key can write a schedule for itself at a full TGE unlock
and take whatever the contract holds above what is already committed. "Do them
close together" was the earlier rule and it was not enough: the audit's
Informational #1 is that ordering cannot close a window, only atomicity can.
`fundAndSeal()` is that atomicity. It matters most when the treasury is a
single key, and it is also the reason to do this early rather than on the eve
of TGE.

---

## HCOWClaim

`HCOWVesting` vests to nine **bucket** addresses, not to people. The
`Community / Airdrop` bucket — 8,000,000 HCOW, 37.5% at TGE, no cliff, six
month linear — has `HCOWClaim` as its beneficiary. Vesting releases flow into
it and ~20,000 individual recipients pull from it. Nothing about the six
audited contracts changes: this one is additive, and to `HCOWVesting` it is an
ordinary beneficiary address.

Recipients claim themselves, from `app.hash-cow.io`, paying their own gas.
Nothing is pushed.

```
HCOWClaim(token, owner, claimDeadline, minRoundNotice, minClaimWindow)     5,103 bytes deployed
```

Uniswap's `MerkleDistributor` is the reference implementation and the claim
path is deliberately its claim path: one root, a bitmap of spent indices, and a
transfer. The one structural change is that everything is keyed by round, so
one contract serves every unlock round of every airdrop category.

### What it guarantees

| | |
|---|---|
| A round's root freezes when the round opens | `setRoot` reverts with `RoundAlreadyStarted` at or after `startTime`, forever, including a call that would set the identical root. An operator who could rewrite a live root could pay any address any amount |
| A root can still be corrected before the round opens | And every correction emits `RoundSet`, so a rewrite cannot happen quietly |
| One claim per round per entry | Per-round bitmap. Rounds share nothing, so a claimed round 0 does not close round 1 |
| A failed transfer never marks an entry claimed | The balance is checked first and the entry is marked before the transfer, so an underfunded round reverts whole with `InsufficientBalance` and the bit is rolled back with it. This is the standard permanent-loss bug in multi-round distributors, and test 9 is the one that proves it is absent |
| `sweep` is shut until `claimDeadline`, with no override | But it is **not** the owner's only route to the tokens, and this table used to say it was. `setRoot` is the second route: the owner can register an unused round whose tree pays one address the balance, wait out `minRoundNotice`, and claim it. That is a property of every distributor whose operator chooses the root, and design note 4 in the contract sets out what is enforced instead. Do not read this row as more than it says |
| The deadline extends, never shortens, and not past the horizon | `extendDeadline` refuses anything at or below the current value, and anything more than `MAX_DEADLINE_HORIZON` (3650 days) from the calling block. Unbounded, one call could have pushed it out of reach and — since `setRoot`'s upper bound is derived from it — taken a registered round with it, leaving the balance neither claimable nor sweepable (audit 7). The bound ends the one-shot version of that, **not every version**: an owner who keeps acting can pair `extendDeadline` with a `setRoot` that pushes the round later and repeat roughly every 9.7 years, holding the balance in the same state for as long as they keep doing it. Design note 8 in the contract states this; do not read this row as saying more than the bound actually buys, which is that the state now requires a live owner rather than a single transaction |
| `minClaimAmount` is raised only before the first round is **registered** | Afterwards it moves down and never up, reverting with `MinClaimAmountRaiseClosed`. The gate used to be the first round *opening*, which left the whole `minRoundNotice` interval — after the list is fixed and published, before anyone can claim — open to a zero-notice raise that excluded committed leaves. Audit 7 reproduced it and the gate moved back to registration |
| Ownership cannot be renounced | Renouncing would end `setRoot` too, so no later round could ever open and everything still owed would be stranded |
| No unlock policy is in the contract | It knows only "may this address take this amount in this round". Ratios live in the tree |

### What it does NOT guarantee

Stated here because the table above is the kind of thing people quote, and
because two of this project's published promises did not survive an
adversarial read (audit 7, 2026-09-22).

**The owner can rewrite the recipient list of a round that has not opened yet,
and can register a round that pays the owner.** `setRoot` is a second route to
the balance and `sweep` is not the only one. Every distributor whose operator
chooses the root works this way: the contract cannot tell an honest recipient
list from a dishonest one, because both arrive as a `setRoot`. Design note 4 in
the contract states this in full rather than defending against it.

What actually constrains that power is two things, and they are not in the
contract: **the owner is a 2-of-3 multisig, and every root ever written emits a
public `RoundSet` event before it can pay anyone.** `minRoundNotice` is what
makes "before" true.

What the contract does enforce, and all of it:

```
1  sweep() reverts before claimDeadline, with no override
2  claimDeadline extends and never shortens, and an extension cannot
   reach further than MAX_DEADLINE_HORIZON from the calling block
3  an opened round's root is frozen forever, including against a call
   that would set the identical root
4  minClaimAmount is raised only before the first round is REGISTERED,
   and lowered at any time thereafter
5  ownership cannot be renounced and transfer is two-step
```

Anyone relying on a stronger guarantee than that list is relying on something
this contract does not provide.

`owner` is the treasury Safe, passed at deployment. `minClaimAmount` starts at
zero, meaning no floor, and is the parameter left for spec section 10 item 2.

Every power the owner holds here runs one way once claiming has begun, and the
floor is no exception: it can be raised only while **no round has been
registered at all**, that is while `earliestRoundStart` is still its initial
`type(uint256).max`. The first `setRoot` closes it, permanently, whether or not
that round has opened.

The gate used to be the first round *opening*, which left the whole
`minRoundNotice` interval — after the list is fixed and published, before anyone
can claim — open to a zero-notice raise that excluded committed leaves. Audit 7
(2026-09-22) reproduced that and the gate moved back to registration. Audit 8
found this paragraph still describing the old rule.

`earliestRoundStart` only ever moves earlier. It does not follow an unopened
round that `setRoot` pushes later — the rounds mapping is sparse and cannot be
enumerated, and recomputing a true minimum would mean carrying a list of every
round for the sake of one owner-only call. That asymmetry no longer affects the
floor gate, which keys off registration rather than off the value, but the value
is still what the revert reports.

### Unlock policy is not in the contract, and must not be

The airdrop categories unlock on different curves, and the numbers are not
final. They belong in `schedule/airdrop-policy.json` — copy
`schedule/airdrop-policy.example.json`, which carries the drafted ratios and
says on its face that they are drafted. The generator applies them and the
contract sees only amounts, so a policy change is a new tree rather than a new
contract.

**Months are 30 days**, the same `MONTH` `HCOWVesting.sol` uses. The generator
refuses a policy file that says otherwise. Calendar months would drift the
round boundaries off the grid the tokens actually vest on, and the failure mode
is a round that opens while the tokens funding it are still vesting.

### Building the trees

```bash
node scripts/build-merkle.cjs recipients.csv      --policy schedule/airdrop-policy.json      --tge <unix seconds> --out build/merkle
```

Input is CSV or JSON with `account`, `category` and `totalAmount` in wei. Output
is `build/merkle/rounds.json` — the `setRoot` arguments — and one
`round-<n>.json` per round holding every index, amount and proof.

**More accidents happen here than in the contract**, so the generator proves
the whole of spec section 6 before it writes anything, and stops rather than
warns:

1. every address is valid and EIP-55 checksummed — a lowercase address is
   refused rather than normalised, because a checksum is the only thing between
   a typo and a payment to nobody
2. no address appears twice — two rows means two leaves in one round and two
   claims against one entitlement
3. rows totalling zero are dropped, and no zero amount reaches a tree
4. each account's round amounts sum to exactly its input total, remainder
   included. The remainder of the division goes to the **last** round
5. the sum over every round equals the input file's total
6. cumulative demand through round *n* never exceeds what `HCOWVesting` will
   have released into this contract by round *n*'s start — the same vesting
   arithmetic, reimplemented against the bucket figures in the policy file
7. each root is computed twice, by two implementations sharing no code and no
   library — `js-sha3` iterating level by level against `ethers` recursing —
   and then every generated proof is replayed to the root by a third function
   that uses neither builder

The seventh is the one worth insisting on. Running the same function twice is
not a check.

Dust (spec 4-3) is handled in the tree, which is option 1 of the two the spec
offers: set `dustThreshold` in the policy file and any account whose split
would put a round below it is paid in full in round 0 instead. The default is
zero, which disables it. `minClaimAmount` on the contract is option 2, left at
zero and unused.

### Claim deployment order

This extends the list above; steps 1-3 there are unchanged.

```
1  deploy-token.cjs      HCOWToken, supply minted to the treasury Safe
2  deploy-claim.cjs      HCOWClaim (owner = treasury Safe, claimDeadline set long)
3  Put the HCOWClaim address in the Community / Airdrop row, and in no other row
4  deploy.cjs            HCOWVesting, with HCOW_ADDRESS. Mainnet refuses without a recorded
                         HCOWClaim, if the claim is not the Airdrop row's beneficiary, if the
                         table's total or TGE unlock differs from the file's own published
                         figures (meta.totalsMustEqual / meta.tgeUnlockMustEqual), or if the
                         Airdrop row finishes vesting after claimDeadline − minClaimWindow
5  load.cjs, seal.cjs    PRINT_ONLY for the Safe; confirm with DRY_RUN=yes seal.cjs
6  set-root.cjs round 0  BEFORE TGE by at least max(1 day, minRoundNotice). Round 0 pays at
                         TGE, so it must be registered ahead of it. set-root counts what the
                         sealed vesting will release to the claim by the round's start, so no
                         ALLOW_UNDERFUNDED is needed for it
7  At or after TGE       release.cjs RELEASE=yes, so the Airdrop tokens arrive at HCOWClaim
8  Open the claim page
9  set-root.cjs for each later round, each at least minRoundNotice ahead
```

The order used to say "after TGE, release the bucket; then register round 0".
Audit 11 (2026-09-23) ran it end to end: round 0 cannot be registered after
TGE, because `minRoundNotice` requires it to be registered before its start,
and its start is TGE. It could only be registered before TGE with
`ALLOW_UNDERFUNDED=yes`, which meant the underfunding guard never ran for the
one round every public promise depends on. Both the order and the guard were
corrected.

```bash
RPC_URL=... CHAIN_ID=97 DEPLOYER_KEY=0x... HCOW_ADDRESS=0x... \
  CLAIM_OWNER=0x<treasury Safe> CLAIM_DEADLINE=<unix seconds> \
  CLAIM_NOTICE_SECONDS=259200 CLAIM_WINDOW_SECONDS=7776000 \
  node scripts/deploy-claim.cjs
```

`CLAIM_NOTICE_SECONDS` and `CLAIM_WINDOW_SECONDS` are required and both are
**immutable after deployment**. Neither appeared in this file until audit 7,
so the command above used to fail on a missing variable when copied.

| | what it is | range | recommended |
|---|---|---|---|
| `CLAIM_NOTICE_SECONDS` | how far ahead a round's `startTime` must be when `setRoot` is called | 3,600 to 2,592,000 | 259200 (72 h). Mainnet refuses under a day |
| `CLAIM_WINDOW_SECONDS` | how long every round stays claimable before `sweep` can open | 3,600 to 31,536,000 | 7776000 (90 d). Mainnet refuses under 30 days |

The one-hour floors exist so a testnet rehearsal fits in an afternoon. The
script refuses both of them on mainnet.

**Step 4 is the point of no return, not the seal.** The beneficiary set is
fixed when HCOWVesting is **deployed**: `expectedScheduleHash` is immutable
and contains all nine addresses. So `HCOWClaim` has to exist and be final
before `deploy.cjs` runs. `deploy-claim.cjs` refuses to deploy whenever any
HCOWVesting is recorded, sealed or not, with no flag to override it, because a
claim contract deployed after the vesting looks correct, verifies on BscScan,
and silently never receives a token. (Until audit 10 it read only `sealed_()`,
and this paragraph described the seal as the point of no return.)

`claimDeadline` is passed here and can only ever move later. Set it long.

### Registering a round

```bash
RPC_URL=... CHAIN_ID=56 TREASURY_KEY=0x... node scripts/set-root.cjs --rounds build/merkle/rounds.json --round 0

PRINT_ONLY=yes ...   # prints to / data for the Safe instead of sending
```

Before anything is signed the script rebuilds the round's tree from
`round-<n>.json` by both paths, checks the rebuilt root against both files,
replays every shipped proof, and then checks on chain that the round has not
already opened and that it will be funded when it opens: the claim contract's
balance now, plus what the sealed vesting contract will have released to it by
the round's `startTime`. Someone has to call `release(<claim>)` on the vesting
contract at or after that time; until then claims revert whole with
`InsufficientBalance` and nothing is lost.

All rounds share one balance, so the round is not checked alone. Every round in
`rounds.json` that opens no later than this one (registered, or still able to
be) is added up, registered roots are checked against the chain, and the total
must not exceed what the vesting will have released to the claim contract by
this round's start. The same sum is checked again at the start of every round
already registered to open later, and a registered round's start time is read
from the chain, not the file. Without that, a later round can be paid out of
tokens an earlier round's claimants have not collected yet, and they wait.
With no sealed vesting figure for the claim contract, the balance it holds now
must cover every counted round that has not opened yet. (Audits 12 and 13.)
A root registered on chain under a roundId that is not in this build cannot be
seen: the mapping is not enumerable. The owner is a
Safe, so the real call is normally `PRINT_ONLY=yes` and the printed `data`
submitted through the Safe.

**Check the root on screen against `rounds.json` before signing.** After
`startTime` this call can never be made again for that round.

### Operational cautions

- **`startTime` is not checked for freshness, on purpose, but it is bounded on
  both sides.** A queued Safe transaction executes minutes or days after it is
  prepared, and a freshness check would reject the correct call for being late.
  So there is no "this call is stale" rule. There are two range rules instead:
  `startTime` must be at least `minRoundNotice` ahead (`NoticeTooShort`), so no
  round can open in the block it was registered and every root is a public
  `RoundSet` before it can pay anyone; and it must be at least
  `minClaimWindow` before `claimDeadline` (`ClaimWindowTooShort`), so `sweep`
  never opens against a round nobody could claim yet. An earlier version of
  this paragraph said a round with a `startTime` already past opens and freezes
  in the same block. `minRoundNotice` ended that case and the sentence was left
  behind; it is corrected here rather than defended.
- **Register a round before the tokens for it arrive, not after.** Claims
  against an underfunded round revert cleanly and cost the claimant gas for
  nothing, which is an annoyance. The reverse — opening late — is worse only in
  that it is noisier.
- **`sweep` moves whatever it is told to move, including tokens a recipient has
  not claimed yet.** It is deadline-gated and nothing more. Publish the
  deadline, and extend it rather than arguing about it.
- **Every round's root is public, and so is every proof.** The tree files are
  the claim page's data. Nothing in them is secret and nothing in them should
  be edited by hand.
- A claim may be submitted by anyone for anyone. The tokens always go to
  `account`, never to the caller, so a recipient without gas can be paid by
  somebody else and nobody can redirect a payment by calling.

### What the sixteen tests cover

`test/HCOWClaim.test.cjs` is spec section 7, numbered, in chronological order
because the contract's whole shape is what is allowed before and after which
instant. The trees it tests against are built by `scripts/build-merkle.cjs`
rather than by a fixture: a distributor tested against proofs from a generator
that is not the production generator has tested nothing about production.

Every revert is asserted **by name**. "It reverted" is satisfied by any of the
several guards standing on the claim path, so an assertion written that way
stays green when the guard under test is deleted.

`npm run test:mutate` carries nine mutations for this contract and each is
caught by the assertion that names it: the pre-transfer balance check, the
already-claimed guard, the round start gate, the frozen root, the one-way
deadline, the one-way floor, the write that records `earliestRoundStart`, the
sweep gate, and the leaf preimage — that last one because the leaf is one
definition living in two files, `HCOWClaim._claim` and `scripts/merkle.cjs`,
and nothing but a test holds them together.

---

## What is still open

| Item | Effect |
|---|---|
| TGE timestamp | Constructor argument. Must be in the future and no more than a year out |
| Beneficiary addresses | The tests use placeholders. Real addresses needed before step 5 |
| Treasury custody | Single key or multisig. If single key, use a hardware wallet and fund and seal the vesting contract early to limit exposure |
| Beneficiary cap | `MAX_BENEFICIARIES` is 200. The published allocation uses nine |
| Rescue recipient | Constructor argument, fixed forever. Where a foreign token sent here by mistake goes. Not the deployer by default; decide it deliberately |
| Airdrop category totals | Per-category sums for miniapp / TaskOn / awareness / build-phase / other. Check 6 of the generator refuses a set that outruns the bucket's release curve, but it cannot tell you the right numbers |
| `minClaimAmount` | Contract parameter, starts at zero meaning no floor. Dust is handled in the tree instead; this is the second option, left open. Decide it **before the first `setRoot`**: from the first round *registration* onwards it can only be lowered. Also cross-check it against the tree — check 8 of the generator refuses a build whose smallest leaf is under the floor, and with the real first tranche the smallest leaf is 0.4248 HCOW |
| `claimDeadline` | Constructor argument. Extends, never shortens, so set it long |
| Sweep recipient | An argument to `sweep`, chosen per call rather than fixed at deployment. Decide it before the deadline, not on the day |
| Referral commission | Whether the 1% belongs to "miniapp rewards" or is its own category. It changes the curve applied to those balances |
| Season 1 prize (2,500 HCOW) | Published rules say paid at TGE, so it must be 100% at TGE. Classifying it as "other" gets that right |
| The re-audit | The first report is answered in full. The answers themselves have been reviewed by nobody outside this repository. The audit must ultimately cover the exact source that gets deployed, not an earlier revision |
