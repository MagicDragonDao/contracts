// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

interface IRewardStash {
    // ============= Events ==============

    event SendRewards(address indexed to, uint256 amount);

    // ============= Reward Operations ==============

    function requestRewards() external returns (uint256 rewards);

    function pendingRewards() external returns (uint256 rewards);
}
