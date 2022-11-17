// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./interfaces/IMasterChefV2.sol";
import "./interfaces/IStash.sol";

// TODO:
// - Figure out if pullRewards should happen every time
//
// Tests
// - reward stash tests
// - masterchef/integration tests

/**
 * @title DragonFireBreather
 * @author kvk0x
 *
 * The Dragon Fire Breather contract is a MasterChef-based contract which
 * supports multiple staking pools. Each pool can be configured with a deposit token
 * (e.g., drMAGIC) and a reward token (e.g. MAGIC). Current planned pools are:
 *
 * 1. drMAGIC staking -> MAGIC rewards (blended Bridgeworld yield)
 * 2. drMAGIC/MAGIC LP -> MDD rewards (liqudity for entry/exit from drMAGIC)
 * 3. MDD/MAGIC LP -> MDD rewards (pool2)
 *
 * Each FireBreather contract supports a single reward token. Therefore, there will
 * be one deployment for any staking pool rewarding MAGIC, and one deployment for any
 * staking pool rewarding MDD.
 *
 * MasterChef reference implementation:
 * https://github.com/sushiswap/sushiswap/blob/archieve/canary/contracts/MasterChefV2.sol
 */
contract DragonFireBreather is Initializable, AccessControl, IMiniChefV2 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    // ============================================ ROLES ==============================================

    /// @dev Contract owner. Allowed to update access to other roles.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev Places where rewards can be pulled. Must implement IStash inferface.
    bytes32 public constant REWARD_STASH_ROLE = keccak256("REWARD_STASH_ROLE");

    /// @dev Reward distributor - can accrue rewards to the contract.
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    // ============================================ STATE ==============================================

    // ============= Global Staking State ==============

    uint256 public constant ONE = 1e18;

    /// @notice The reward token for the contract.
    IERC20 public immutable rewardToken;
    /// @notice The migrator contract. It has a lot of power. Can only be set through governance (owner).
    IMigratorChef public migrator;

    /// @notice Info of each MCV2 pool.
    PoolInfo[] public poolInfo;
    /// @notice Address of the staking token for each MCV2 pool.
    IERC20[] public stakingToken;
    /// @notice Address of each `IRewarder` contract in MCV2.
    IRewarder[] public rewarder;

    /// @dev Total allocation points. Must be the sum of all allocation points in all pools.
    uint256 public totalAllocPoint;
    /// @dev Total allocation points. Must be the sum of all allocation points in all pools.
    mapping(IERC20 => bool) public activeStakingTokens;

    // ============= User Staking State ==============

    /// @notice Info of each user that stakes LP tokens.
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Sets up the MasterChef contract to distribute a specific reward token. Also defines
     *         access control roles.
     *
     * @param _rewardToken                  The token to distribute to all staking pools.
     */
    constructor(IERC20 _rewardToken) {
        require(address(_rewardToken) != address(0), "No reward token");

        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(REWARD_STASH_ROLE, ADMIN_ROLE);
        _setRoleAdmin(DISTRIBUTOR_ROLE, ADMIN_ROLE);

        rewardToken = _rewardToken;
    }

    // ======================================== POOL MANAGEMENT ========================================

    /**
     * @notice Add a new staking token to the pool. Can only be called by the admin.
     *
     * @param allocPoint                    Allocation points of the new pool.
     * @param _stakingToken                 Address of the staking ERC20 token.
     * @param _rewarder                     Address of the rewarder delegate.
     */
    function add(
        uint256 allocPoint,
        IERC20 _stakingToken,
        IRewarder _rewarder
    ) public override onlyRole(ADMIN_ROLE) {
        require(!activeStakingTokens[_stakingToken], "Token already used");
        activeStakingTokens[_stakingToken] = true;

        totalAllocPoint += allocPoint;

        stakingToken.push(_stakingToken);
        rewarder.push(_rewarder);

        poolInfo.push(PoolInfo({ allocPoint: allocPoint.toUint64(), accRewardsPerShare: 0 }));

        emit LogPoolAddition(stakingToken.length - 1, allocPoint, _stakingToken, _rewarder);
    }

    /**
     * @notice Update the given pool's reward allocation point and `IRewarder` contract.
     *         Can only be called by the owner.
     *
     * @param _pid                              The index of the pool. See `poolInfo`.
     * @param _allocPoint                       New AP of the pool.
     * @param _rewarder                         Address of the rewarder delegate.
     * @param overwrite                         True if _rewarder should be `set`. Otherwise `_rewarder` is ignored.
     */
    function set(
        uint256 _pid,
        uint256 _allocPoint,
        IRewarder _rewarder,
        bool overwrite
    ) public override onlyRole(ADMIN_ROLE) {
        totalAllocPoint = totalAllocPoint - poolInfo[_pid].allocPoint + _allocPoint;

        poolInfo[_pid].allocPoint = _allocPoint.toUint64();

        if (overwrite) rewarder[_pid] = _rewarder;

        emit LogSetPool(_pid, _allocPoint, overwrite ? _rewarder : rewarder[_pid], overwrite);
    }

    // ======================================== USER OPERATIONS ========================================

    /**
     * @notice Deposit LP tokens to MCV2 for reward allocation.
     *
     * @param pid                               The index of the pool. See `poolInfo`.
     * @param amount                            Staking token amount to deposit.
     * @param to                                The receiver of `amount` deposit benefit.
     */
    function deposit(
        uint256 pid,
        uint256 amount,
        address to
    ) public override {
        PoolInfo memory pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][to];

        // Effects
        user.amount += amount;

        int256 accumulatedRewards = _accumulatedRewards(amount, pool.accRewardsPerShare);
        user.rewardDebt += accumulatedRewards;

        // Interactions
        IRewarder _rewarder = rewarder[pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onReward(pid, to, to, 0, user.amount);
        }

        stakingToken[pid].safeTransferFrom(msg.sender, address(this), amount);

        emit Deposit(msg.sender, pid, amount, to);
    }

    /**
     * @notice Withdraw LP tokens from MCV2.
     *
     * @param pid                               The index of the pool. See `poolInfo`.
     * @param amount                            LP token amount to withdraw.
     * @param to                                Receiver of the LP tokens.
     */
    function withdraw(
        uint256 pid,
        uint256 amount,
        address to
    ) public override {
        PoolInfo memory pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];

        // Effects
        user.rewardDebt -= _accumulatedRewards(amount, pool.accRewardsPerShare);
        user.amount -= amount;

        // Interactions
        IRewarder _rewarder = rewarder[pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onReward(pid, msg.sender, to, 0, user.amount);
        }

        stakingToken[pid].safeTransfer(to, amount);

        emit Withdraw(msg.sender, pid, amount, to);
    }

    /**
     * @notice Harvest proceeds for transaction sender to `to`.
     *
     * @param pid                               The index of the pool. See `poolInfo`.
     * @param to                                Receiver of rewards.
     */
    function harvest(uint256 pid, address to) public override {
        PoolInfo memory pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];

        int256 accumulatedRewards = _accumulatedRewards(user.amount, pool.accRewardsPerShare);
        int256 pendingReward = accumulatedRewards - user.rewardDebt;
        uint256 reward = pendingReward > 0 ? pendingReward.toUint256() : 0;

        // Effects
        user.rewardDebt = accumulatedRewards;

        // Interactions
        if (reward > 0) {
            rewardToken.safeTransfer(to, reward);
        }

        IRewarder _rewarder = rewarder[pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onReward(pid, msg.sender, to, reward, user.amount);
        }

        emit Harvest(msg.sender, pid, reward);
    }

    /**
     * @notice Withdraw staking tokens from MCV2 and harvest proceeds for transaction sender to `to`.
     *
     * @param pid                                   The index of the pool. See `poolInfo`.
     * @param amount                                Staking token amount to withdraw.
     * @param to                                    Receiver of the staking tokens and rewards.
     */
    function withdrawAndHarvest(
        uint256 pid,
        uint256 amount,
        address to
    ) public {
        PoolInfo memory pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];

        int256 accumulatedRewards = _accumulatedRewards(user.amount, pool.accRewardsPerShare);
        int256 pendingReward = accumulatedRewards - user.rewardDebt;

        // Effects
        user.amount -= amount;
        user.rewardDebt = _accumulatedRewards(user.amount, pool.accRewardsPerShare);

        uint256 reward = pendingReward > 0 ? pendingReward.toUint256() : 0;

        // Interactions
        if (reward > 0) {
            rewardToken.safeTransfer(to, reward);
        }

        IRewarder _rewarder = rewarder[pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onReward(pid, msg.sender, to, reward, user.amount);
        }

        stakingToken[pid].safeTransfer(to, amount);

        emit Withdraw(msg.sender, pid, amount, to);
        emit Harvest(msg.sender, pid, reward);
    }

    /**
     * @notice Withdraw without caring about rewards. EMERGENCY ONLY.
     *
     * @param pid                                   The index of the pool. See `poolInfo`.
     * @param to                                    Receiver of the staking tokens.
     */
    function emergencyWithdraw(uint256 pid, address to) public {
        UserInfo storage user = userInfo[pid][msg.sender];

        uint256 amount = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;

        IRewarder _rewarder = rewarder[pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onReward(pid, msg.sender, to, 0, 0);
        }

        // Note: transfer can fail or succeed if `amount` is zero.
        stakingToken[pid].safeTransfer(to, amount);
        emit EmergencyWithdraw(msg.sender, pid, amount, to);
    }

    // ======================================== VIEW FUNCTIONS =========================================

    /**
     * @notice Returns the number of MCV2 pools.
     *
     * @return pools                        The total number of pools.
     */
    function poolLength() public view returns (uint256 pools) {
        pools = poolInfo.length;
    }

    /**
     * @notice View function to see pending rewards on frontend.
     *
     * @param _pid                          The index of the pool. See `poolInfo`.
     * @param _user                         Address of user.
     * @return pending                      Reward for a given user.
     */
    function pendingRewards(uint256 _pid, address _user) external view override returns (uint256) {
        PoolInfo memory pool = poolInfo[_pid];
        UserInfo memory user = userInfo[_pid][_user];

        int256 accumulatedRewards = _accumulatedRewards(user.amount, pool.accRewardsPerShare);
        int256 pending = accumulatedRewards - user.rewardDebt;

        return pending > 0 ? pending.toUint256() : 0;
    }

    function getUserInfo(uint256 _pid, address _user) external view override returns (uint256, int256) {
        UserInfo memory user = userInfo[_pid][_user];

        return (user.amount, user.rewardDebt);
    }

    // ======================================= ADMIN OPERATIONS =======================================

    /**
     * @notice Set the `migrator` contract. Can only be called by the admin.
     *
     * @param _migrator                     The contract address of the new migrator.
     */
    function setMigrator(IMigratorChef _migrator) public onlyRole(ADMIN_ROLE) {
        migrator = _migrator;

        emit SetMigrator(msg.sender, address(migrator));
    }

    /**
     * @notice Migrate LP token to another LP contract through the `migrator` contract.
     *
     * @param _pid                              The index of the pool. See `poolInfo`.
     */
    function migrate(uint256 _pid) public onlyRole(ADMIN_ROLE) {
        require(address(migrator) != address(0), "No migrator set");

        IERC20 stakingToken_ = stakingToken[_pid];

        uint256 bal = stakingToken_.balanceOf(address(this));
        stakingToken_.approve(address(migrator), bal);

        IERC20 newStakingToken = migrator.migrate(stakingToken_);
        require(bal == newStakingToken.balanceOf(address(this)), "MasterChefV2: migrated balance must match");

        stakingToken[_pid] = newStakingToken;
    }

    /**
     * @notice MDD-specific: pull reward token from a specified address. The address
     *         must have approved tokens and have the reward stash role (to prevent
     *         this fn from being used to drain user wallets who have approved for
     *         deposits.)
     *˙
     * @param _from                             The reward stash to pull rewards from.
     */
    function pullRewards(address _from) public onlyRole(DISTRIBUTOR_ROLE) {
        require(hasRole(REWARD_STASH_ROLE, _from), "Not reward stash");

        uint256 rewards = IStash(_from).request();

        _updatePools(rewards);
    }

    /**
     * @dev Update all pools' reward accumulators upon detection or collection
     *      of new rewards. Updates proportionally based on alloc points.
     *
     * @param amount                            The amount of new rewards to distribute to pools.
     */
    function _updatePools(uint256 amount) internal {
        uint256 numPools = poolInfo.length;

        for (uint256 i = 0; i < numPools; ++i) {
            PoolInfo storage pool = poolInfo[i];
            uint256 totalStaked = stakingToken[i].balanceOf(address(this));

            if (totalStaked == 0) continue;

            uint256 newRewards = (amount * pool.allocPoint) / totalAllocPoint;
            pool.accRewardsPerShare += uint128((newRewards * ONE) / totalStaked);

            emit LogUpdatePool(i, uint64(block.number), totalStaked, pool.accRewardsPerShare);
        }
    }

    /**
     * @dev Calculate the current accumulated rewards for a given amount of stake.
     *      Reduces the awards by 1 wei due to an off-by-one issue in the atlas mine.
     *
     * @param stakeAmount                       The amount of stake to accumulate rewards for.
     * @param accRewardsPerShare                The pool's accRewardsPerShare value.
     */
    function _accumulatedRewards(uint256 stakeAmount, uint256 accRewardsPerShare) internal pure returns (int256) {
        return ((stakeAmount * accRewardsPerShare) / ONE).toInt256();
    }
}
