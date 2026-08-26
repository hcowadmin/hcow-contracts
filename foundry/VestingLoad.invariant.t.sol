// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {HCOWVesting} from "../contracts/HCOWVesting.sol";
import {HCOWToken} from "../contracts/HCOWToken.sol";

/**
 * @title LoadHandler
 * @notice The loading phase, which the sealed harness never reaches.
 *
 * This is the phase where an irreversible mistake about 200,000,000 tokens is
 * made. Both of the High findings in this contract lived here: a schedule
 * shape that unlocks everything at TGE while reporting otherwise, and a
 * transposition of cliff and linear that every scalar commitment is blind to.
 * The generator therefore produces schedule shapes rather than amounts, and
 * includes the shapes a person would not deliberately type.
 */
contract LoadHandler is Test {
    HCOWVesting public immutable v;
    HCOWToken public immutable t;
    address public immutable owner;

    uint256 public ghostAddedAfterSeal;
    uint256 public ghostAddedAtOrAfterTge;
    uint256 public ghostUnlockMismatch;   // totalTgeUnlock disagreed with what actually releases
    uint256 public ghostSealed;
    uint256 public nextBen = 0x4000;

    constructor(HCOWVesting v_, HCOWToken t_, address owner_) { v = v_; t = t_; owner = owner_; }

    function addSchedule(uint256 amtSeed, uint256 bpsSeed, uint256 clfSeed, uint256 linSeed) external {
        bool wasSealed = v.sealed_();
        bool atOrAfterTge = block.timestamp >= v.tgeTime();
        address b = address(uint160(nextBen++));
        // Large enough that a handful of schedules can reach the supply bound
        // within one run. Bounded small, the supply guard could be deleted and
        // the fuzzer would never generate a table big enough to notice.
        uint128 total = uint128(bound(amtSeed, 1, 60_000_000e18));
        // deliberately includes 0/0 and partial-bps-with-no-periods, the shape
        // a dropped fifth argument produces
        uint16 bps = uint16(bound(bpsSeed, 0, 10_000));
        uint16 clf = uint16(bound(clfSeed, 0, 3));
        uint16 lin = uint16(bound(linSeed, 0, 3));
        vm.prank(owner);
        try v.addSchedule(b, total, bps, clf, lin) {
            if (wasSealed) ghostAddedAfterSeal += 1;
            if (atOrAfterTge) ghostAddedAtOrAfterTge += 1;
        } catch {}
    }

    function fund(uint256 seed) external {
        uint256 amt = bound(seed, 0, t.balanceOf(owner));
        if (amt == 0) return;
        vm.prank(owner);
        t.transfer(address(v), amt);
    }

    function seal(uint256 nSeed) external {
        uint256 n = nSeed % 4 == 0 ? bound(nSeed, 0, 50) : v.beneficiaryCount();
        vm.prank(owner);
        try v.seal(n, v.totalScheduled(), v.totalTgeUnlock(), v.scheduleHash()) {
            ghostSealed += 1;
            // The commitment must be what actually happens. Warp to TGE on a
            // fork of the state and compare; if the two disagree the figure
            // signed off is not the figure that unlocks.
            uint256 snap = vm.snapshotState();
            vm.warp(v.tgeTime());
            uint256 real;
            for (uint256 i = 0; i < v.beneficiaryCount(); ++i) {
                real += v.vestedAmount(v.beneficiaryAt(i));
            }
            uint256 claimed = v.totalTgeUnlock();
            vm.revertToState(snap);
            if (real != claimed) ghostUnlockMismatch += 1;
        } catch {}
    }

    /// Nothing may leave an unsealed contract. Without this action the
    /// property that says so is never exercised.
    function release(uint256 seed) external {
        uint256 n = v.beneficiaryCount();
        if (n == 0) return;
        try v.release(v.beneficiaryAt(bound(seed, 0, n - 1))) {} catch {}
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1, 5 days));
    }
}

contract VestingLoadInvariants is Test {
    HCOWVesting internal v;
    HCOWToken internal t;
    LoadHandler internal handler;
    address internal treasury = address(0x7EA5);

    function setUp() public {
        vm.warp(1_800_000_000);
        t = new HCOWToken(treasury);
        v = new HCOWVesting(address(t), block.timestamp + 10 days, treasury);
        handler = new LoadHandler(v, t, treasury);
        targetContract(address(handler));
    }

    /// Nothing may be added once the set is final.
    function invariant_nothingAddedAfterSeal() public view {
        assertEq(handler.ghostAddedAfterSeal(), 0, "a schedule was added after the seal");
    }

    /// Nothing may be added at or after TGE, or it could unlock in the block
    /// it is written, which is the whole of the owner's remaining power.
    function invariant_nothingAddedAtOrAfterTge() public view {
        assertEq(handler.ghostAddedAtOrAfterTge(), 0, "a schedule was added at or after TGE");
    }

    /**
     * The figure seal() commits to must be the figure that actually releases
     * at TGE. A schedule shape where these diverge is how 27,000,000 becomes
     * 78,000,000 with every check passing.
     */
    function invariant_committedUnlockIsTheRealUnlock() public view {
        assertEq(handler.ghostUnlockMismatch(), 0,
            "the committed TGE unlock is not what the table actually releases");
    }

    /// The supply bound holds however the table is loaded.
    function invariant_neverSchedulesPastSupply() public view {
        assertLe(v.totalScheduled(), t.totalSupply(), "scheduled more than exists");
    }

    /// Nothing can leave before the set is final, whatever is in the contract.
    function invariant_nothingReleasesBeforeSeal() public view {
        if (!v.sealed_()) assertEq(v.totalReleased(), 0, "tokens left an unsealed contract");
    }

    /// The beneficiary cap is real.
    function invariant_beneficiaryCap() public view {
        assertLe(v.beneficiaryCount(), v.MAX_BENEFICIARIES(), "beneficiary cap exceeded");
    }

    /**
     * Every schedule's stated tgeBps must describe what it actually releases
     * at TGE. This is what the degenerate-shape guard is for: a schedule with
     * no cliff and no linear period releases everything at TGE whatever its
     * basis points say, so the number on the allocation table stops being the
     * number that happens.
     */
    function invariant_tgeBpsDescribesTheUnlock() public {
        uint256 n = v.beneficiaryCount();
        if (n == 0) return;
        uint256 snap = vm.snapshotState();
        vm.warp(v.tgeTime());
        for (uint256 i = 0; i < n; ++i) {
            address b = v.beneficiaryAt(i);
            (uint128 total,, uint16 bps,,,) = v.schedules(b);
            assertEq(
                v.vestedAmount(b),
                (uint256(total) * bps) / v.BPS(),
                "a schedule releases something other than its stated TGE basis points"
            );
        }
        vm.revertToState(snap);
    }

    /**
     * The schedule hash the README tells an operator to compute must be the
     * hash the contract computes.
     *
     * This is the fourth seal() argument and the only thing that catches a
     * transposition of cliff and linear, which leaves the count, the scheduled
     * total and the TGE unlock all exactly correct. The operator computes it
     * off-chain from the published table and pastes it in. If the formula in
     * the README is wrong by so much as an argument width, their value never
     * matches, seal() reverts, and the obvious four-in-the-morning recovery is
     * to read scheduleHash() off the contract and paste that back, which turns
     * the check into a tautology and defeats the whole point.
     *
     * So the documented formula is executed here rather than described.
     */
    function test_documentedScheduleHashFormulaIsCorrect() public {
        uint128[3] memory totals = [uint128(60_000_000e18), 20_000_000e18, 10_000_000e18];
        uint16[3] memory bps = [uint16(1500), 2500, 0];
        uint16[3] memory clf = [uint16(0), 0, 12];
        uint16[3] memory lin = [uint16(12), 3, 36];

        // exactly what the README says, widths and all
        bytes32 h = bytes32(0);
        vm.startPrank(treasury);
        for (uint256 i = 0; i < 3; ++i) {
            address b = address(uint160(0x70000 + i));
            v.addSchedule(b, totals[i], bps[i], clf[i], lin[i]);
            h = keccak256(abi.encodePacked(h, b, totals[i], bps[i], clf[i], lin[i]));
        }
        vm.stopPrank();
        assertEq(h, v.scheduleHash(), "the README's scheduleHash formula does not match the contract");

        // and the mistake it exists to catch really does move it
        bytes32 swapped = bytes32(0);
        for (uint256 i = 0; i < 3; ++i) {
            address b = address(uint160(0x70000 + i));
            swapped = keccak256(abi.encodePacked(b, totals[i], bps[i], lin[i], clf[i], swapped));
        }
        assertTrue(swapped != v.scheduleHash(), "a transposed table produced the same hash");

        // the width that is easy to get wrong: uint256 instead of uint128
        bytes32 wide = bytes32(0);
        for (uint256 i = 0; i < 3; ++i) {
            address b = address(uint160(0x70000 + i));
            wide = keccak256(abi.encodePacked(wide, b, uint256(totals[i]), bps[i], clf[i], lin[i]));
        }
        assertTrue(wide != v.scheduleHash(), "a 256 bit total produced the same hash, so the width note is wrong");
    }

    // ------------------------------------------------------- bounded by size

    /**
     * The cap has to be reachable in a plain test; a 128-call fuzz run cannot
     * load two hundred schedules. This also retires the gas question: seal()
     * iterates the whole beneficiary list, and "almost certainly fine" is not
     * a number.
     */
    function test_beneficiaryCapAndSealGas() public {
        uint256 max = v.MAX_BENEFICIARIES();
        vm.startPrank(treasury);
        for (uint256 i = 0; i < max; ++i) {
            v.addSchedule(address(uint160(0x50000 + i)), 1e18, 0, 0, 12);
        }
        assertEq(v.beneficiaryCount(), max, "did not load the full cap");
        vm.expectRevert();
        v.addSchedule(address(uint160(0x60000)), 1e18, 0, 0, 12);

        t.transfer(address(v), v.totalScheduled());
        uint256 scheduled = v.totalScheduled();
        uint256 unlock = v.totalTgeUnlock();
        bytes32 h = v.scheduleHash();
        uint256 before = gasleft();
        v.seal(max, scheduled, unlock, h);
        uint256 used = before - gasleft();
        vm.stopPrank();
        assertTrue(v.sealed_(), "a full table could not be sealed");
        // BSC blocks are far larger than this; the point is that it is a number.
        assertLt(used, 10_000_000, "sealing a full table costs more than ten million gas");
        emit log_named_uint("seal() gas at MAX_BENEFICIARIES", used);
    }
}
