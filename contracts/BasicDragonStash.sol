// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IStash.sol";

/**
 * @title DragonStash
 * @author kvk0x
 *
 * A dragon stash contract implementing IStash,
 * that sends its entire balance when tokens are requested,
 * and is set up with a single recipient.
 */
contract BasicDragonStash is IStash, Ownable {
    using SafeERC20 for IERC20;

    // ============================================ EVENTS ==============================================

    event SetPuller(address puller);
    event Rescue(address indexed token, uint256 amount, address to);

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
        require(address(_token) != address(0), "No token");
        require(_puller != address(0), "No puller");

        token = _token;
        stashPuller = _puller;
    }

    // ======================================== STASH OPERATIONS ========================================

    /**
     * @notice Send tokens to the puller upon request. The basic stash will send
     *         its entire balance.
     *
     * @return payout                          The amount sent.
     */
    function request() external virtual override returns (uint256 payout) {
        require(msg.sender == stashPuller, "Not puller");

        payout = pending();

        if (payout > 0) {
            token.transfer(msg.sender, payout);

            emit Send(msg.sender, payout);
        }
    }

    /**
     * @notice Report the amount that would be sent by request.
     *
     * @return payout                          The amount pending.
     */
    function pending() public view virtual override returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ======================================== ADMIN OPERATIONS ========================================

    /**
     * @notice Change the address that can pull tokens.
     *
     * @param _puller                           The new stash puller.
     */
    function setPuller(address _puller) external virtual onlyOwner {
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
    function rescue(IERC20 token_, address to) external virtual onlyOwner {
        require(token_ != token, "Cannot rescue stash token");

        uint256 balance = token_.balanceOf(address(this));
        token_.safeTransfer(to, balance);

        emit Rescue(address(token_), balance, to);
    }
}
