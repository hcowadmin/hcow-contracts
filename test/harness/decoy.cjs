'use strict';
// Compiles a decoy 18-decimal ERC20 called "Tether USD"/USDT, entirely inside
// repro/. Nothing in ../contracts is touched.
const solc = require('/home/claude/audit4/a4/node_modules/solc-0834');
const src = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
contract Decoy {
  string public name = "Tether USD";
  string public symbol = "USDT";
  uint8  public decimals = 18;
  uint256 public totalSupply = 1;
  mapping(address=>uint256) public balanceOf;
  mapping(address=>mapping(address=>uint256)) public allowance;
  event Transfer(address indexed f,address indexed t,uint256 v);
  event Approval(address indexed o,address indexed s,uint256 v);
  function transfer(address,uint256) external pure returns(bool){return true;}
  function approve(address,uint256) external pure returns(bool){return true;}
  function transferFrom(address,address,uint256) external pure returns(bool){return true;}
}`;
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { 'Decoy.sol': { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
const errs = (out.errors||[]).filter(e=>e.severity==='error');
if (errs.length) { console.error(errs.map(e=>e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['Decoy.sol'].Decoy;
module.exports = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
