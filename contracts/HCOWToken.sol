// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title HCOW
 * @notice BEP-20 token for the HashCow ecosystem on BNB Smart Chain.
 *
 * DESIGN NOTES FOR AUDIT AND FOR THE DEPLOYING TEAM
 *
 *  1. FIXED SUPPLY. The entire supply is minted once, in the constructor.
 *     There is no mint function and no minter role. Total supply can only
 *     ever go down, through burning.
 *
 *  2. NO OWNER. This contract deliberately has no Ownable, no pausable, no
 *     blacklist and no upgrade path. There is nothing to administer, so there
 *     is no admin key to lose or misuse. This is also the cheapest thing to
 *     audit.
 *
 *  3. NO TRANSFER TAX, AND NO BURN MECHANISM ANYWHERE. The 20 percent fee
 *     burn and the 50 percent native payment burn described in older project
 *     documents are NOT implemented here and are NOT implemented by any other
 *     deployed contract either. Nothing calls burn(). The only on chain burn
 *     in the system is the bonded deposit deduction in HCOWProfitShare, which
 *     transfers to 0x...dEaD and therefore does not reduce totalSupply(): a
 *     burned or circulating figure must read balanceOf(0xdEaD) rather than
 *     subtract from supply. A transfer tax was rejected deliberately, because
 *     it breaks exchange listings, routers and accounting. This comment is
 *     published with the verified source, so it must not point a reader at an
 *     implementation that does not exist.
 *
 *  4. THE SUPPLY GOES WHERE YOU TELL IT. The constructor takes `treasury` and
 *     mints the whole supply there. It does NOT mint to msg.sender. This means
 *     a third party can deploy without ever holding the supply.
 *     Whoever holds `treasury` at genesis holds the entire supply, and that
 *     fact is permanently visible on chain. A multisig is the safest choice.
 *     If a single key is used it must be a hardware wallet, and the vesting
 *     contract should be funded and sealed as early as possible so that the
 *     amount exposed to that one key is small.
 *
 *  5. ERC20Permit is included so that future protocol contracts can accept
 *     signature-based approvals. It adds no privileged role.
 */
contract HCOWToken is ERC20, ERC20Burnable, ERC20Permit {
    /// @notice 200,000,000 HCOW, fixed forever.
    /// @notice The amount minted once at construction. Not a cap: there is no
    ///         mint function, so supply can never rise, but `burn` can lower
    ///         it, and from the first burn this constant no longer equals
    ///         `totalSupply()`. Anything reporting a current maximum must read
    ///         `totalSupply()`, not this.
    uint256 public constant INITIAL_SUPPLY = 200_000_000 ether;

    error TreasuryIsZeroAddress();

    /**
     * @param treasury Address that receives the entire initial supply.
     *                 A multisig is strongly preferred. A hardware-wallet EOA
     *                 is the minimum acceptable alternative.
     */
    constructor(address treasury) ERC20("HashCow", "HCOW") ERC20Permit("HashCow") {
        if (treasury == address(0)) revert TreasuryIsZeroAddress();
        _mint(treasury, INITIAL_SUPPLY);
    }
}
