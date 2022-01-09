// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.10;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract TestERC20 is ERC20("MAGIC", "Magic") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TestERC1155 is ERC1155("") {
    function mint(
        address to,
        uint256 id,
        uint256 amount
    ) external {
        _mint(to, id, amount, "");
    }
}

contract TestERC721 is ERC721("LG", "Magic Legions") {
    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
