// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title HCOWAnchor
 * @notice Append-only Merkle anchor for game round records.
 *
 * WHERE THIS SITS
 *
 *   The fairness engine (the hashcow/fairness-core package) produces one roundHash per
 *   game round. Rounds are batched by hour, a Merkle tree is built over the
 *   batch off-chain, and only the root lands here. One storage word per hour
 *   instead of one transaction per round.
 *
 *   Measured, not estimated: anchor() spends 119,372 gas on the first batch
 *   and 102,272 on every batch after it, and the figure does not move with the
 *   number of rounds because the tree is built off chain. At BSC's 0.05 gwei
 *   floor and BNB at $600 that is $0.003 per hour, about $2.24 a month. The
 *   same 346,859 rounds anchored one transaction each would be roughly $520.
 *
 *   This contract holds no tokens and has no relationship to HCOWToken,
 *   HCOWVesting or HCOWClaim. It is additive in the strictest sense: it does
 *   not touch, wrap or extend any audited contract, and none of them know it
 *   exists.
 *
 * DESIGN NOTES FOR AUDIT AND FOR THE OPERATING TEAM
 *
 *  1. THERE IS NO PATH TO CHANGE OR REMOVE AN ANCHORED ROOT. Not for the
 *     publisher, not for the owner, not after any delay. anchor() appends and
 *     that is the contract's only state-writing operation besides rotating the
 *     publisher key. An operator who could rewrite a root could rewrite the
 *     game history the root exists to fix, which would make the whole exercise
 *     theatre. The same reasoning runs through HCOWClaim: a root freezes when
 *     its round opens, a deadline extends and never shortens.
 *
 *  2. THE OWNER MAY ROTATE THE PUBLISHER AND HAND OVER OWNERSHIP. Nothing else.
 *     The publisher is a hot key on a server; it will eventually need to be
 *     replaced. Rotation cannot reach past roots, and neither can an ownership
 *     transfer — which is two-step, so a wrong address cannot take ownership by
 *     accident. Ownership cannot be renounced, matching HCOWVesting's
 *     OwnershipIsPermanent: a contract whose publisher key can never be rotated
 *     again is a contract that stops working the first time that key is lost.
 *     The full set of state-writing functions is anchor, setPublisher,
 *     transferOwnership and acceptOwnership; the test suite enumerates the ABI
 *     and asserts exactly that list.
 *
 *  3. PERIODS ARE ALIGNED AND STRICTLY INCREASING. periodStart must be a
 *     multiple of PERIOD and greater than the last one anchored, so a batch
 *     cannot be replayed, back-dated or inserted between two existing batches.
 *
 *  4. GAPS ARE VISIBLE, NOT PREVENTED. Nothing here forces the next batch to
 *     be the next hour. An hour with no batch is plainly missing from the
 *     list, and anyone reading the chain can see it. Forcing contiguity would
 *     mean one outage permanently wedges the contract, and it would still not
 *     prove that a batch contains every round of its hour. This contract
 *     proves "this root was fixed at this time and has not changed since" and
 *     claims nothing about completeness. Public wording must not go past that
 *     line either.
 *
 *  5. THE TREE MATCHES OpenZeppelin MerkleProof, WHICH MEANS SORTED PAIRS.
 *     leaf = keccak256(abi.encodePacked(roundHash)), a 32-byte preimage, while
 *     an internal node hashes 64 bytes. The lengths cannot collide, so an
 *     internal node cannot be replayed as a leaf. Building the tree is
 *     scripts/anchor-merkle.cjs, which derives the root twice by independent
 *     paths before anything is published.
 *
 *     SORTED PAIRS HAVE A PRICE, AND IT IS WORTH STATING. Swapping two siblings
 *     leaves the root unchanged, so a root commits to the SET of roundHashes and
 *     to nothing about their order. Two batches that disagree about which round
 *     happened at which nonce can produce the same root and both verify here.
 *     Changing the set does change the root, so a withheld round is still
 *     detectable; the ORDER is not. Any claim that "the nonce sequence is
 *     visible on chain" is false. Ordering is checked off chain, against the
 *     published batch file, by fairness-core's verifyEpoch.
 *
 *  6. NO PAUSE. A pause on an append-only log can only stop honest records
 *     from being written; it cannot protect anything.
 */
contract HCOWAnchor is Ownable2Step {
    /// @notice Batch period length. Hourly.
    uint64 public constant PERIOD = 1 hours;

    struct Batch {
        bytes32 root;        // Merkle root over the batch's roundHashes
        // The publisher's UNVERIFIED claim about how many rounds the tree holds.
        // Nothing on chain checks it against the root, and nothing can: the tree
        // is off chain. Treat it as a label, never as evidence. Public wording
        // must not present it as "the number of rounds in that hour".
        uint64 leafCount;
        uint64 periodStart;  // aligned unix second the batch covers
        uint64 anchoredAt;   // block.timestamp of the anchoring transaction
    }

    Batch[] private _batches;

    /// @dev periodStart => index + 1. Zero means "no batch for that period".
    mapping(uint64 => uint256) private _indexByPeriod;

    /// @notice Hot key permitted to append batches.
    address public publisher;

    /// @notice periodStart of the most recent batch. Zero before the first.
    uint64 public lastPeriodStart;

    event BatchAnchored(
        uint256 indexed index,
        uint64 indexed periodStart,
        bytes32 root,
        uint64 leafCount,
        uint64 anchoredAt
    );
    event PublisherChanged(address indexed previousPublisher, address indexed newPublisher);

    error NotPublisher(address caller);
    error ZeroAddress();
    error EmptyRoot();
    error EmptyBatch();
    error PeriodNotAligned(uint64 periodStart, uint64 period);
    error PeriodNotAfterLast(uint64 periodStart, uint64 lastPeriodStart);
    error PeriodInFuture(uint64 periodStart, uint256 nowTs);
    error PeriodNotEnded(uint64 periodStart, uint64 endsAt, uint256 nowTs);
    error NoBatchForPeriod(uint64 periodStart);
    error IndexOutOfRange(uint256 index, uint256 count);
    error OwnershipIsPermanent();

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher(msg.sender);
        _;
    }

    constructor(address initialOwner, address initialPublisher) Ownable(initialOwner) {
        if (initialPublisher == address(0)) revert ZeroAddress();
        publisher = initialPublisher;
        emit PublisherChanged(address(0), initialPublisher);
    }

    /* ----------------------------------------------------------------- *
     * Append
     * ----------------------------------------------------------------- */

    /**
     * @notice Append one batch. The only way state grows, and it never shrinks.
     * @param root        Merkle root over the batch's roundHashes.
     * @param leafCount   Number of rounds the tree was built over.
     * @param periodStart Aligned unix second the batch covers.
     */
    function anchor(bytes32 root, uint64 leafCount, uint64 periodStart) external onlyPublisher {
        if (root == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert EmptyBatch();
        if (periodStart % PERIOD != 0) revert PeriodNotAligned(periodStart, PERIOD);
        if (periodStart <= lastPeriodStart) revert PeriodNotAfterLast(periodStart, lastPeriodStart);
        // A batch covers a period that has already begun. Anchoring the future
        // would mean anchoring rounds that have not happened.
        if (periodStart > block.timestamp) revert PeriodInFuture(periodStart, block.timestamp);
        // And a period that has ENDED. periodStart is the hour's start, so without
        // this an operator could anchor an hour one second into it, and then
        // periodStart <= lastPeriodStart makes that hour permanently uncorrectable:
        // every round still to come in it could never be anchored anywhere.
        // A PERIOD_START typo would do the same to every hour in between.
        // Found by adversarial audit 2026-09-16 (A-H1), before any deployment.
        uint64 endsAt = periodStart + PERIOD;
        if (endsAt > block.timestamp) revert PeriodNotEnded(periodStart, endsAt, block.timestamp);

        uint64 anchoredAt = uint64(block.timestamp);
        uint256 index = _batches.length;

        _batches.push(
            Batch({root: root, leafCount: leafCount, periodStart: periodStart, anchoredAt: anchoredAt})
        );
        _indexByPeriod[periodStart] = index + 1;
        lastPeriodStart = periodStart;

        emit BatchAnchored(index, periodStart, root, leafCount, anchoredAt);
    }

    /* ----------------------------------------------------------------- *
     * Publisher key
     * ----------------------------------------------------------------- */

    /// @notice Rotate the hot key. Reaches nothing that was already anchored.
    function setPublisher(address newPublisher) external onlyOwner {
        if (newPublisher == address(0)) revert ZeroAddress();
        address previous = publisher;
        publisher = newPublisher;
        emit PublisherChanged(previous, newPublisher);
    }

    /// @inheritdoc Ownable
    /// @dev pure, matching HCOWClaim and HCOWVesting. A contract whose
    ///      publisher key can never be rotated again stops working the first
    ///      time that key is lost.
    function renounceOwnership() public pure override {
        revert OwnershipIsPermanent();
    }

    /* ----------------------------------------------------------------- *
     * Views
     * ----------------------------------------------------------------- */

    function batchCount() external view returns (uint256) {
        return _batches.length;
    }

    function batchAt(uint256 index) external view returns (Batch memory) {
        if (index >= _batches.length) revert IndexOutOfRange(index, _batches.length);
        return _batches[index];
    }

    function batchForPeriod(uint64 periodStart) external view returns (Batch memory) {
        uint256 slot = _indexByPeriod[periodStart];
        if (slot == 0) revert NoBatchForPeriod(periodStart);
        return _batches[slot - 1];
    }

    function hasBatchForPeriod(uint64 periodStart) external view returns (bool) {
        return _indexByPeriod[periodStart] != 0;
    }

    /**
     * @notice Is roundHash in the batch at index?
     * @dev Pure membership. It does not say the batch holds every round of its
     *      period, and no reading of this function supports that claim.
     */
    function verifyRound(uint256 index, bytes32 roundHash, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        if (index >= _batches.length) revert IndexOutOfRange(index, _batches.length);
        return MerkleProof.verifyCalldata(proof, _batches[index].root, leafOf(roundHash));
    }

    /// @notice Leaf hash for a roundHash. 32-byte preimage; nodes hash 64.
    function leafOf(bytes32 roundHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(roundHash));
    }
}
