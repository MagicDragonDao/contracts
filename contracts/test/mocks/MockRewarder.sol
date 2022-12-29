// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "../../interfaces/IMasterChefV2.sol";

contract MockRewarder is IRewarder {
    event OnReward(uint256 pid, address user, address recipient, uint256 amount, uint256 newLpAmount);

    function onReward(
        uint256 pid,
        address user,
        address recipient,
        uint256 amount,
        uint256 newLpAmount
    ) external {
        emit OnReward(pid, user, recipient, amount, newLpAmount);
    }

    function pendingTokens(
        uint256,
        address,
        uint256
    ) external pure returns (IERC20[] memory, uint256[] memory) {
        IERC20[] memory tokens = new IERC20[](0);
        uint256[] memory amounts = new uint256[](0);

        return (tokens, amounts);
    }
}
