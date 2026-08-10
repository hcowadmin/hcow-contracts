// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

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
