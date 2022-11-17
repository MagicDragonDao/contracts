// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

interface IStash {
    // ============= Events ==============

    event Send(address indexed to, uint256 amount);

    // ============= Reward Operations ==============

    function request() external returns (uint256 rewards);

    function pending() external returns (uint256 rewards);
}
