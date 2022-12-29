// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMigratorChef {
    // Take the current LP token address and return the new LP token address.
    // Migrator should have full access to the caller's LP token.
    function migrate(IERC20 token) external returns (IERC20);
}

interface IRewarder {
    // ================= Reward Functions ==================

    function onReward(
        uint256 pid,
        address user,
        address recipient,
        uint256 amount,
        uint256 newLpAmount
    ) external;

    function pendingTokens(
        uint256 pid,
        address user,
        uint256 amount
    ) external view returns (IERC20[] memory, uint256[] memory);
}

interface IMiniChefV2 {
    // ============= Events ==============

    event Deposit(address indexed user, uint256 indexed pid, uint256 amount, address indexed to);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount, address indexed to);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount, address indexed to);
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);
    event LogPoolAddition(uint256 indexed pid, uint256 allocPoint, IERC20 indexed lpToken, IRewarder indexed rewarder);
    event LogSetPool(uint256 indexed pid, uint256 allocPoint, IRewarder indexed rewarder, bool overwrite);
    event LogUpdatePool(uint256 indexed pid, uint64 lastRewardBlock, uint256 lpSupply, uint256 accSushiPerShare);
    event SetMigrator(address indexed admin, address migrator);

    // ================= Data Types ==================

    /// @notice Info of each MCV2 user.
    /// `amount` LP token amount the user has provided.
    /// `rewardDebt` The amount of rewards entitled to the user.
    struct UserInfo {
        uint256 amount;
        int256 rewardDebt;
        bool autoPull;
    }

    struct PoolInfo {
        uint128 accRewardsPerShare;
        // uint64 lastRewardBlock;      Not used in MDD implementation: rewards disbursed ad-hoc
        //                              as opposed to per-block.
        uint64 allocPoint;
        uint256 totalStaked; // New in MDD implementation - since rewardToken may be equivalent
        // to staking token.
    }

    // ============== Pool Management ===============

    function add(
        uint256 allocPoint,
        IERC20 _stakingToken,
        IRewarder _rewarder
    ) external;

    function set(
        uint256 _pid,
        uint256 _allocPoint,
        IRewarder _rewarder,
        bool overwrite
    ) external;

    // ============= Staking Operations ==============

    function deposit(
        uint256 pid,
        uint256 amount,
        address to
    ) external;

    function withdraw(
        uint256 pid,
        uint256 amount,
        address to
    ) external;

    function harvest(uint256 pid, address to) external;

    function withdrawAndHarvest(
        uint256 pid,
        uint256 amount,
        address to
    ) external;

    function emergencyWithdraw(uint256 pid, address to) external;

    // =============== View Functions ================

    function poolLength() external view returns (uint256);

    // Not used in MDD impl: all pools updated at once.
    // function updatePool(uint256 pid) external returns (PoolInfo memory);

    // function userInfo(uint256 _pid, address _user) external view returns (uint256, uint256);
    // Modified to:
    function getUserInfo(uint256 _pid, address _user) external view returns (uint256, int256);

    function pendingRewards(uint256 _pid, address _user) external view returns (uint256);
}
