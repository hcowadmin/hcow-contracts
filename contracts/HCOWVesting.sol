// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IERC20Supply {
    function totalSupply() external view returns (uint256);
}

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
 *     Transfer the total of all schedules to this contract before TGE.
 *     totalScheduled() tells you exactly how much that is, and
 *     fundingShortfall() tells you how much is still missing.
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

    error AlreadySealed();
    error ScheduleExists();
    error ZeroAddress();
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

    /**
     * @param token_ HCOW token address.
     * @param tgeTime_ TGE timestamp. Must be in the future at deploy time.
     * @param owner_ Address allowed to add schedules until seal().
     *               Its power ends permanently once seal() is called.
     */
    constructor(address token_, uint256 tgeTime_, address owner_) Ownable(owner_) {
        if (token_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (tgeTime_ <= block.timestamp) revert TgeInThePast();
        if (tgeTime_ > block.timestamp + MAX_TGE_HORIZON) revert TgeTooFar();
        token = IERC20(token_);
        tgeTime = tgeTime_;
        uint256 cap = IERC20Supply(token_).totalSupply();
        // A zero cap refuses every addSchedule, and with no schedules seal()
        // reverts NoSchedules, ownership cannot be renounced and tgeTime cannot
        // be changed: the contract is born dead. It is what deploying against a
        // token that has not minted yet looks like. HCOWToken mints in its own
        // constructor so this cannot happen with it, but the contract should
        // not depend on that to avoid bricking.
        if (cap == 0) revert ExceedsTokenSupply();
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
        require(
            totals.length == n &&
                tgeBpsList.length == n &&
                cliffMonthsList.length == n &&
                linearMonthsList.length == n,
            "length mismatch"
        );
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
     *      It also closes the window this contract's owner key is exposed in:
     *      before sealing, that key can add a schedule for itself at a full
     *      TGE unlock and take the balance. Fund, verify, and seal in one
     *      session, and that window is as short as the transactions take.
     */
    function seal(
        uint256 expectedBeneficiaries,
        uint256 expectedScheduled,
        uint256 expectedTgeUnlock,
        bytes32 expectedScheduleHash
    ) external {
        // Owner only until TGE, then anyone. Before TGE the owner is still
        // loading the table and nobody else should be able to freeze it half
        // written. At TGE the table is frozen anyway, addSchedule is closed,
        // and the four commitments have to match figures that are already
        // public, so the only thing another caller can do is finish a job that
        // was left undone. Leaving it owner only past that point means an owner
        // key that is lost, frozen or simply unwilling holds every
        // beneficiary's tokens hostage forever, with no sweep and no recovery.
        if (block.timestamp < tgeTime && msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
        if (sealed_) revert AlreadySealed();
        // There is deliberately no deadline here. addSchedule is what closes at
        // TGE; sealing is the act that ends the owner's power and it must never
        // become impossible, because release() is gated on it and there is no
        // sweep. A deadline on this function turns a missed calendar date into
        // the permanent loss of everything the contract holds.
        if (_beneficiaries.length == 0) revert NoSchedules();
        if (
            _beneficiaries.length != expectedBeneficiaries ||
            totalScheduled != expectedScheduled ||
            totalTgeUnlock() != expectedTgeUnlock ||
            scheduleHash != expectedScheduleHash
        ) revert CommitmentMismatch(totalScheduled, totalTgeUnlock());

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
    function transferOwnership(address newOwner) public override onlyOwner {
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
        revert AlreadySealed();
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
        return _beneficiaries[i];
    }
}
