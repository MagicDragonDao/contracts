// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

interface IDragonDepositor {
    // ============= Events ==============

    event Deposit(address indexed user, uint256 amountDeposited, uint256 amountMinted);
    event WithdrawMagic(address indexed user, uint256 amount);
    event SetMintRatio(uint256 ratio);
    event SetPaused(bool paused);

    // ============= User Operations ==============

    function deposit(uint256 _amount) external;

    function depositFor(address user, uint256 _amount) external;

    // ============= Owner Operations ==============

    function withdrawMagic(uint256 _amount) external;

    function setMintRatio(uint256 _ratio) external;

    function setPaused(bool _paused) external;
}
