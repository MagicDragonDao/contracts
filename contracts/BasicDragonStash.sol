// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IRewardStash.sol";

/**
 * @title DragonStash
 * @author kvk0x
 *
 * A dragon stash contract implementing IRewardStash,
 * that sends its entire balance when rewards are requested,
 * and is set up with a single recipient.
 */
contract BasicDragonStash is IRewardStash, Ownable {
    using SafeERC20 for IERC20;

    // ============================================ EVENTS ==============================================

    event SetPuller(address puller);

    // ============================================ STATE ===============================================

    /// @dev The token this stash will hold. All other tokens can be rescued.
    IERC20 public token;
    /// @dev The contract allowed to pull from this stash.
    address public stashPuller;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Set up a contract meant to hold a token that can be pulled by a puller.
     *
     * @param _token                            The token of the stash.
     * @param _puller                           The address that will draw the token.
     */
    constructor(IERC20 _token, address _puller) Ownable() {
        require(address(_token) != address(0), "No puller");

        token = _token;
        stashPuller = _puller;
    }

    // ======================================== STASH OPERATIONS ========================================

    /**
     * @notice Send rewards to the puller upon request. The basic stash will send
     *         its entire balance.
     *
     * @return rewards                          The amount of rewards sent.
     */
    function requestRewards() external override returns (uint256 rewards) {
        require(msg.sender == stashPuller, "Not puller");

        rewards = token.balanceOf(address(this));

        token.transfer(msg.sender, rewards);

        emit SendRewards(msg.sender, rewards);
    }

    // ======================================== ADMIN OPERATIONS ========================================

    /**
     * @notice Change the address that can pull rewards.
     *
     * @param _puller                           The new stash puller.
     */
    function setPuller(address _puller) external onlyOwner {
        stashPuller = _puller;

        emit SetPuller(stashPuller);
    }

    /**
     * @notice Rescue a token inadvertently held by the contract. Can only
     *         be called by owner.
     *
     * @param token_                            The token to rescue.
     * @param to                                The recipient of rescued tokens.
     */
    function rescue(IERC20 token_, address to) external onlyOwner {
        require(token_ != token, "Cannot rescue stash token");

        token_.safeTransfer(to, token_.balanceOf(address(this)));
    }
}
