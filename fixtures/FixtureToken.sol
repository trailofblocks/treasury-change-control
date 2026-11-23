// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract FixtureToken {
    string public constant name = "Treasury Test Dollar";
    string public constant symbol = "USDX";
    uint8 public constant decimals = 6;
    uint256 public constant totalSupply = 2_000_000 * 10 ** decimals;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(address treasury) {
        balanceOf[treasury] = totalSupply;
        emit Transfer(address(0), treasury, totalSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0), "zero recipient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
