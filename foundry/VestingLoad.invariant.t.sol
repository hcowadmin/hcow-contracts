// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {HCOWVesting} from "../contracts/HCOWVesting.sol";
import {HCOWToken} from "../contracts/HCOWToken.sol";
import {Commit} from "./Commit.sol";

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
    uint256 public ghostSealedOffCommitment; // sealed while the table was not the committed one
    uint256 public ghostResets;
    uint256 public nextBen = 0x4000;

    /// The table the contract was deployed against. addTargetRow walks it in
    /// order; addJunkRow adds anything else. Seal can only ever succeed on the
    /// first, which is the point: the commitment is fixed before any row
    /// exists, so a campaign that only ever produced junk would never seal and
    /// every property downstream of sealing would pass having observed nothing.
    address[] public tb;
    uint128[] public tt;
    uint16[] public tbps;
    uint16[] public tclf;
    uint16[] public tlin;
    uint256 public targetCursor;

    constructor(HCOWVesting v_, HCOWToken t_, address owner_) {
        v = v_; t = t_; owner = owner_;
        uint128[4] memory a = [uint128(60_000_000e18), 40_000_000e18, 20_000_000e18, 10_000_000e18];
        uint16[4] memory b = [uint16(1500), 750, 2500, 0];
        uint16[4] memory c = [uint16(0), 6, 0, 12];
        uint16[4] memory d = [uint16(12), 12, 3, 36];
        for (uint256 i = 0; i < 4; ++i) {
            tb.push(address(uint160(0x9000 + i)));
            tt.push(a[i]); tbps.push(b[i]); tclf.push(c[i]); tlin.push(d[i]);
        }
    }

    function target() external view
        returns (address[] memory, uint128[] memory, uint16[] memory, uint16[] memory, uint16[] memory)
    { return (tb, tt, tbps, tclf, tlin); }

    /// Walks the committed table in order, so the campaign can actually reach
    /// a sealable state.
    function addTargetRow() external {
        uint256 i = targetCursor;
        if (i >= tb.length) return;
        bool wasSealed = v.sealed_();
        bool atOrAfterTge = block.timestamp >= v.tgeTime();
        vm.prank(owner);
        try v.addSchedule(tb[i], tt[i], tbps[i], tclf[i], tlin[i]) {
            targetCursor = i + 1;
            if (wasSealed) ghostAddedAfterSeal += 1;
            if (atOrAfterTge) ghostAddedAtOrAfterTge += 1;
        } catch {}
    }

    /// The runbook path, in one action: clear whatever is loaded, load the
    /// committed table in order, approve, and fund and seal atomically.
    ///
    /// Without an action that can actually reach a sealed contract, every
    /// property that only looks at a sealed one passes having observed nothing,
    /// which is the coverage failure the audit found in the ProfitShare suite.
    function runbookLoadAndSeal() external {
        vm.startPrank(owner);
        try v.replaceTable(tb, tt, tbps, tclf, tlin) {
            targetCursor = tb.length;
            ghostResets += 1;
        } catch {
            for (uint256 i = 0; i < tb.length; ++i) {
                try v.addSchedule(tb[i], tt[i], tbps[i], tclf[i], tlin[i]) {} catch {}
            }
        }
        try t.approve(address(v), type(uint256).max) {} catch {}
        bool onCommitment =
            v.beneficiaryCount() == v.expectedBeneficiaries() &&
            v.totalScheduled() == v.expectedScheduled() &&
            v.scheduleHash() == v.expectedScheduleHash();
        try v.fundAndSeal() {
            ghostSealed += 1;
            if (!onCommitment) ghostSealedOffCommitment += 1;
        } catch {}
        vm.stopPrank();
    }

    /// Swaps the whole table. The audit's Medium #2: without this a mistyped
    /// row was unrecoverable and the contract had to be redeployed.
    ///
    /// It clears and reloads in one call deliberately. A bare clear created a
    /// permanent total-loss path, so the empty table is not a state this
    /// generator can reach either, which is the property being modelled.
    function replaceTable() external {
        vm.prank(owner);
        try v.replaceTable(tb, tt, tbps, tclf, tlin) {
            targetCursor = tb.length;
            ghostResets += 1;
        } catch {}
    }

    function addJunkRow(uint256 amtSeed, uint256 bpsSeed, uint256 clfSeed, uint256 linSeed) external {
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

    function seal(uint256 seed) external {
        // half the attempts go through fundAndSeal, which is the intended path
        bool onCommitment =
            v.beneficiaryCount() == v.expectedBeneficiaries() &&
            v.totalScheduled() == v.expectedScheduled() &&
            v.scheduleHash() == v.expectedScheduleHash();
        bool atomic = seed % 2 == 0;
        vm.startPrank(owner);
        if (atomic) { try t.approve(address(v), type(uint256).max) {} catch {} }
        try this.callSeal(atomic) {
            ghostSealed += 1;
            if (!onCommitment) ghostSealedOffCommitment += 1;
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
        vm.stopPrank();
    }

    /// Split out so the try/catch above has a single external call to wrap.
    function callSeal(bool atomic) external {
        require(msg.sender == address(this));
        if (atomic) v.fundAndSeal(); else v.seal();
    }

    /// Nothing may leave an unsealed contract. Without this action the
    /// property that says so is never exercised.
    function release(uint256 seed) external {
        uint256 n = v.beneficiaryCount();
        if (n == 0) return;
        try v.release(v.beneficiaryAt(bound(seed, 0, n - 1))) {} catch {}
    }

    /**
     * Time moves, but it does not cross TGE until the contract is sealed.
     *
     * Unbounded, it crossed within the first few calls of almost every run.
     * addSchedule is closed from TGE onward by design, so the table could never
     * be completed, the contract never sealed, and every property that only
     * looks at a sealed contract passed having observed nothing. The coverage
     * floor caught that, which is what it is for.
     *
     * Once sealed, time is free again, so the properties about adding at or
     * after TGE still get exercised against a live contract.
     */
    function warp(uint256 seed) external {
        uint256 target = block.timestamp + bound(seed, 1, 5 days);
        if (!v.sealed_()) {
            uint256 ceiling = v.tgeTime() - 1;
            if (target > ceiling) target = ceiling;
        }
        if (target > block.timestamp) vm.warp(target);
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

        // The handler owns the table the contract is committed to, so build it
        // first and deploy against it. The commitments are constructor
        // arguments now: a campaign deployed against figures nothing could
        // reach would never seal, and every property downstream of sealing
        // would pass having observed nothing at all.
        LoadHandler probe = new LoadHandler(HCOWVesting(address(0)), t, treasury);
        (address[] memory b, uint128[] memory tt, uint16[] memory bps,
         uint16[] memory clf, uint16[] memory lin) = probe.target();

        v = new HCOWVesting(
            address(t), block.timestamp + 10 days, treasury, address(0xFEE5),
            b.length, Commit.totalOf(tt), Commit.unlockOf(tt, bps, clf, lin),
            Commit.hashOf(b, tt, bps, clf, lin)
        );
        handler = new LoadHandler(v, t, treasury);
        targetContract(address(handler));
    }

    /**
     * Coverage floor, checked at the end of every run rather than as an
     * invariant, because an invariant is also evaluated once before any call is
     * made and would fail there by construction.
     *
     * The properties below that only look at a sealed contract are worthless on
     * a run that never sealed. The audit found exactly that in the ProfitShare
     * suite, where the guard written to make it visible asserted that an
     * unsigned counter was at least zero, which is true of every value
     * including zero, so it printed nothing and could not fail. This one can
     * fail, and it did on the first campaign it was run against.
     */
    function afterInvariant() public view {
        assertGt(handler.ghostSealed(), 0,
            "this run never sealed, so every sealed-state property observed nothing");
    }

    /// The commitment is fixed before any row exists, so a table that is not
    /// the committed one must never seal, however it was assembled.
    function invariant_neverSealsOffCommitment() public view {
        assertEq(handler.ghostSealedOffCommitment(), 0,
            "a table that did not match the deployment commitment was sealed");
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
        uint256 max = 200; // HCOWVesting.MAX_BENEFICIARIES
        address[] memory b = new address[](max);
        uint128[] memory tt = new uint128[](max);
        uint16[] memory bps = new uint16[](max);
        uint16[] memory clf = new uint16[](max);
        uint16[] memory lin = new uint16[](max);
        for (uint256 i = 0; i < max; ++i) {
            b[i] = address(uint160(0x50000 + i));
            tt[i] = 1e18; bps[i] = 0; clf[i] = 0; lin[i] = 12;
        }
        HCOWVesting vv = new HCOWVesting(
            address(t), block.timestamp + 10 days, treasury, address(0xFEE5),
            max, Commit.totalOf(tt), Commit.unlockOf(tt, bps, clf, lin),
            Commit.hashOf(b, tt, bps, clf, lin)
        );

        vm.startPrank(treasury);
        for (uint256 i = 0; i < max; ++i) {
            vv.addSchedule(b[i], tt[i], bps[i], clf[i], lin[i]);
        }
        assertEq(vv.beneficiaryCount(), max, "did not load the full cap");
        vm.expectRevert();
        vv.addSchedule(address(uint160(0x60000)), 1e18, 0, 0, 12);

        t.approve(address(vv), type(uint256).max);
        uint256 before = gasleft();
        vv.fundAndSeal();
        uint256 used = before - gasleft();
        vm.stopPrank();
        assertTrue(vv.sealed_(), "a full table could not be sealed");
        // BSC blocks are far larger than this; the point is that it is a number.
        assertLt(used, 10_000_000, "sealing a full table costs more than ten million gas");
        emit log_named_uint("fundAndSeal() gas at MAX_BENEFICIARIES", used);
    }

    /// replaceTable swaps the whole table so a mistyped row is recoverable, and
    /// grants no power an unsealed owner did not already have.
    function test_replaceTableRecoversAMistypedRow() public {
        (address[] memory b, uint128[] memory tt, uint16[] memory bps,
         uint16[] memory clf, uint16[] memory lin) = handler.target();

        vm.startPrank(treasury);
        v.addSchedule(b[0], tt[0] - 1e18, bps[0], clf[0], lin[0]); // mistyped
        for (uint256 i = 1; i < b.length; ++i) v.addSchedule(b[i], tt[i], bps[i], clf[i], lin[i]);
        t.approve(address(v), type(uint256).max);
        vm.expectRevert();
        v.fundAndSeal();

        v.replaceTable(b, tt, bps, clf, lin);
        assertEq(v.beneficiaryCount(), b.length, "the replacement is not the whole table");
        assertEq(v.scheduleHash(), v.expectedScheduleHash(), "the replacement missed the commitment");

        v.fundAndSeal();
        vm.stopPrank();
        assertTrue(v.sealed_(), "a corrected table could not be sealed");
    }

    /// The empty table is not reachable, funded or not. A bare clear created a
    /// permanent total-loss path: clear a funded table, fail to rebuild it
    /// before TGE, and addSchedule is closed, seal() reverts NoSchedules
    /// forever, release() is gated on the seal, and there is no sweep.
    function test_theEmptyTableIsNotReachable() public {
        (address[] memory b, uint128[] memory tt, uint16[] memory bps,
         uint16[] memory clf, uint16[] memory lin) = handler.target();
        vm.startPrank(treasury);
        for (uint256 i = 0; i < b.length; ++i) v.addSchedule(b[i], tt[i], bps[i], clf[i], lin[i]);

        address[] memory none = new address[](0);
        uint128[] memory noneT = new uint128[](0);
        uint16[] memory noneS = new uint16[](0);
        vm.expectRevert(HCOWVesting.NoSchedules.selector);
        v.replaceTable(none, noneT, noneS, noneS, noneS);
        assertEq(v.beneficiaryCount(), b.length, "the table was emptied");

        // and dusting the contract does not disable the correction path
        t.transfer(address(v), 1);
        v.replaceTable(b, tt, bps, clf, lin);
        assertEq(v.scheduleHash(), v.expectedScheduleHash(), "a dusted contract could not be corrected");
        vm.stopPrank();
    }

    /// The table is frozen at TGE, and replaceTable must not be a way to
    /// unfreeze it: sealing is permissionless from then on, and an owner able
    /// to rewrite the table then could hold every beneficiary hostage.
    function test_replaceTableRefusedAtTge() public {
        (address[] memory b, uint128[] memory tt, uint16[] memory bps,
         uint16[] memory clf, uint16[] memory lin) = handler.target();
        vm.startPrank(treasury);
        for (uint256 i = 0; i < b.length; ++i) v.addSchedule(b[i], tt[i], bps[i], clf[i], lin[i]);
        vm.warp(v.tgeTime());
        vm.expectRevert();
        v.replaceTable(b, tt, bps, clf, lin);
        vm.stopPrank();
    }
}
