// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title Commit
 * @notice Derives the four figures HCOWVesting now takes as constructor
 *         arguments, from a table, the way the deployment runbook requires a
 *         human to.
 *
 *         They used to be seal() arguments, which let a caller read them back
 *         off the contract it had already loaded. That made the check a
 *         restatement rather than a verification, and it is the whole of the
 *         audit's Low #1. A test that computed them the same way would inherit
 *         the same weakness, so this derives them independently.
 */
library Commit {
    uint256 internal constant BPS = 10_000;

    function hashOf(
        address[] memory bens,
        uint128[] memory totals,
        uint16[] memory bps,
        uint16[] memory clf,
        uint16[] memory lin
    ) internal pure returns (bytes32 h) {
        for (uint256 i = 0; i < bens.length; ++i) {
            h = keccak256(abi.encodePacked(h, bens[i], totals[i], bps[i], clf[i], lin[i]));
        }
    }

    function totalOf(uint128[] memory totals) internal pure returns (uint256 sum) {
        for (uint256 i = 0; i < totals.length; ++i) sum += totals[i];
    }

    /// @dev Mirrors HCOWVesting._vestedAt(schedule, tgeTime).
    function unlockOne(uint128 total, uint16 bps, uint16 clf, uint16 lin) internal pure returns (uint256) {
        uint256 tgeAmount = (uint256(total) * bps) / BPS;
        if (uint256(total) - tgeAmount == 0) return total;
        if (clf > 0) return tgeAmount;
        if (lin == 0) return total;
        return tgeAmount;
    }

    function unlockOf(
        uint128[] memory totals,
        uint16[] memory bps,
        uint16[] memory clf,
        uint16[] memory lin
    ) internal pure returns (uint256 sum) {
        for (uint256 i = 0; i < totals.length; ++i) sum += unlockOne(totals[i], bps[i], clf[i], lin[i]);
    }
}
