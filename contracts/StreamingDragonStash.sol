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
 * that sends a prorated portion of its balance when
 * rewards are requested, and allows the contract admin
 * to set the emission rate.
 */
contract StreamingDragonStash is BasicDragonStash {
    using SafeERC20 for IERC20;

    // ============================================ EVENTS ==============================================

    event StartStream(uint256 amount, uint256 duration);
    event StopStream();

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
        require(streamStart != 0, "No stream");

        uint256 lastActiveTimestamp = block.timestamp <= streamEnd ? block.timestamp : streamEnd;
        rewards = (rewardsPerSecond * (lastActiveTimestamp - lastPull)) / ONE;

        if (rewards > 0) {
            lastPull = lastActiveTimestamp;

            token.safeTransfer(msg.sender, rewards);

            emit SendRewards(msg.sender, rewards);
        }
    }

    // ======================================== ADMIN OPERATIONS ========================================

    /**
     * @notice Start a reward stream for amount tokens over duration seconds. If a stream is active,
     *         takes the leftover rewards and re-dsitributes them. Requires contract to be funded.
     *
     * @param amount                            The amount of rewards to distribute.
     * @param duration                          The length of time to distribute rewards.
     */
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

        emit StartStream(amount, duration);
    }

    /**
     * @notice Stop the reward stream and return the leftover tokens to the owner.
     *         Can be used in case of migration to a new stash or accounting issue.
     */
    function stopStream() external onlyOwner {
        require(block.timestamp <= streamEnd, "Stream over");

        uint256 remaining = streamEnd - block.timestamp;
        uint256 leftover = (remaining * rewardsPerSecond) / ONE;

        rewardsPerSecond = 0;
        streamStart = 0;
        streamEnd = 0;

        token.transfer(msg.sender, leftover);

        emit StopStream();
    }
}
