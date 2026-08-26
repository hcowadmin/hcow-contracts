// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {HCOWVesting} from "../contracts/HCOWVesting.sol";
import {HCOWToken} from "../contracts/HCOWToken.sol";

/**
 * @title VestingHandler
 * @notice Bounded action generator. Time is the only real actor here, so the
 *         generator mostly moves the clock and releases, and it deliberately
 *         lands on the boundaries: exactly tgeTime, exactly the cliff, exactly
 *         the final second. Every boundary defect found in this contract by
 *         hand was at one of those three.
 */
contract VestingHandler is Test {
    HCOWVesting public immutable v;
    HCOWToken public immutable t;
    address[] public bens;

    uint256 public ghostOverRelease;      // an account released more than its total
    uint256 public ghostVestWentBackwards;
    mapping(address => uint256) internal lastVested;

    constructor(HCOWVesting v_, HCOWToken t_, address[] memory bens_) {
        v = v_; t = t_;
        for (uint256 i = 0; i < bens_.length; ++i) bens.push(bens_[i]);
    }

    function benCount() external view returns (uint256) { return bens.length; }
    function benAt(uint256 i) external view returns (address) { return bens[i]; }

    function release(uint256 seed) external {
        address b = bens[bound(seed, 0, bens.length - 1)];
        try v.release(b) {} catch {}
        _observe();
    }

    /// Anyone may release for anyone. A stranger must never receive anything.
    function releaseAsStranger(uint256 seed) external {
        address b = bens[bound(seed, 0, bens.length - 1)];
        vm.prank(address(0xDEADBEEF));
        try v.release(b) {} catch {}
        _observe();
    }

    /**
     * Time only moves forward. A chain cannot rewind, and letting the
     * generator do so makes the monotonicity property meaningless: the first
     * version of this handler warped back to just before TGE and then reported
     * the contract for "vesting going backwards", which it had not.
     *
     * The targets are the boundaries, because every boundary defect found in
     * this contract by hand was at exactly TGE, exactly a cliff, or exactly the
     * final second.
     */
    function warp(uint256 seed) external {
        uint256 k = seed % 6;
        uint256 tge = v.tgeTime();
        uint256 M = v.MONTH();
        uint256 target;
        if (k == 0) target = tge;
        else if (k == 1) target = tge - 1;
        else if (k == 2) target = tge + M * 12;
        else if (k == 3) target = tge + M * 48;
        else if (k == 4) target = tge + M * 48 + 1;
        else target = block.timestamp + bound(seed, 1, 200 days);
        if (target > block.timestamp) vm.warp(target);
        _observe();
    }

    function _observe() internal {
        for (uint256 i = 0; i < bens.length; ++i) {
            address b = bens[i];
            (uint128 total, uint128 released,,,,) = v.schedules(b);
            if (released > total) ghostOverRelease += 1;
            uint256 vested = v.vestedAmount(b);
            if (vested < lastVested[b]) ghostVestWentBackwards += 1;
            lastVested[b] = vested;
        }
    }
}

/**
 * @title VestingInvariants
 * @notice The properties that matter for a contract holding 100% of supply.
 *
 * Run: forge test --match-contract VestingInvariants
 */
contract VestingInvariants is Test {
    HCOWVesting internal v;
    HCOWToken internal t;
    VestingHandler internal handler;
    address internal treasury = address(0x7EA5);

    uint256 internal constant E18 = 1e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        t = new HCOWToken(treasury);
        uint256 tge = block.timestamp + 10 days;
        v = new HCOWVesting(address(t), tge, treasury);

        // the published allocation, loaded exactly as the runbook says
        address[] memory bens = new address[](9);
        uint128[9] memory totals =
            [uint128(60_000_000e18), 40_000_000e18, 20_000_000e18, 8_000_000e18,
             12_000_000e18, 20_000_000e18, 16_000_000e18, 14_000_000e18, 10_000_000e18];
        uint16[9] memory bps  = [uint16(1500), 750, 2500, 3750, 0, 0, 0, 5000, 0];
        uint16[9] memory clf  = [uint16(0), 6, 0, 0, 0, 6, 12, 0, 12];
        uint16[9] memory lin  = [uint16(12), 12, 3, 6, 24, 42, 36, 12, 36];

        vm.startPrank(treasury);
        for (uint256 i = 0; i < 9; ++i) {
            bens[i] = address(uint160(0x3000 + i));
            v.addSchedule(bens[i], totals[i], bps[i], clf[i], lin[i]);
        }
        t.transfer(address(v), v.totalScheduled());
        v.seal(9, v.totalScheduled(), v.totalTgeUnlock(), v.scheduleHash());
        vm.stopPrank();

        handler = new VestingHandler(v, t, bens);
        targetContract(address(handler));
    }

    /// The published figures. If any of these move, the table was not loaded.
    function invariant_publishedAllocation() public view {
        assertEq(v.totalScheduled(), 200_000_000e18, "scheduled total is not 200,000,000");
        assertEq(v.beneficiaryCount(), 9, "beneficiary count is not nine");
        assertEq(v.totalTgeUnlock(), 27_000_000e18, "TGE unlock is not 27,000,000");
    }

    /// The contract can always pay everything it still owes.
    function invariant_solvent() public view {
        uint256 owed = v.totalScheduled() - v.totalReleased();
        assertGe(t.balanceOf(address(v)), owed, "vesting holds less than it owes");
    }

    /// Nobody can ever be paid more than their schedule.
    function invariant_neverOverReleases() public view {
        assertEq(handler.ghostOverRelease(), 0, "an account released more than its total");
    }

    /// Vesting is monotonic in time. A schedule that goes backwards is a bug
    /// that would let a beneficiary be paid twice across a boundary.
    function invariant_vestingMonotonic() public view {
        assertEq(handler.ghostVestWentBackwards(), 0, "vestedAmount decreased as time moved forward");
    }

    /// Released must sum to totalReleased, and every token released must have
    /// reached the beneficiary rather than the caller.
    function invariant_releasedGoesToBeneficiaries() public view {
        uint256 sumReleased;
        uint256 sumHeld;
        uint256 n = handler.benCount();
        for (uint256 i = 0; i < n; ++i) {
            (, uint128 released,,,,) = v.schedules(handler.benAt(i));
            sumReleased += released;
            sumHeld += t.balanceOf(handler.benAt(i));
        }
        assertEq(sumReleased, v.totalReleased(), "released amounts do not sum to totalReleased");
        assertEq(sumHeld, v.totalReleased(), "released tokens did not all reach beneficiaries");
        assertEq(t.balanceOf(address(0xDEADBEEF)), 0, "a caller received tokens");
    }

    /// Supply is fixed and the contract cannot mint.
    function invariant_supplyFixed() public view {
        assertEq(t.totalSupply(), 200_000_000e18, "token supply moved");
    }

    /**
     * After the seal the owner has no power at all. This is the claim made to
     * holders, so it is asserted rather than described.
     *
     * A plain test rather than an invariant: expectRevert inside an invariant
     * function runs during environment setup, where it does not mean what it
     * looks like it means.
     */
    function test_ownerIsPowerlessAfterSeal() public {
        // Read the arguments first. expectRevert applies to the very next
        // call, and a view call inside an argument list is that next call.
        uint256 scheduled = v.totalScheduled();
        uint256 unlock = v.totalTgeUnlock();
        bytes32 h = v.scheduleHash();

        vm.startPrank(treasury);
        vm.expectRevert();
        v.addSchedule(address(0xBEEF), 1e18, 0, 0, 12);
        vm.expectRevert();
        v.seal(9, scheduled, unlock, h);
        vm.expectRevert();
        v.transferOwnership(address(0xBEEF));
        vm.expectRevert();
        v.renounceOwnership();
        vm.stopPrank();

        // and a stranger has none either
        vm.startPrank(address(0xBEEF));
        vm.expectRevert();
        v.addSchedule(address(0xBEEF), 1e18, 0, 0, 12);
        vm.expectRevert();
        v.acceptOwnership();
        vm.stopPrank();
    }
}
