# HCOW Contracts — HCOWToken and HCOWVesting

Reference implementations written by HashCow. Solidity 0.8.24, OpenZeppelin 5.0.2.
Both compile clean with zero warnings and pass a 53-assertion suite.

```
node compile.cjs   # solc 0.8.24, optimizer on, 200 runs
node test.cjs      # functional suite, 53 assertions, in-process EVM
node audit.cjs     # adversarial and property suite, 31 assertions
```

An internal security review report is included in the handoff package under
`01_문서`. Slither reports zero High and zero Medium findings on these two
contracts once the three false positives are accounted for; the reasoning is in
that report, section 4. Hand the report to the audit firm along with the source
so they do not have to re-derive it.

Deployed sizes: HCOWToken 3,972 bytes, HCOWVesting 6,104 bytes. Limit is 24,576.

---

## HCOWToken

Fixed supply of 200,000,000. Minted once in the constructor. There is no mint
function and no minter role, so supply can only ever go down through burning.

**No owner.** No Ownable, no pausable, no blacklist, no upgrade path. There is
nothing to administer, so there is no admin key to lose or misuse. It is also
the cheapest thing to audit.

**No transfer tax.** The 20 percent fee burn and the 50 percent native payment
burn are not implemented in the token. They are performed by protocol contracts
that hold those amounts and call `burn()`. A transfer tax breaks routers,
exchange listings and accounting, and is not needed to get the same result.

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

**The owner can only add schedules, and only until sealed.** After `seal()` no
schedule can ever be added, by anyone, including the owner. Call `seal()`
before TGE. From that moment the owner has no remaining power over the contract.

**Release is permissionless.** Anyone may call `release(beneficiary)`. Tokens
always go to the beneficiary, never to the caller.

**Funding is separate from scheduling.** Adding a schedule does not move
tokens. `totalScheduled()` tells you how much the contract needs and
`fundingShortfall()` tells you how much is still missing.

**`totalTgeUnlock()`** sums the TGE unlock across every schedule. Call it
before deploying and check it against the published TGE circulating supply.

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
4. Deploy `HCOWVesting(token, tgeTime, owner = <treasury address>)`.
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
7. Transfer the scheduled total into the vesting contract. Transfer the exact
   amount: excess is permanently locked, there is no sweep. Confirm both
   `fundingShortfall()` is 0 and `token.balanceOf(vesting)` equals
   `totalScheduled()`.
8. Call `seal(expectedBeneficiaries, expectedScheduled, expectedTgeUnlock)`
   with the triple from step 6. The contract refuses to seal unless it agrees,
   so the sign off becomes an on chain assertion rather than something read off
   a screen at four in the morning.

Funding comes before sealing, and sealing must happen before `tgeTime`; the
contract enforces both. Step 6 is the last chance to fix a mistake and step 8
removes the ability to make one.

**Do steps 7 and 8 in one signing session.** Between funding and sealing the
owner key can write a schedule for itself at a full TGE unlock and take
whatever the contract holds above what is already committed. Nothing releases
before the seal, so the window is only dangerous while it is open: close it in
the same batch. The same reason applies to doing it early rather than on the
eve of TGE, and it matters most when the treasury is a single key.

---

## What is still open

| Item | Effect |
|---|---|
| TGE timestamp | Constructor argument. Must be in the future at deploy |
| Beneficiary addresses | The tests use placeholders. Real addresses needed before step 5 |
| Treasury custody | Single key or multisig. If single key, use a hardware wallet and fund and seal the vesting contract early to limit exposure |
| Audit firm and scope | The audit must cover the exact source that gets deployed, not an earlier revision |
