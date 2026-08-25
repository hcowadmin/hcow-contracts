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
 *  2. THE OWNER CAN ONLY ADD SCHEDULES, AND ONLY UNTIL SEALED. After seal()
 *     no schedule can ever be added. Call seal() before TGE. From that moment
 *     the owner has no remaining power over this contract at all.
 *
 *  3. RELEASE IS PERMISSIONLESS. Anyone may call release(beneficiary). Tokens
 *     always go to the beneficiary, never to the caller. This means a
 *     beneficiary who loses access to gas can still be paid, and it makes the
 *     contract usable by automation.
 *
 *  4. TIME IS ABSOLUTE, NOT RELATIVE TO DEPOSIT. `tgeTime` is set once at
 *     construction. Cliff and linear duration are measured from it. A schedule
 *     added after TGE therefore vests correctly for elapsed time.
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

    struct Schedule {
        uint128 total;        // total tokens for this beneficiary
        uint128 released;     // already released
        uint16 tgeBps;        // unlocked at TGE, in basis points of total
        uint16 cliffMonths;   // months after TGE before linear release starts
        uint16 linearMonths;  // months over which the remainder releases
        bool exists;
    }

    IERC20 public immutable token;
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

    /**
     * @param token_ HCOW token address.
     * @param tgeTime_ TGE timestamp. Must be in the future at deploy time.
     * @param owner_ Address allowed to add schedules until seal().
     *               Its power ends permanently once seal() is called.
     */
    constructor(address token_, uint256 tgeTime_, address owner_) Ownable(owner_) {
        if (token_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (tgeTime_ <= block.timestamp) revert TgeInThePast();
        token = IERC20(token_);
        tgeTime = tgeTime_;
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
        if (beneficiary == address(0)) revert ZeroAddress();
        if (total == 0) revert ZeroAmount();
        if (tgeBps > BPS) revert InvalidBps();
        if (schedules[beneficiary].exists) revert ScheduleExists();

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
        if (totalScheduled > IERC20Supply(address(token)).totalSupply()) revert ExceedsTokenSupply();

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
     * @notice Irreversible. Call before TGE. After this the owner has no power.
     *
     * @dev Sealing an underfunded contract cannot be undone and cannot be
     *      repaired by anyone: release() pays whoever asks first, so early
     *      beneficiaries drain the balance and the rest revert forever with no
     *      owner left to act. The check is here rather than in a runbook
     *      because the runbook is the thing that gets skipped at four in the
     *      morning on TGE day.
     *
     *      It also closes the window this contract's owner key is exposed in:
     *      before sealing, that key can add a schedule for itself at a full
     *      TGE unlock and take the balance. Fund, verify, and seal in one
     *      session, and that window is as short as the transactions take.
     */
    function seal() external onlyOwner {
        if (sealed_) revert AlreadySealed();
        uint256 owed = totalScheduled - totalReleased;
        uint256 held = token.balanceOf(address(this));
        if (held < owed) revert NotFunded(owed, held);
        sealed_ = true;
        emit Sealed(_beneficiaries.length, totalScheduled);
    }

    // ------------------------------------------------------------- release

    /// @notice Permissionless. Tokens always go to `beneficiary`.
    function release(address beneficiary) external {
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

    // --------------------------------------------------------------- views

    /// @notice Total vested so far, released or not.
    function vestedAmount(address beneficiary) public view returns (uint256) {
        Schedule memory s = schedules[beneficiary];
        if (!s.exists) return 0;
        if (block.timestamp < tgeTime) return 0;

        uint256 tgeAmount = (uint256(s.total) * s.tgeBps) / BPS;
        uint256 remainder = uint256(s.total) - tgeAmount;
        if (remainder == 0) return s.total;

        uint256 cliffEnd = tgeTime + (uint256(s.cliffMonths) * MONTH);
        if (block.timestamp < cliffEnd) return tgeAmount;

        uint256 duration = uint256(s.linearMonths) * MONTH;
        if (duration == 0) return s.total;

        uint256 elapsed = block.timestamp - cliffEnd;
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

    /// @notice Sum of every schedule's TGE unlock. Use this to verify the
    ///         published TGE circulating supply before deploying.
    function totalTgeUnlock() external view returns (uint256 sum) {
        uint256 n = _beneficiaries.length;
        for (uint256 i = 0; i < n; ++i) {
            Schedule memory s = schedules[_beneficiaries[i]];
            sum += (uint256(s.total) * s.tgeBps) / BPS;
        }
    }

    function beneficiaryCount() external view returns (uint256) {
        return _beneficiaries.length;
    }

    function beneficiaryAt(uint256 i) external view returns (address) {
        return _beneficiaries[i];
    }
}
