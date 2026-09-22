// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IVesting {
    function release(address beneficiary) external;
    function releasable(address beneficiary) external view returns (uint256);
}

/// @dev A token whose transfer re-enters the vesting contract. Test fixture only.
contract ReentrantToken is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    address public vesting;
    address public target;
    bool public attacking;
    uint256 public reenterCount;
    bool public reentrySucceeded;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; totalSupply += amt; }
    function arm(address vesting_, address target_) external { vesting = vesting_; target = target_; attacking = true; }

    function transfer(address to, uint256 amt) public override returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        if (attacking && msg.sender == vesting) {
            reenterCount++;
            attacking = false; // one attempt is enough to prove the point
            // swallow the revert so the outer call can complete and be inspected
            try IVesting(vesting).release(target) { reentrySucceeded = true; }
            catch { reentrySucceeded = false; }
        }
        return true;
    }

    function approve(address s, uint256 a) external override returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external override returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; emit Transfer(f, t, a); return true;
    }
}

/// @dev A token that silently fails instead of reverting. Test fixture only.
contract SilentFailToken is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; totalSupply += amt; }
    function transfer(address, uint256) external pure override returns (bool) { return false; }
    function approve(address, uint256) external pure override returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure override returns (bool) { return false; }
}

/**
 * @dev An 18-decimal ERC20 that calls itself USDT. Test fixture only.
 *
 * The fourth adversarial audit (2026-09-18, C-4) pointed deploy-claim.cjs at a
 * token like this one: the script printed its symbol, compared nothing, and
 * deployed a claim contract whose immutable `token` was the decoy. Nobody
 * could ever have been paid from it. This exists so that the check which now
 * refuses it has something to refuse.
 */
contract DecoyToken is IERC20 {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 18;
    uint256 public override totalSupply = 1_000_000 ether;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    constructor() { balanceOf[msg.sender] = totalSupply; }

    function transfer(address to, uint256 v) external override returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true;
    }
    function approve(address s, uint256 v) external override returns (bool) {
        allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true;
    }
    function transferFrom(address f, address to, uint256 v) external override returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true;
    }
}

/**
 * @dev The smallest thing that has code at an address. Test fixture only.
 *
 * deploy-claim.cjs refuses an externally owned account as the claim owner on
 * mainnet, because spec 4-7 says the owner is a Safe. A test that wants to
 * exercise anything PAST that guard needs an owner with bytecode, and using a
 * token contract as a stand-in reads like a mistake. This is the stand-in.
 */
contract MockSafe {
    address public immutable signer;
    constructor(address signer_) { signer = signer_; }
}

/**
 * @dev Calls itself HCOW, 18 decimals, wrong supply. Test fixture only.
 *
 * The symbol check alone would pass this. HCOW has a fixed supply of
 * 200,000,000 and no mint function, so a contract claiming the name with a
 * different supply is not it, and binding the immutable claim token to it is
 * permanent. This exists so the supply check has something to refuse that the
 * symbol check does not already catch.
 */
contract WrongSupplyHCOW is IERC20 {
    string public constant name = "HashCow";
    string public constant symbol = "HCOW";
    uint8 public constant decimals = 18;
    uint256 public override totalSupply = 1 ether;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    constructor() { balanceOf[msg.sender] = totalSupply; }

    function transfer(address to, uint256 v) external override returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true;
    }
    function approve(address s, uint256 v) external override returns (bool) {
        allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true;
    }
    function transferFrom(address f, address to, uint256 v) external override returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true;
    }
}

/**
 * @dev A token that re-enters an arbitrary call during transfer. Test fixture only.
 *
 * ReentrantToken above re-enters IVesting.release, which HCOWClaim does not
 * have. The fourth adversarial audit (2026-09-18) measured that HCOWClaim's
 * check-effects-interactions ordering and its nonReentrant guard each block
 * re-entry ALONE, and that removing both pays an entitlement twice. A test of
 * either one alone would pass on a contract whose other half was already
 * broken, so the pair has to be exercised, and that needs a token that
 * actually re-enters claim().
 */
contract ReentrantClaimToken is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    address public target;
    bytes public payload;
    bool public armed;
    uint256 public reenterCount;
    bool public reentrySucceeded;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; totalSupply += amt; }
    function arm(address target_, bytes calldata payload_) external {
        target = target_; payload = payload_; armed = true;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        if (armed && msg.sender == target) {
            armed = false; // one attempt is enough to prove the point
            reenterCount++;
            // swallow the revert so the outer call completes and can be inspected
            (bool done, ) = target.call(payload);
            reentrySucceeded = done;
        }
        return true;
    }

    function approve(address s, uint256 a) external override returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external override returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; emit Transfer(f, t, a); return true;
    }
}
