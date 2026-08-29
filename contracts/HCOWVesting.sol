// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title HCOWVesting
 * @notice TGE unlock, then cliff, then linear release. Non-revocable.
 *
 * DESIGN NOTES FOR AUDIT AND FOR THE DEPLOYING TEAM
 *
 *  1. NON-REVOCABLE. Once a schedule is created it cannot be cancelled,
 *     reduced or reassigned. The owner cannot claw tokens back. This is the
 *     whole point: an investor must be able to verify that their allocation
 *     is not at the team's discretion.
 *
 *  2. THE OWNER CAN ONLY ADD SCHEDULES, AND ONLY UNTIL SEALED, AND NEVER AT
 *     OR AFTER TGE. After seal() no schedule can ever be added, by anyone.
 *     Seal before TGE. From that moment the owner has no remaining power over
 *     this contract at all.
 *
 *  3. RELEASE IS PERMISSIONLESS. Anyone may call release(beneficiary). Tokens
 *     always go to the beneficiary, never to the caller. This means a
 *     beneficiary who loses access to gas can still be paid, and it makes the
 *     contract usable by automation.
 *
 *  4. TIME IS ABSOLUTE, NOT RELATIVE TO DEPOSIT. `tgeTime` is set once at
 *     construction. Cliff and linear duration are measured from it, so a
 *     schedule added late still vests correctly for elapsed time. Adding one
 *     at or after `tgeTime` is refused anyway: it could unlock in the block it
 *     is written, which is the whole of the owner's remaining power. Sealing,
 *     by contrast, has no deadline and after TGE is permissionless, because a
 *     seal that becomes impossible locks everything the contract holds
 *     forever and nobody can undo it.
 *
 *  5. MONTHS ARE 30 DAYS. Stated explicitly so no one has to guess. A
 *     "12 month cliff and 24 month linear" is 360 days then 720 days.
 *
 *  6. THE CONTRACT MUST BE FUNDED. Adding a schedule does not move tokens.
 *     Use fundAndSeal(): approve at least fundingShortfall() and call it, and
 *     the contract pulls exactly what it needs and seals in the same
 *     transaction. Do not transfer manually. A wallet's "send max" button moves
 *     a balance rather than a figure, and if that balance is short of the
 *     committed total the transfer still succeeds, sealing becomes impossible
 *     forever, release() is gated on sealing, there is no sweep, and everything
 *     sent is stranded permanently.
 *
 *  7. THE COMMITMENTS ARE FIXED AT DEPLOYMENT. Beneficiary count, total, TGE
 *     unlock and the schedule hash are constructor arguments held as
 *     immutables. Compute the hash independently from the signed-off allocation
 *     before deploying, at uint128 for `total`. If the loaded table does not
 *     reach all four exactly it cannot be sealed. replaceTable() swaps a
 *     mistyped table, so this is recoverable right up until sealing.
 */
contract HCOWVesting is Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant MONTH = 30 days;
    uint256 public constant BPS = 10_000;
    /// @notice Hard bound so seal() can never become too expensive to call.
    ///         The published allocation uses nine.
    uint256 public constant MAX_BENEFICIARIES = 200;
    /// @notice Deploying with a TGE further out than this is a typo, not a plan.
    uint256 public constant MAX_TGE_HORIZON = 365 days;
    /// @notice Plausibility bound on cliff + linear. The published allocation's
    ///         longest schedule is 48 months. Both fields are uint16, so without
    ///         this a transposed or mistyped value up to 65,535 months is
    ///         accepted silently: it does not move totalScheduled, it does not
    ///         move the beneficiary count, and it does not move the reported TGE
    ///         unlock whenever that schedule's immediate unlock is zero. The
    ///         commitment hash catches it, but only at seal, and this catches it
    ///         at the moment of entry instead.
    uint256 public constant MAX_VESTING_MONTHS = 120;

    struct Schedule {
        uint128 total;        // total tokens for this beneficiary
        uint128 released;     // already released
        uint16 tgeBps;        // unlocked at TGE, in basis points of total
        uint16 cliffMonths;   // months after TGE before linear release starts
        uint16 linearMonths;  // months over which the remainder releases
        bool exists;
    }

    IERC20 public immutable token;
    /// @notice Token supply as it stood when this contract was deployed.
    ///         The bound below is a sanity check on data entry, so it is taken
    ///         once. Reading live totalSupply() instead would mean that a burn
    ///         of one wei by any holder, at any time before the last schedule
    ///         is added, permanently blocks loading the published table.
    uint256 public immutable supplyCap;
    /// @notice Unix seconds. All cliff and linear maths are measured from here.
    uint256 public immutable tgeTime;

    /// @notice The four figures the loaded table must reach before it can be
    ///         sealed, fixed at deployment.
    ///
    ///         They used to be seal() arguments. An owner who had loaded the
    ///         table it intended satisfied that check by reading the live
    ///         values straight back off this contract, which made it a
    ///         restatement rather than a verification: a table diverting twenty
    ///         million tokens seals cleanly as long as the caller passes the
    ///         figures that table produces. Fixed here, before a single
    ///         schedule exists and before the token has moved, they are a
    ///         commitment made in advance and the self-referential form is not
    ///         available. replaceTable() is what makes this safe to do, because
    ///         otherwise one mistyped row would be unrecoverable.
    uint256 public immutable expectedBeneficiaries;
    uint256 public immutable expectedScheduled;
    uint256 public immutable expectedTgeUnlock;
    bytes32 public immutable expectedScheduleHash;

    /// @notice Where a foreign token sent here by mistake can be pushed. Fixed
    ///         at deployment so that recovering one needs no live owner, which
    ///         matters because this contract deliberately has none after
    ///         sealing. It can never move the vesting token.
    address public immutable rescueRecipient;

    mapping(address => Schedule) public schedules;
    address[] private _beneficiaries;

    /// @notice Sum of `total` across every schedule.
    uint256 public totalScheduled;
    /// @notice Sum of `released` across every schedule.
    uint256 public totalReleased;
    /// @notice Once true, no schedule can ever be added.
    bool public sealed_;
    /// @notice Running commitment over every schedule as it was added, in
    ///         order, field by field. seal() checks it.
    ///
    ///         totalScheduled, totalTgeUnlock and the beneficiary count are all
    ///         invariant under a transposition of cliffMonths and linearMonths,
    ///         which is the likeliest mistake in a five argument call with two
    ///         adjacent same typed arguments. That mistake is irreversible and
    ///         it is invisible to every other check in this contract. This is
    ///         the only field that moves when it happens.
    bytes32 public scheduleHash;

    event ScheduleAdded(
        address indexed beneficiary,
        uint256 total,
        uint16 tgeBps,
        uint16 cliffMonths,
        uint16 linearMonths
    );
    event Released(address indexed beneficiary, uint256 amount);
    event Sealed(uint256 beneficiaryCount, uint256 totalScheduled);
    event TableReset(uint256 clearedBeneficiaries, uint256 clearedTotal);
    event ForeignTokenRescued(address indexed token, address indexed to, uint256 amount);

    error AlreadySealed();
    error ScheduleExists();
    error ZeroAddress();
    /// @notice rescueRecipient is immutable and there is no owner after
    ///         sealing, so it may be neither this contract nor the vesting
    ///         token: both make the rescue path permanently useless.
    error InvalidRescueRecipient();
    error ZeroAmount();
    error InvalidBps();
    error NoSchedule();
    error NothingToRelease();
    error TgeInThePast();
    error ExceedsTokenSupply();
    error NotFunded(uint256 required, uint256 held);
    error NotSealed();
    error AddAfterTge();
    error TooManyBeneficiaries();
    error TgeTooFar();
    error NoSchedules();
    error CommitmentMismatch(uint256 scheduled, uint256 tgeUnlock);
    error DegenerateSchedule();
    error BadBeneficiary();
    error LengthMismatch();
    error VestingTooLong(uint256 months_);
    error IndexOutOfBounds(uint256 index, uint256 length);
    error OwnershipIsPermanent();
    error CannotRescueVestingToken();
    error NothingToRescue();
    error CommittedTotalExceedsLiveSupply(uint256 committed, uint256 liveSupply);

    /**
     * @param token_ HCOW token address.
     * @param tgeTime_ TGE timestamp. Must be in the future at deploy time.
     * @param owner_ Address allowed to add schedules until seal().
     *               Its power ends permanently once seal() is called.
     * @param rescueRecipient_ Where a foreign token sent here by mistake goes.
     * @param expectedBeneficiaries_ Rows in the published allocation.
     * @param expectedScheduled_ Sum of every row.
     * @param expectedTgeUnlock_ What the table releases at tgeTime.
     * @param expectedScheduleHash_ Commitment over every row, in order, field
     *        by field. Compute it independently from the signed-off allocation
     *        before deploying. `total` is uint128 in the preimage; computing it
     *        at 256 bits produces a different hash and this contract will then
     *        refuse to seal.
     */
    constructor(
        address token_,
        uint256 tgeTime_,
        address owner_,
        address rescueRecipient_,
        uint256 expectedBeneficiaries_,
        uint256 expectedScheduled_,
        uint256 expectedTgeUnlock_,
        bytes32 expectedScheduleHash_
    ) Ownable(owner_) {
        if (token_ == address(0) || owner_ == address(0) || rescueRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        // rescueRecipient is immutable and there is no owner after sealing, so
        // a wrong value here is permanent. address(this) makes
        // rescueForeignToken a no-op that never even reverts NothingToRescue,
        // killing the only recovery route for a mis-sent token; address(token_)
        // sends rescued tokens to the HCOW contract itself, where nothing can
        // retrieve them.
        if (rescueRecipient_ == address(this) || rescueRecipient_ == token_) {
            revert InvalidRescueRecipient();
        }
        if (tgeTime_ <= block.timestamp) revert TgeInThePast();
        if (tgeTime_ > block.timestamp + MAX_TGE_HORIZON) revert TgeTooFar();
        // Every commitment this error names has to be one a table can
        // actually satisfy, or the contract is unsealable from birth.
        //
        // expectedTgeUnlock_ was reported by this revert and constrained by
        // nothing. totalTgeUnlock() can never exceed totalScheduled, so any
        // expectedTgeUnlock_ above expectedScheduled_ - a decimal slip, or the
        // figure entered in tokens rather than wei - makes the tgeUnlock branch
        // of _seal unsatisfiable for EVERY possible table. Both values are
        // immutable, so replaceTable cannot help and the only remedy is a
        // redeploy. fundAndSeal is atomic, so on the intended path nothing is
        // lost; off it, HCOW transferred to a contract that can never seal is
        // stranded permanently, because release() is gated on sealed_ and
        // rescueForeignToken refuses the vesting token. One comparison here
        // closes that at deploy time, before any token can move.
        if (
            expectedBeneficiaries_ == 0 ||
            expectedBeneficiaries_ > MAX_BENEFICIARIES ||
            expectedScheduled_ == 0 ||
            expectedTgeUnlock_ > expectedScheduled_ ||
            expectedScheduleHash_ == bytes32(0)
        ) revert CommitmentMismatch(expectedScheduled_, expectedTgeUnlock_);
        token = IERC20(token_);
        tgeTime = tgeTime_;
        rescueRecipient = rescueRecipient_;
        expectedBeneficiaries = expectedBeneficiaries_;
        expectedScheduled = expectedScheduled_;
        expectedTgeUnlock = expectedTgeUnlock_;
        expectedScheduleHash = expectedScheduleHash_;
        uint256 cap = IERC20(token_).totalSupply();
        // A zero cap refuses every addSchedule, and with no schedules seal()
        // reverts NoSchedules, ownership cannot be renounced and tgeTime cannot
        // be changed: the contract is born dead. It is what deploying against a
        // token that has not minted yet looks like. HCOWToken mints in its own
        // constructor so this cannot happen with it, but the contract should
        // not depend on that to avoid bricking.
        if (cap == 0) revert ExceedsTokenSupply();
        if (expectedScheduled_ > cap) revert ExceedsTokenSupply();
        supplyCap = cap;
    }

    // ---------------------------------------------------------------- admin

    function addSchedule(
        address beneficiary,
        uint128 total,
        uint16 tgeBps,
        uint16 cliffMonths,
        uint16 linearMonths
    ) public onlyOwner {
        if (sealed_) revert AlreadySealed();
        // A schedule added at or after TGE can unlock in the block it is
        // written, which is the whole of the owner's remaining power. Closing
        // this door here is what lets seal() stay callable after TGE, and a
        // seal() that stays callable is what stops a missed deadline from
        // locking the entire balance forever.
        if (block.timestamp >= tgeTime) revert AddAfterTge();
        if (beneficiary == address(0)) revert ZeroAddress();
        // This contract and the token itself both accept transfers, so a
        // schedule pointing at either is paid out and lost with no error.
        if (beneficiary == address(this) || beneficiary == address(token)) {
            revert BadBeneficiary();
        }
        if (total == 0) revert ZeroAmount();
        if (tgeBps > BPS) revert InvalidBps();
        // With no cliff and no linear period there is nothing left to vest, so
        // the whole allocation lands at TGE whatever tgeBps says. All three
        // zero is the default initialised struct; a partial tgeBps with both
        // periods zero is a dropped or defaulted linearMonths argument. Both
        // report a TGE unlock that is not the one that happens, which defeats
        // the commitment seal() checks. Neither is ever a real schedule.
        if (cliffMonths == 0 && linearMonths == 0 && tgeBps != BPS) revert DegenerateSchedule();
        {
            uint256 span = uint256(cliffMonths) + uint256(linearMonths);
            if (span > MAX_VESTING_MONTHS) revert VestingTooLong(span);
        }
        if (schedules[beneficiary].exists) revert ScheduleExists();
        if (_beneficiaries.length >= MAX_BENEFICIARIES) revert TooManyBeneficiaries();

        schedules[beneficiary] = Schedule({
            total: total,
            released: 0,
            tgeBps: tgeBps,
            cliffMonths: cliffMonths,
            linearMonths: linearMonths,
            exists: true
        });
        _beneficiaries.push(beneficiary);
        totalScheduled += total;
        // Sanity bound. Scheduling more than exists can only be a data entry
        // error, and it would be discovered later as an unfundable contract.
        if (totalScheduled > supplyCap) revert ExceedsTokenSupply();
        scheduleHash = keccak256(
            abi.encodePacked(scheduleHash, beneficiary, total, tgeBps, cliffMonths, linearMonths)
        );

        emit ScheduleAdded(beneficiary, total, tgeBps, cliffMonths, linearMonths);
    }

    function addSchedules(
        address[] calldata beneficiaries,
        uint128[] calldata totals,
        uint16[] calldata tgeBpsList,
        uint16[] calldata cliffMonthsList,
        uint16[] calldata linearMonthsList
    ) external onlyOwner {
        uint256 n = beneficiaries.length;
        if (
            totals.length != n ||
            tgeBpsList.length != n ||
            cliffMonthsList.length != n ||
            linearMonthsList.length != n
        ) revert LengthMismatch();
        for (uint256 i = 0; i < n; ++i) {
            addSchedule(beneficiaries[i], totals[i], tgeBpsList[i], cliffMonthsList[i], linearMonthsList[i]);
        }
    }

    /**
     * @notice Replaces the entire loaded table in one transaction. Owner only,
     *         before sealing and before TGE.
     *
     * @dev Adding a schedule writes four pieces of state and none of them could
     *      be undone. There was no way to remove or amend an entry, and the
     *      only bound applied at entry is that the running total must not
     *      exceed the supply figure snapshotted at deployment, so a mistyped
     *      amount well inside that limit was accepted silently and could not be
     *      corrected: the contract had to be redeployed and every address in
     *      the table re-collected. That is the audit's Medium #2.
     *
     *      IT CLEARS AND RELOADS IN ONE CALL, DELIBERATELY. The first version
     *      of this was a bare `resetTable()` that only cleared, and it created
     *      a permanent total-loss path that did not exist before it: clear a
     *      funded table, fail to rebuild it before TGE, and `addSchedule` is
     *      closed, `seal()` reverts NoSchedules forever, `release()` is gated
     *      on the seal, and there is no sweep. Measured on that version: one
     *      call, 3,000,000 HCOW stranded permanently.
     *
     *      Guarding it on the contract being empty was the obvious fix and the
     *      wrong one: anyone can send one wei of HCOW to this address before
     *      the table is loaded and disable the correction path for good. This
     *      form has neither problem. The table is never observable in the empty
     *      state, so there is nothing to fail to rebuild, and a dusted contract
     *      is still correctable.
     *
     *      What it does NOT grant: the owner still cannot reach a seal that
     *      misses the four commitments fixed at deployment, and after the seal
     *      this is refused like everything else.
     */
    function replaceTable(
        address[] calldata beneficiaries,
        uint128[] calldata totals,
        uint16[] calldata tgeBpsList,
        uint16[] calldata cliffMonthsList,
        uint16[] calldata linearMonthsList
    ) external onlyOwner {
        if (sealed_) revert AlreadySealed();
        if (block.timestamp >= tgeTime) revert AddAfterTge();

        uint256 n = beneficiaries.length;
        if (n == 0) revert NoSchedules();
        if (
            totals.length != n ||
            tgeBpsList.length != n ||
            cliffMonthsList.length != n ||
            linearMonthsList.length != n
        ) revert LengthMismatch();

        uint256 old = _beneficiaries.length;
        uint256 clearedTotal = totalScheduled;
        for (uint256 i = 0; i < old; ++i) {
            delete schedules[_beneficiaries[i]];
        }
        delete _beneficiaries;
        totalScheduled = 0;
        scheduleHash = bytes32(0);
        emit TableReset(old, clearedTotal);

        for (uint256 i = 0; i < n; ++i) {
            addSchedule(beneficiaries[i], totals[i], tgeBpsList[i], cliffMonthsList[i], linearMonthsList[i]);
        }
    }

    /**
     * @notice Irreversible. After this the owner has no power.
     *
     * @dev The caller states what it expects the loaded schedule to add up to,
     *      and the contract refuses to seal unless it agrees. Reading the two
     *      figures back and eyeballing them is the step that gets skipped, and
     *      the failure it is meant to catch does not move either of them: the
     *      allocation table has two community tranches with different linear
     *      periods, and merging them into one entry leaves totalScheduled and
     *      totalTgeUnlock exactly right while the schedule is wrong. Passing
     *      beneficiaryCount as well is what makes that visible.
     *
     * @dev Sealing an underfunded contract cannot be undone and cannot be
     *      repaired by anyone: release() pays whoever asks first, so early
     *      beneficiaries drain the balance and the rest revert forever with no
     *      owner left to act. The check is here rather than in a runbook
     *      because the runbook is the thing that gets skipped at four in the
     *      morning on TGE day.
     *
     * @dev `expectedTgeUnlock` is what the loaded table releases at `tgeTime`,
     *      which is a property of the table and not of the moment this is
     *      called. Sealing late does not change it and does not change what any
     *      beneficiary receives; it only means more of the schedule has already
     *      matured by the time the switch is thrown. The figure to sign off is
     *      always the one from the published allocation.
     *
     *      It also closes the window this contract's owner key is exposed in.
     *      Be precise about what that window is, because an earlier version of
     *      this comment overstated it in both places it appeared, and a
     *      published verified source that describes a theft path which does
     *      not exist will be quoted back by whoever reads it.
     *
     *      A pre-seal owner key CANNOT take the balance. release() reverts
     *      NotSealed until sealed_ is set, sealed_ is set only by _seal(), and
     *      _seal() requires all four immutable commitments to match, including
     *      scheduleHash. That hash chains every row's beneficiary, total,
     *      tgeBps, cliffMonths and linearMonths in order, so adding a schedule
     *      for the owner moves the hash, the count and the total at once and
     *      the contract can no longer be sealed at all. The owner cannot both
     *      include the row and seal, and the only way to remove it is
     *      replaceTable, which rebuilds the honest table.
     *
     *      What the key can do before sealing is DENY: load a table that does
     *      not match the commitments and decline to fix it, leaving a contract
     *      that can never be sealed. Nobody is paid and, if HCOW was
     *      transferred to it outside fundAndSeal, that HCOW is stranded.
     *      fundAndSeal is atomic, so on the intended path a failing seal
     *      unwinds the transfer and nothing moves. Fund, verify and seal in one
     *      session and the window is as short as the transaction takes.
     */
    function seal() external {
        _authoriseSeal();
        _seal();
    }

    /**
     * @notice Pulls exactly the outstanding shortfall from the caller and seals
     *         in the same transaction. This is the intended way to bring the
     *         contract live.
     *
     * @dev Sealing requires the contract to already hold the committed total,
     *      so a funded-and-unsealed state was structurally unavoidable and no
     *      amount of care with the ordering could close it. Only atomicity
     *      closes it, and this is that.
     *
     *      It also removes the funding failure that ordering could not fix.
     *      Transferring the exact committed total is safe: a shortfall reverts
     *      and nothing moves. Transferring the balance you happen to hold is
     *      not, and it is what a wallet's "send max" button does: the transfer
     *      succeeds, the contract cannot reach the committed total, seal is
     *      impossible forever, release is gated on seal, there is no sweep, and
     *      the entire amount is stranded for the life of the chain. The same
     *      button, one path safe and one path total loss.
     *
     *      Here the contract computes the figure itself and pulls it. There is
     *      no amount to type, so there is no wrong amount to type. Approve at
     *      least fundingShortfall() and call this.
     */
    function fundAndSeal() external {
        _authoriseSeal();
        uint256 owed = totalScheduled - totalReleased;
        uint256 held = token.balanceOf(address(this));
        if (held < owed) {
            token.safeTransferFrom(msg.sender, address(this), owed - held);
        }
        _seal();
    }

    function _authoriseSeal() private view {
        // Owner only until TGE, then anyone. Before TGE the owner is still
        // loading the table and nobody else should be able to freeze it half
        // written. At TGE the table is frozen anyway, addSchedule is closed,
        // and the four commitments are immutable figures fixed before any
        // schedule existed, so the only thing another caller can do is finish a
        // job that was left undone. Leaving it owner only past that point means
        // an owner key that is lost, frozen or simply unwilling holds every
        // beneficiary's tokens hostage forever, with no sweep and no recovery.
        if (block.timestamp < tgeTime && msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }

    function _seal() private {
        if (sealed_) revert AlreadySealed();
        // There is deliberately no deadline here. addSchedule is what closes at
        // TGE; sealing is the act that ends the owner's power and it must never
        // become impossible, because release() is gated on it and there is no
        // sweep. A deadline on this function turns a missed calendar date into
        // the permanent loss of everything the contract holds.
        if (_beneficiaries.length == 0) revert NoSchedules();

        uint256 tgeUnlock = totalTgeUnlock();
        if (
            _beneficiaries.length != expectedBeneficiaries ||
            totalScheduled != expectedScheduled ||
            tgeUnlock != expectedTgeUnlock ||
            scheduleHash != expectedScheduleHash
        ) revert CommitmentMismatch(totalScheduled, tgeUnlock);

        // supplyCap is a snapshot taken at deployment, deliberately, so that a
        // burn of one wei by any holder cannot block loading the published
        // table halfway through. It is a data entry bound, not a solvency one.
        // Solvency is checked here instead, against live supply, because a
        // committed total above what actually exists can never be funded and
        // the honest place to discover that is before any token has moved
        // rather than after.
        uint256 liveSupply = token.totalSupply();
        if (totalScheduled > liveSupply) {
            revert CommittedTotalExceedsLiveSupply(totalScheduled, liveSupply);
        }

        uint256 owed = totalScheduled - totalReleased;
        uint256 held = token.balanceOf(address(this));
        if (held < owed) revert NotFunded(owed, held);

        sealed_ = true;
        // A transfer started before sealing must not be able to complete after
        // it. Nothing an owner can do post seal has any effect, but an explorer
        // showing a live pending administrator invites the question.
        _transferOwnership(owner());
        emit Sealed(_beneficiaries.length, totalScheduled);
    }

    // ------------------------------------------------------------- release

    /// @notice Permissionless. Tokens always go to `beneficiary`.
    function release(address beneficiary) external {
        // Nothing leaves before the schedule set is final. Without this, the
        // window between funding and sealing is one in which the owner can
        // write a schedule for itself at a full unlock and walk out with
        // whatever the contract holds above what is already committed.
        if (!sealed_) revert NotSealed();

        Schedule storage s = schedules[beneficiary];
        if (!s.exists) revert NoSchedule();

        uint256 amount = releasable(beneficiary);
        if (amount == 0) revert NothingToRelease();

        s.released += uint128(amount);
        totalReleased += amount;

        // Emitted before the external call so that both state and events follow
        // checks-effects-interactions. A hostile token cannot observe or exploit
        // an intermediate state: re-entering release() finds nothing releasable.
        emit Released(beneficiary, amount);

        token.safeTransfer(beneficiary, amount);
    }

    /**
     * @dev Ownership is frozen once the schedule set is final.
     *
     * The claim made to holders is that after sealing nobody has any power over
     * this contract. Leaving the ownership functions live does not create a
     * fund risk, since no owner function does anything any more, but it leaves
     * an owner address that can still be moved, which reads on an explorer as
     * a live administrator and is exactly the sort of thing a listing review
     * asks about. Make the claim true rather than nearly true.
     */
    function transferOwnership(address newOwner) public override {
        // No onlyOwner here: super.transferOwnership carries it, and applying
        // it twice costs a redundant storage read on every call.
        if (sealed_) revert AlreadySealed();
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        if (sealed_) revert AlreadySealed();
        super.acceptOwnership();
    }

    function renounceOwnership() public pure override {
        // Before sealing this would make seal() uncallable forever, leaving a
        // contract nobody can finish and nobody can add to. After sealing there
        // is nothing left to renounce. Unconditional, and pure, so that the
        // compiler emits no warning about it.
        //
        // The error used to be AlreadySealed, which asserted something false
        // about the contract in the ordinary case where it is not sealed. The
        // real reason is that ownership here is permanent by design.
        revert OwnershipIsPermanent();
    }

    // --------------------------------------------------------------- views

    /// @notice Total vested so far, released or not.
    function vestedAmount(address beneficiary) public view returns (uint256) {
        return _vestedAt(schedules[beneficiary], block.timestamp);
    }

    function _vestedAt(Schedule memory s, uint256 ts) private view returns (uint256) {
        if (!s.exists) return 0;
        if (ts < tgeTime) return 0;

        uint256 tgeAmount = (uint256(s.total) * s.tgeBps) / BPS;
        uint256 remainder = uint256(s.total) - tgeAmount;
        if (remainder == 0) return s.total;

        uint256 cliffEnd = tgeTime + (uint256(s.cliffMonths) * MONTH);
        if (ts < cliffEnd) return tgeAmount;

        uint256 duration = uint256(s.linearMonths) * MONTH;
        if (duration == 0) return s.total;

        uint256 elapsed = ts - cliffEnd;
        if (elapsed >= duration) return s.total;

        return tgeAmount + (remainder * elapsed) / duration;
    }

    function releasable(address beneficiary) public view returns (uint256) {
        return vestedAmount(beneficiary) - schedules[beneficiary].released;
    }

    /// @notice Tokens this contract still needs in order to honour every schedule.
    function fundingShortfall() external view returns (uint256) {
        uint256 owed = totalScheduled - totalReleased;
        uint256 held = token.balanceOf(address(this));
        return held >= owed ? 0 : owed - held;
    }

    /// @notice What this contract will actually release at tgeTime, summed
    ///         across every schedule. Use it to verify the published TGE
    ///         circulating supply before deploying.
    ///
    /// @dev    This runs the same vesting maths release() will run rather than
    ///         summing tgeBps, so the figure seal() commits to is the figure
    ///         that happens. Those two are not the same number for every
    ///         schedule shape, and where they differ it is the tgeBps sum that
    ///         is wrong.
    function totalTgeUnlock() public view returns (uint256 sum) {
        uint256 n = _beneficiaries.length;
        for (uint256 i = 0; i < n; ++i) {
            sum += _vestedAt(schedules[_beneficiaries[i]], tgeTime);
        }
    }

    function beneficiaryCount() external view returns (uint256) {
        return _beneficiaries.length;
    }

    function beneficiaryAt(uint256 i) external view returns (address) {
        // Without this the revert is a low level panic, which is harder for a
        // caller or an indexer to attribute than a named error.
        uint256 n = _beneficiaries.length;
        if (i >= n) revert IndexOutOfBounds(i, n);
        return _beneficiaries[i];
    }

    /// @notice True when the committed total can actually be funded. Check this
    ///         before any funding decision, not after.
    function committedTotalIsFundable() external view returns (bool) {
        return expectedScheduled <= token.totalSupply();
    }

    // -------------------------------------------------------------- rescue

    /**
     * @notice Pushes a foreign token sent here by mistake to the address fixed
     *         at deployment. Permissionless, because after sealing there is no
     *         owner left to call it.
     *
     * @dev The vesting token itself is refused. The audit recommended a bounded
     *      sweep of surplus vesting tokens as well, and that is declined
     *      deliberately: fundAndSeal pulls the exact shortfall, so a surplus has
     *      no way to arise on the intended path, and "there is no sweep" is a
     *      property worth more than a recovery route for a case that should not
     *      occur. Nothing here can reduce what any beneficiary is owed.
     */
    function rescueForeignToken(address foreign) external {
        if (foreign == address(token)) revert CannotRescueVestingToken();
        uint256 amount = IERC20(foreign).balanceOf(address(this));
        if (amount == 0) revert NothingToRescue();
        emit ForeignTokenRescued(foreign, rescueRecipient, amount);
        IERC20(foreign).safeTransfer(rescueRecipient, amount);
    }
}
