// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./BasicDragonStash.sol";

/**
 * @title DragonStash
 * @author kvk0x
 *
 * A dragon stash contract implementing IRewardStash,
 * that sends its entire balance when rewards are requested,
 * and is set up with a single recipient.
 */
contract StreamingDragonStash is BasicDragonStash {
    using SafeERC20 for IERC20;

    // ============================================ EVENTS ==============================================

    event StreamStarted(uint256 amount, uint256 duration);

    // ============================================ STATE ===============================================

    // ================ Global State =================

    uint256 public constant ONE = 1e18;

    // ================ Reward State =================

    /// @dev The amount of rewards currently being emitted per second.
    uint256 public rewardsPerSecond;
    /// @dev The timestamp the current reward stream started.
    uint256 public streamStart;
    /// @dev The timestamp the current reward stream will end.
    uint256 public streamEnd;
    /// @dev The last time rewards were pulled.
    uint256 public lastPull;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Use inherited constructor. See BasicDragonStash.
     */
    constructor(IERC20 _token, address _puller) BasicDragonStash(_token, _puller) {}

    // ======================================== STASH OPERATIONS ========================================

    /**
     * @notice Send rewards to the puller upon request. The streaming stash will send the proportionate
     *         amounts of rewards earned since the time of the last claim.
     *
     * @return rewards                          The amount of rewards sent.
     */
    function requestRewards() external override returns (uint256 rewards) {
        require(msg.sender == stashPuller, "Not puller");

        uint256 elapsed = block.timestamp - lastPull;
        lastPull = block.timestamp;

        rewards = (rewardsPerSecond * elapsed) / ONE;

        token.transfer(msg.sender, rewards);

        emit SendRewards(msg.sender, rewards);
    }

    // ======================================== ADMIN OPERATIONS ========================================

    function startStream(uint256 amount, uint256 duration) external onlyOwner {
        require(duration > 0, "No duration");

        // Add currently-leftover rewards to new stream
        if (block.timestamp < streamEnd) {
            uint256 remaining = streamEnd - block.timestamp;
            uint256 leftover = remaining * rewardsPerSecond;

            amount += leftover;
        }

        require(amount <= token.balanceOf(address(this)), "Not enough rewards");

        rewardsPerSecond = (amount * ONE) / duration;
        streamStart = block.timestamp;
        streamEnd = block.timestamp + duration;
        lastPull = block.timestamp;

        emit StreamStarted(amount, duration);
    }
}
