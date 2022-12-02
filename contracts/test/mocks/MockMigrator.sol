// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "../../interfaces/IMasterChefV2.sol";
import "../../DragonTributeUpgradeable.sol";

contract MockMigrator is IMigratorChef {
    event Migration(address oldToken, address newToken, uint256 amount);

    // Create a new token in the constructor
    DragonTributeUpgradeable tribute;

    constructor(DragonTributeUpgradeable _tribute) {
        tribute = _tribute;
    }

    // On migrate, mint those tokens for the caller and claim old tokens
    function migrate(IERC20 token) external returns (IERC20 newToken) {
        // require(tribute.mintRatio() == 1 ether, "Incorrect ratio");
        require(address(token) == address(tribute.magic()), "Token mismatch");

        // Get amount from allowance. For FireBreather, if token to migrate
        // equals the staking token, the contract will only approved the staked part.
        // Migrators that attempt to migrate the caller's entire balance will revert.
        uint256 amount = token.allowance(msg.sender, address(this));

        token.transferFrom(msg.sender, address(this), amount);
        token.approve(address(tribute), amount);

        tribute.deposit(amount);
        newToken = tribute.drMagic();

        newToken.transfer(msg.sender, newToken.balanceOf(address(this)));

        emit Migration(address(token), address(tribute.drMagic()), amount);
    }
}
