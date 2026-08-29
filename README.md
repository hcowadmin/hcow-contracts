# HCOW Contracts — HCOWToken and HCOWVesting

Reference implementations written by HashCow. Solidity 0.8.34, OpenZeppelin 5.0.2.
Both compile clean with zero warnings and pass 161 assertions, plus 20 Foundry tests including 13 invariant properties. Measured 29 August 2026.

```
npm test           # compiles, runs both suites below, then forge test
node compile.cjs   # solc 0.8.34 pinned, optimizer on, 200 runs, evmVersion paris
node test.cjs      # functional suite, 94 assertions, in-process EVM
node audit.cjs     # adversarial and property suite, 67 assertions
forge test         # 14 machine-searched invariants + 6 tests, 32,768 calls each
npm run test:fuzz:deep   # the same, 2000 runs x 400 calls
npm run test:mutate      # deletes each guard in turn and checks the suite notices
```

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

## What is still open

| Item | Effect |
|---|---|
| TGE timestamp | Constructor argument. Must be in the future and no more than a year out |
| Beneficiary addresses | The tests use placeholders. Real addresses needed before step 5 |
| Treasury custody | Single key or multisig. If single key, use a hardware wallet and fund and seal the vesting contract early to limit exposure |
| Beneficiary cap | `MAX_BENEFICIARIES` is 200. The published allocation uses nine |
| Rescue recipient | Constructor argument, fixed forever. Where a foreign token sent here by mistake goes. Not the deployer by default; decide it deliberately |
| The re-audit | The first report is answered in full. The answers themselves have been reviewed by nobody outside this repository. The audit must ultimately cover the exact source that gets deployed, not an earlier revision |
