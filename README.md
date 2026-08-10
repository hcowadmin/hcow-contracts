# HashCow Contracts

Token and vesting contracts for [HashCow](https://hash-cow.io/), a provably fair
gaming platform on BNB Smart Chain.

Documentation: https://hashcow.gitbook.io/hashcow-docs-2

## Contracts

| Contract | Lines | Purpose |
|---|---:|---|
| `HCOWToken.sol` | 56 | BEP-20 token. Fixed supply, no mint function. |
| `HCOWVesting.sol` | 238 | Non-revocable, permanently sealable vesting. |

Solidity 0.8.24. OpenZeppelin 5. Non-upgradeable, no proxy, no delegatecall.

## HCOWToken

- Total supply is fixed at 200,000,000 HCOW and minted once at construction.
- **There is no mint function.** Supply cannot increase after deployment.
- No owner, no pause, no blacklist, no transfer tax, no maximum wallet.
- The full supply is minted to a `treasury` address passed as a constructor
  parameter, not to `msg.sender`. A third party can therefore deploy the
  contract without ever holding the supply.
- Includes `ERC20Burnable` and `ERC20Permit` (EIP-2612).

## HCOWVesting

- `Ownable2Step`. Ownership transfer requires the new owner to accept.
- **Non-revocable.** There is no revoke, cancel, claw-back or sweep function.
  Once a schedule exists, the beneficiary's tokens cannot be taken back.
- **Permanently sealable.** After `seal()` no schedule can be added or modified
  by anyone, including the owner. `seal()` cannot be undone.
- `release(beneficiary)` is **permissionless**. Anyone may trigger a release,
  and tokens always go to the beneficiary, never to the caller.
- `tgeTime` is immutable and set at construction. It cannot be moved.
- Scheduling and funding are separate. `totalScheduled()` reports what the
  contract owes and `fundingShortfall()` reports what is still missing.
- `totalTgeUnlock()` sums the TGE unlock across every schedule, so the figure
  can be checked against published tokenomics before sealing.

A schedule is `(total, tgeBps, cliffMonths, linearMonths)`. The TGE portion
unlocks at `tgeTime`. The remainder unlocks in equal monthly steps after the
cliff. A month is 30 days.

## Build and test

```
npm install
npm run compile    # 0 warnings
npm run test       # 76 tests, no network required
```

`npm run test` runs two suites against an in-process EVM:

- `test.cjs` — 45 functional tests covering the published allocation, cliff
  behaviour, linear vesting midpoints, permissionless release, and the
  guarantee that no schedule can be clawed back.
- `audit.cjs` — 31 adversarial and property based tests covering reentrancy
  attempts with a malicious token, silent-failure ERC20 handling, two-step
  ownership, monotonicity and cap checks across 24 randomised schedules at 12
  time points each, dust rounding, and token invariants.

Both suites are deterministic and require no RPC endpoint.

## Security

An independent audit is in progress. This repository will be updated with the
report and the verified mainnet addresses when the audit is complete and the
contracts are deployed.

Static analysis reports no high or medium severity findings in this code. Three
`incorrect-equality` findings are raised against equality checks used to detect
full vesting, where the compared values are exact accumulated totals rather than
balances, and are documented as false positives.

## Deployment order

The order matters, and two of the steps cannot be undone.

1. Prepare the treasury address. A multisig is preferred; a hardware wallet is
   the minimum.
2. Deploy `HCOWToken(treasury)`.
3. Verify the source on BscScan and confirm the deployed bytecode matches what
   was audited.
4. Deploy `HCOWVesting(token, tgeTime, owner)`. `tgeTime` is immutable, so it
   must be final before this step.
5. Add every schedule.
6. Call `totalScheduled()` and `totalTgeUnlock()` and check both against the
   approved schedule list. This is the last point at which a mistake is cheap.
7. Call `seal()`. This is irreversible.
8. Transfer the scheduled total into the vesting contract and confirm
   `fundingShortfall()` returns 0.

## License

MIT
