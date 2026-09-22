// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HCOWClaim
 * @notice Multi-round Merkle distributor for the Community/Airdrop bucket.
 *
 * WHERE THIS SITS
 *
 *   HCOWVesting holds nine schedules, one per bucket. The Community/Airdrop
 *   bucket's beneficiary is this contract, so vesting releases flow here and
 *   individual recipients pull from here. This contract is additive: it does
 *   not touch, wrap or extend any of the six audited contracts, and nothing in
 *   those contracts knows it exists beyond holding its address as an ordinary
 *   beneficiary.
 *
 *   That address is fixed forever at seal(), so this contract is deployed
 *   before the vesting contract is sealed. See README, "Claim deployment order".
 *
 * DESIGN NOTES FOR AUDIT AND FOR THE OPERATING TEAM
 *
 *  1. UNISWAP'S MerkleDistributor IS THE REFERENCE IMPLEMENTATION. Claim path,
 *     bitmap, leaf shape and the check-before-transfer ordering are its
 *     structure. The only structural change is that everything is keyed by
 *     round: one root per round, one bitmap per round.
 *
 *  2. NO UNLOCK POLICY LIVES HERE. This contract answers one question, "may
 *     this address take this amount in this round", and that is all it knows.
 *     Which category unlocks what fraction over how many months is decided
 *     when the tree is built (scripts/build-merkle.cjs) and arrives here as a
 *     number. The policy is not final; it changes without a redeploy. See the
 *     spec, section 3.
 *
 *  3. A ROUND'S ROOT FREEZES WHEN THE ROUND OPENS, AND NOT BEFORE. At or
 *     after startTime setRoot reverts for that round, permanently, including
 *     a call that would set the identical root. An operator who could rewrite
 *     a LIVE root could pay an arbitrary address an arbitrary amount while
 *     claimants were already reading the old one, and there is no version of
 *     that this project can defend. That is the case this note closes.
 *
 *     Before startTime it closes nothing. The owner may rewrite an unopened
 *     round's root and its startTime, any number of times, with no bound in
 *     either direction, within the bounds notes 4 and 8 put on startTime.
 *     Every write emits RoundSet.
 *
 *     An earlier version of this note said a round could be registered with a
 *     startTime already past and claimed in the same block. That stopped being
 *     true when minRoundNotice was added (audit 4, A-1): setRoot now requires
 *     startTime >= block.timestamp + minRoundNotice, so no round can open in
 *     the block it was registered. The sentence was left behind by that change
 *     and has been corrected rather than defended.
 *
 *  4. THE OWNER HAS TWO ROUTES TO THE TOKENS, AND ONLY ONE IS TIME-LOCKED.
 *     sweep() is shut until claimDeadline. setRoot is not. The owner can
 *     register an unused roundId whose tree pays one address the whole
 *     balance and claim it immediately; nothing here bounds a round's payout,
 *     its count, or its relation to the balance.
 *
 *     This is a property of the design, not a defect to be patched: a
 *     distributor whose operator chooses the root cannot distinguish an
 *     honest recipient list from a dishonest one, because both arrive as a
 *     setRoot. An earlier version of this note claimed sweep() was the only
 *     route. It was not true and it has been removed rather than defended.
 *
 *     What does hold, and is enforced here:
 *       - sweep() reverts before claimDeadline, with no override.
 *       - claimDeadline extends and never shortens. A shortenable deadline is
 *         the same thing as confiscating unclaimed balances on notice.
 *       - every round opens at least minClaimWindow before claimDeadline, so
 *         sweep() never becomes available against a round nobody could claim
 *         yet. See note 8.
 *       - no round opens in the block it was registered: minRoundNotice.
 *       - an opened round's root is frozen forever.
 *       - minClaimAmount is raised only before the first round opens, and
 *         lowered at any time. A floor raised over a live distribution
 *         excludes the smallest recipients, which is confiscation on notice
 *         wearing a different hat.
 *       - ownership cannot be renounced, and transfer is two-step.
 *       - every root the owner writes emits RoundSet.
 *
 *     The owner is a multisig, and that plus the public event log is the real
 *     constraint on the setRoot route. Anyone relying on a stronger guarantee
 *     than the list above is relying on something this contract does not
 *     provide.
 *
 *  5. CLAIMED IS WRITTEN BEFORE THE TRANSFER, AND THE BALANCE IS CHECKED
 *     BEFORE BOTH. Checks-effects-interactions requires the first. The second
 *     is what makes an underfunded round safe: the whole transaction reverts
 *     with InsufficientBalance and the bitmap bit is rolled back with it, so
 *     the account claims again once the vesting release lands. SafeERC20 makes
 *     a token that returns false instead of reverting fail the same way. A
 *     claim marked paid against a transfer that quietly did not happen is the
 *     standard permanent-loss bug in multi-round distributors.
 *
 *  6. THE LEAF IS BOUND TO ITS ROUND. Uniswap's leaf is
 *     keccak256(index, account, amount); here it is keccak256(roundId, index,
 *     account, amount). Roots are per-round, so this is not required for
 *     safety, but it means a root pasted into the wrong round proves nothing
 *     instead of paying the previous round's amounts a second time. The
 *     preimage is 116 bytes and an internal node's is 64, so a leaf can still
 *     never be confused with a node.
 *
 *  7. NOT UPGRADEABLE, NO PROXY, NO PAUSE, NO DELEGATION, NO STAKING.
 *
 *  8. EVERY ROUND IS CLAIMABLE FOR minClaimWindow BEFORE sweep() OPENS.
 *     claimDeadline and the round schedule used to be unrelated numbers. A
 *     deadline earlier than the last round's startTime was accepted by every
 *     check here, and it put sweep() in reach of tokens that no round had yet
 *     opened to pay out -- the owner route note 4 cannot close, reached without
 *     even needing a dishonest root. setRoot now refuses a startTime later than
 *     claimDeadline - minClaimWindow.
 *
 *     Two properties make this safe to enforce at registration only:
 *     claimDeadline never moves earlier, and minClaimWindow is immutable. A
 *     round accepted today therefore still satisfies the rule on the day it
 *     opens, and extendDeadline can only widen the margin.
 *
 *     It also gives startTime the upper bound it never had. Note 3 says an
 *     unopened round can be pushed back; it can no longer be pushed past the
 *     deadline.
 *
 */
contract HCOWClaim is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A deadline further out than this at deployment is a typo, not a
    ///         plan, and claimDeadline cannot be shortened afterwards.
    ///         extendDeadline is deliberately not bounded by it: extending is
    ///         only ever more generous to claimants.
    uint256 public constant MAX_DEADLINE_HORIZON = 3650 days;

    /// @notice Bounds on the notice period a round must be given before it can
    ///         open. An hour is the floor so that a testnet rehearsal can run
    ///         in an afternoon; thirty days is the ceiling so that a mistyped
    ///         value cannot make the contract unusable for a year. The value
    ///         itself is a deployment parameter, not a constant, because it is
    ///         a policy number and this project does not hardcode those.
    uint256 public constant MIN_NOTICE_FLOOR = 1 hours;
    uint256 public constant MIN_NOTICE_CEILING = 30 days;

    /// @notice Bounds on the claim window every round must be given: the gap
    ///         between a round opening and claimDeadline. An hour is the floor
    ///         for the same reason as MIN_NOTICE_FLOOR, a testnet rehearsal in
    ///         an afternoon; a year is the ceiling so that a mistyped value
    ///         cannot make setRoot permanently unreachable. The value itself
    ///         is a deployment parameter because it is a policy number.
    uint256 public constant MIN_WINDOW_FLOOR = 1 hours;
    uint256 public constant MIN_WINDOW_CEILING = 365 days;

    struct Round {
        bytes32 merkleRoot; // zero means the round has never been registered
        uint256 startTime;  // unix seconds; claims revert before it
    }

    /// @notice The HCOW token. Fixed at deployment; this contract holds and
    ///         pays nothing else.
    IERC20 public immutable token;

    /// @notice How far ahead a round's startTime must be when setRoot is
    ///         called. See design note 4.
    uint256 public immutable minRoundNotice;

    /// @notice How long every round must be claimable before sweep() opens.
    ///         setRoot refuses a startTime later than claimDeadline minus this.
    ///         See design note 8.
    ///
    ///         The constructor guarantees claimDeadline >= minClaimWindow, and
    ///         extendDeadline only ever raises claimDeadline, so the
    ///         subtraction in setRoot cannot underflow.
    uint256 public immutable minClaimWindow;

    /// @notice The instant from which sweep() becomes callable. Extendable,
    ///         never shortenable. Claiming is not closed by it: while tokens
    ///         are still here, a late claimant is still paid.
    uint256 public claimDeadline;

    /// @notice Smallest claimable amount per round entry. Zero, the initial
    ///         value, means no floor.
    ///
    ///         Policy here is open (spec section 10, item 2). The intended
    ///         answer to dust is the tree: an account whose total is small
    ///         enough that a split would put a round below gas cost gets the
    ///         whole of it in round one. This exists so that the other answer
    ///         remains available without a redeploy.
    ///
    ///         It can be raised only while no round has opened. Afterwards it
    ///         moves down and never up. See setMinClaimAmount.
    uint256 public minClaimAmount;

    /// @notice The earliest startTime ever given to any round, or
    ///         type(uint256).max while no round has been registered. It is the
    ///         gate on raising minClaimAmount, and it only ever moves earlier.
    ///
    ///         Not "the first round's current start time": setRoot may push an
    ///         unopened round later, and this does not follow it back up. The
    ///         mapping of rounds is sparse and unenumerable, so recomputing a
    ///         true minimum would mean carrying a list of every round for the
    ///         sake of one owner-only call. Leaving it at the earliest instant
    ///         ever scheduled is one slot and errs in the only direction that
    ///         is safe to err in: the window for raising the floor can close
    ///         earlier than the first round actually opens, never later. Every
    ///         registered round's start is at or after this value, so
    ///         block.timestamp < earliestRoundStart proves no round is open.
    uint256 public earliestRoundStart = type(uint256).max;

    mapping(uint256 => Round) public rounds;

    /// @dev roundId => word index => 256 claimed bits. Uniswap's bitmap with a
    ///      round dimension in front of it.
    mapping(uint256 => mapping(uint256 => uint256)) private claimedBitMap;

    event RoundSet(uint256 indexed roundId, bytes32 merkleRoot, uint256 startTime);
    event Claimed(uint256 indexed roundId, uint256 index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event DeadlineExtended(uint256 oldDeadline, uint256 newDeadline);
    event MinClaimAmountSet(uint256 oldAmount, uint256 newAmount);

    error ZeroAddress();
    error ZeroAmount();
    error EmptyRoot();
    error DeadlineInThePast(uint256 deadline, uint256 nowTs);
    error DeadlineTooFar(uint256 deadline, uint256 maxDeadline);
    error RoundNotFound(uint256 roundId);
    error RoundNotStarted(uint256 roundId, uint256 startTime);
    error RoundAlreadyStarted(uint256 roundId, uint256 startTime);
    /// @notice A round must open at least minRoundNotice from now. See design note 4.
    error NoticeTooShort(uint256 startTime, uint256 earliestAllowed);
    error NoticeOutOfRange(uint256 notice, uint256 floor_, uint256 ceiling);
    /// @notice A round must open at least minClaimWindow before claimDeadline.
    ///         See design note 8.
    error ClaimWindowTooShort(uint256 startTime, uint256 latestAllowed);
    error WindowOutOfRange(uint256 window, uint256 floor_, uint256 ceiling);
    /// @notice The deadline given at deployment leaves no room for even one
    ///         round: minRoundNotice + minClaimWindow already runs past it.
    error DeadlineLeavesNoRoom(uint256 deadline, uint256 earliestUsable);
    error AlreadyClaimed(uint256 roundId, uint256 index);
    error InvalidProof();
    error BelowMinimum(uint256 amount, uint256 minimum);
    error InsufficientBalance(uint256 required, uint256 held);
    error DeadlineNotReached(uint256 deadline);
    error DeadlineNotExtended(uint256 current, uint256 proposed);
    /// @notice Raising the floor closed when the first round opened. Lowering
    ///         it is still available.
    error MinClaimAmountRaiseClosed(uint256 since);
    error LengthMismatch();
    error EmptyBatch();
    /// @notice Renouncing would end setRoot as well as sweep, so no further
    ///         round could ever open and everything still owed would be
    ///         stranded. Ownership here is permanent, as it is in HCOWVesting.
    error OwnershipIsPermanent();

    /**
     * @param token_ HCOW token address.
     * @param owner_ The treasury Safe. setRoot, sweep, extendDeadline and
     *               setMinClaimAmount are its and nothing else's.
     * @param claimDeadline_ Unix seconds. Before it, sweep() reverts. Must be
     *               in the future, within MAX_DEADLINE_HORIZON, and far enough
     *               out that one round can still be registered and stay open
     *               for minClaimWindow_.
     * @param minClaimWindow_ Seconds a round must remain claimable before
     *               sweep() opens. See design note 8.
     */
    constructor(
        address token_,
        address owner_,
        uint256 claimDeadline_,
        uint256 minRoundNotice_,
        uint256 minClaimWindow_
    ) Ownable(owner_) {
        if (token_ == address(0)) revert ZeroAddress();
        if (claimDeadline_ <= block.timestamp) revert DeadlineInThePast(claimDeadline_, block.timestamp);
        uint256 maxDeadline = block.timestamp + MAX_DEADLINE_HORIZON;
        if (claimDeadline_ > maxDeadline) revert DeadlineTooFar(claimDeadline_, maxDeadline);
        if (minRoundNotice_ < MIN_NOTICE_FLOOR || minRoundNotice_ > MIN_NOTICE_CEILING) {
            revert NoticeOutOfRange(minRoundNotice_, MIN_NOTICE_FLOOR, MIN_NOTICE_CEILING);
        }
        if (minClaimWindow_ < MIN_WINDOW_FLOOR || minClaimWindow_ > MIN_WINDOW_CEILING) {
            revert WindowOutOfRange(minClaimWindow_, MIN_WINDOW_FLOOR, MIN_WINDOW_CEILING);
        }
        // Without this the contract deploys into a state where every setRoot
        // reverts: the earliest startTime the notice allows is already later
        // than the latest the window allows. It also establishes
        // claimDeadline >= minClaimWindow, which setRoot's subtraction needs.
        uint256 earliestUsable = block.timestamp + minRoundNotice_ + minClaimWindow_;
        if (claimDeadline_ < earliestUsable) {
            revert DeadlineLeavesNoRoom(claimDeadline_, earliestUsable);
        }

        token = IERC20(token_);
        claimDeadline = claimDeadline_;
        minRoundNotice = minRoundNotice_;
        minClaimWindow = minClaimWindow_;
    }

    // --------------------------------------------------------------- claims

    /// @notice Claim one round's entry. Anyone may call it; the tokens go to
    ///         `account` either way, so a recipient without gas can be paid by
    ///         someone else and nobody can redirect a payment by calling.
    function claim(
        uint256 roundId,
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external nonReentrant {
        _claim(roundId, index, account, amount, merkleProof);
    }

    /// @notice Claim several round entries in one transaction, which is how a
    ///         recipient who has let three rounds pile up pays one gas cost
    ///         instead of three. Any single failing entry reverts all of them.
    function claimMany(
        uint256[] calldata roundIds,
        uint256[] calldata indexes,
        address[] calldata accounts,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs
    ) external nonReentrant {
        uint256 n = roundIds.length;
        if (n == 0) revert EmptyBatch();
        if (indexes.length != n || accounts.length != n || amounts.length != n || merkleProofs.length != n) {
            revert LengthMismatch();
        }
        for (uint256 i = 0; i < n; ++i) {
            _claim(roundIds[i], indexes[i], accounts[i], amounts[i], merkleProofs[i]);
        }
    }

    function _claim(
        uint256 roundId,
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) private {
        Round memory r = rounds[roundId];
        if (r.merkleRoot == bytes32(0)) revert RoundNotFound(roundId);
        if (block.timestamp < r.startTime) revert RoundNotStarted(roundId, r.startTime);
        if (isClaimed(roundId, index)) revert AlreadyClaimed(roundId, index);
        // The tree generator drops zero rows, so a zero here is a malformed
        // call rather than an entitlement. Refusing it also keeps a bitmap bit
        // from being spent on a transfer of nothing.
        if (amount == 0) revert ZeroAmount();
        uint256 floor_ = minClaimAmount;
        if (floor_ != 0 && amount < floor_) revert BelowMinimum(amount, floor_);

        bytes32 node = keccak256(abi.encodePacked(roundId, index, account, amount));
        if (!MerkleProof.verifyCalldata(merkleProof, r.merkleRoot, node)) revert InvalidProof();

        // Before the bit is spent, not after. See design note 5: the revert has
        // to take the bitmap write with it, and it does, because this contract
        // never catches it.
        uint256 held = token.balanceOf(address(this));
        if (held < amount) revert InsufficientBalance(amount, held);

        _setClaimed(roundId, index);
        token.safeTransfer(account, amount);
        emit Claimed(roundId, index, account, amount);
    }

    /// @notice Whether this round's entry at `index` has been paid.
    function isClaimed(uint256 roundId, uint256 index) public view returns (bool) {
        uint256 word = index / 256;
        uint256 bit = index % 256;
        uint256 mask = (1 << bit);
        return claimedBitMap[roundId][word] & mask == mask;
    }

    function _setClaimed(uint256 roundId, uint256 index) private {
        uint256 word = index / 256;
        uint256 bit = index % 256;
        claimedBitMap[roundId][word] = claimedBitMap[roundId][word] | (1 << bit);
    }

    // ---------------------------------------------------------- round admin

    /**
     * @notice Register a round, or correct one that has not opened yet.
     *
     * @dev Once block.timestamp reaches a registered round's startTime this
     *      reverts for that round forever, including a call that would set the
     *      identical root. There is no override and no timelocked variant,
     *      because either one is still "the operator can change a live root"
     *      to anybody reading the code.
     *
     *      startTime is not required to be in the future. A queued Safe
     *      transaction executes minutes to days after it is prepared, and a
     *      freshness check would reject the correct call for being late.
     *
     *      An earlier version of this comment said the cost was that a round
     *      registered with a startTime already past opens immediately and is
     *      frozen immediately. minRoundNotice removed that case: startTime must
     *      be at least minRoundNotice ahead, so a stale-but-valid call still
     *      leaves the full notice between RoundSet and the first claim.
     */
    function setRoot(uint256 roundId, bytes32 merkleRoot, uint256 startTime) external onlyOwner {
        if (merkleRoot == bytes32(0)) revert EmptyRoot();

        Round storage r = rounds[roundId];
        if (r.merkleRoot != bytes32(0) && block.timestamp >= r.startTime) {
            revert RoundAlreadyStarted(roundId, r.startTime);
        }

        // Design note 4. A round cannot open in the block it was registered,
        // or in any block until minRoundNotice has passed.
        //
        // This runs AFTER the freeze check on purpose. A call against a round
        // that opened months ago is a frozen round, not a short notice, and
        // saying so is the more useful of the two answers.
        uint256 earliest = block.timestamp + minRoundNotice;
        if (startTime < earliest) revert NoticeTooShort(startTime, earliest);

        // Design note 8. A round must be claimable for minClaimWindow before
        // sweep() can open. Without this the deadline and the round schedule
        // are unrelated, and a round registered to open after claimDeadline
        // would have sweep() available against tokens nobody could yet claim.
        //
        // This also gives startTime an upper bound, which it did not have.
        // claimDeadline only ever moves later, so a round that satisfies this
        // at registration keeps satisfying it.
        uint256 latest = claimDeadline - minClaimWindow;
        if (startTime > latest) revert ClaimWindowTooShort(startTime, latest);

        r.merkleRoot = merkleRoot;
        r.startTime = startTime;
        if (startTime < earliestRoundStart) earliestRoundStart = startTime;
        emit RoundSet(roundId, merkleRoot, startTime);
    }

    /**
     * @notice Set the per-entry floor. Zero means no floor.
     *
     * @dev The floor may be raised only before the first round opens. Once any
     *      round has opened it moves downwards only, and a raise reverts
     *      permanently.
     *
     *      Every other power the owner holds here runs one way: the deadline
     *      extends and never shortens, an open round's root is frozen,
     *      ownership cannot be renounced. This one was the exception, and a
     *      floor raised after a round has opened excludes exactly the small
     *      recipients the floor was meant to spare gas. That is the same act as
     *      shortening the deadline, reached by a different route, and design
     *      note 4 says why this project cannot hold that shape.
     *
     *      Lowering stays open forever, including after claimDeadline, because
     *      lowering can only ever let more people claim.
     */
    function setMinClaimAmount(uint256 newMinClaimAmount) external onlyOwner {
        uint256 old = minClaimAmount;
        uint256 opensAt = earliestRoundStart;
        if (newMinClaimAmount > old && block.timestamp >= opensAt) {
            revert MinClaimAmountRaiseClosed(opensAt);
        }
        minClaimAmount = newMinClaimAmount;
        emit MinClaimAmountSet(old, newMinClaimAmount);
    }

    // ------------------------------------------------------ deadline, sweep

    /// @notice Move the claim deadline later. Strictly later: equal is refused
    ///         so that no event claims a change that did not happen, and
    ///         earlier is refused because that is confiscation.
    function extendDeadline(uint256 newDeadline) external onlyOwner {
        uint256 old = claimDeadline;
        if (newDeadline <= old) revert DeadlineNotExtended(old, newDeadline);
        claimDeadline = newDeadline;
        emit DeadlineExtended(old, newDeadline);
    }

    /// @notice Recover unclaimed tokens, only once claimDeadline has arrived.
    ///         This is the owner's only path to the balance, and it does not
    ///         exist before the deadline.
    function sweep(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 deadline = claimDeadline;
        if (block.timestamp < deadline) revert DeadlineNotReached(deadline);

        emit Swept(to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice Always reverts. See OwnershipIsPermanent. Unconditional, and
    ///         pure, so that the compiler emits no warning about it, and
    ///         deliberately not owner-gated: the answer to "can this contract
    ///         become ownerless" is no, for everyone asking.
    function renounceOwnership() public pure override {
        revert OwnershipIsPermanent();
    }
}
