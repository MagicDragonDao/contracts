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
 * A dragon stash contract implementing IStash,
 * that sends a prorated portion of its balance when
 * tokens are requested, and allows the contract admin
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

    // ================ Emission State =================

    /// @dev The amount of tokens currently being emitted per second.
    uint256 public tokensPerSecond;
    /// @dev The timestamp the current token stream started.
    uint256 public streamStart;
    /// @dev The timestamp the current token stream will end.
    uint256 public streamEnd;
    /// @dev The last time tokens were pulled.
    uint256 public lastPull;
    /// @dev Any unclaimed tokens from a previous stream.
    uint256 public previouslyAccrued;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Use inherited constructor. See BasicDragonStash.
     */
    constructor(IERC20 _token, address _puller) BasicDragonStash(_token, _puller) {}

    // ======================================== STASH OPERATIONS ========================================

    /**
     * @notice Send tokens to the puller upon request. The streaming stash will send the proportionate
     *         amounts of tokens earned since the time of the last claim.
     *
     * @return payout                          The amount of tokens sent.
     */
    function request() external override returns (uint256 payout) {
        require(msg.sender == stashPuller, "Not puller");
        require(streamStart != 0, "No stream");

        payout = pending();

        if (previouslyAccrued > 0) previouslyAccrued = 0;

        if (payout > 0) {
            lastPull = _getLastActiveTimestamp();

            token.safeTransfer(msg.sender, payout);

            emit Send(msg.sender, payout);
        }
    }

    /**
     * @notice Report the amount of payout that would be sent by request.
     *
     * @return payout                          The amount of tokens pending.
     */
    function pending() public view override returns (uint256 payout) {
        if (streamStart == 0) return 0;

        uint256 lastActiveTimestamp = _getLastActiveTimestamp();
        payout = (tokensPerSecond * (lastActiveTimestamp - lastPull)) / ONE;

        if (previouslyAccrued > 0) payout += previouslyAccrued;
    }

    /**
     * @notice Get the last timestamp for which emission should be accounted.
     *
     * @return timestamp                        The ending timestamp of current token accrual.
     */
    function _getLastActiveTimestamp() internal view returns (uint256) {
        return block.timestamp <= streamEnd ? block.timestamp : streamEnd;
    }

    // ======================================== ADMIN OPERATIONS ========================================

    /**
     * @notice Start a token stream for amount tokens over duration seconds. If a stream is active,
     *         takes the leftover tokens and re-dsitributes them. Requires contract to be funded.
     *
     * @param amount                            The amount of tokens to distribute.
     * @param duration                          The length of time to distribute tokens.
     */
    function startStream(uint256 amount, uint256 duration) external onlyOwner {
        require(duration > 0, "No duration");

        // Add currently-leftover tokens to new stream
        if (block.timestamp < streamEnd) {
            uint256 remaining = streamEnd - block.timestamp;
            uint256 leftover = (remaining * tokensPerSecond) / ONE;

            amount += leftover;
        }

        previouslyAccrued = pending();

        require(amount + previouslyAccrued <= token.balanceOf(address(this)), "Not enough tokens");

        tokensPerSecond = (amount * ONE) / duration;
        streamStart = block.timestamp;
        streamEnd = block.timestamp + duration;
        lastPull = block.timestamp;

        emit StartStream(amount, duration);
    }

    /**
     * @notice Stop the stream and return the leftover tokens to the owner.
     *         Can be used in case of migration to a new stash or accounting issue.
     */
    function stopStream() external onlyOwner {
        require(block.timestamp <= streamEnd, "Stream over");

        uint256 remaining = streamEnd - block.timestamp;
        uint256 leftover = (remaining * tokensPerSecond) / ONE;

        tokensPerSecond = 0;
        streamStart = 0;
        streamEnd = 0;

        token.transfer(msg.sender, leftover);

        emit StopStream();
    }
}
