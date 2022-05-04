// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "./interfaces/IERC20Mintable.sol";
import "./interfaces/IDragonDepositor.sol";

/**
 * @title DragonDepositor
 * @author kvk0x
 *
 * The Dragon Depositor contract allows the transmutation of MAGIC into drMAGIC,
 * the wrapped MAGIC token representing exposure to the MDD ecosystem.
 *
 * This contract allows users to deposit MAGIC, for which they will be minted
 * drMAGIC at a predefined ratio.
 */
contract DragonDepositorUpgradeable is
    IDragonDepositor,
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // ============================================ ROLES ==============================================

    /// @dev Contract owner. Allowed to update access to other roles.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev Role allowing the withdrawal of deposited MAGIC.
    bytes32 public constant WITHDRAW_ROLE = keccak256("WITHDRAW_ROLE");

    // ============================================ STATE ==============================================

    // ============= Global Immutable State ==============

    /// @notice MAGIC token
    /// @dev functionally immutable
    IERC20Upgradeable public magic;
    /// @notice drMAGIC token
    /// @dev functionally immutable
    IERC20Mintable public drMagic;

    // ============== Deposit Ratio State ================

    /// @notice The denominator for the expressed deposit ratio
    uint256 public constant RATIO_DENOM = 1e18;
    /// @notice The ratio of drMAGIC minted per MAGIC deposited. 1e18 represnts a 1-1 ratio.
    uint256 public mintRatio;

    // ============== Admin Operations State State ================

    /// @notice Whether the depositor is accepting new deposits. For emergencies
    ///         or to prevent new minting of drMAGIC.
    bool public paused;

    // ========================================== INITIALIZER ===========================================

    /**
     * @dev Prevents malicious initializations of base implementation by
     *      setting contract to initialized on deployment.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() initializer {}

    /**
     * @param _magic                The MAGIC token address.
     * @param _drMagic              The drMAGIC token address.
     */
    function initialize(IERC20Upgradeable _magic, IERC20Mintable _drMagic) external initializer {
        require(address(_magic) != address(0), "Invalid magic token address");
        require(address(_drMagic) != address(0), "Invalid drMagic token address");

        __AccessControl_init();
        __ReentrancyGuard_init();

        _setupRole(ADMIN_ROLE, msg.sender);

        // Allow only admins to change other roles
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(WITHDRAW_ROLE, ADMIN_ROLE);

        magic = _magic;
        drMagic = _drMagic;
    }

    // ======================================== USER OPERATIONS ========================================

    /**
     * @notice Deposit MAGIC to mint drMAGIC, according to the current mint ratio.
     *
     * @param _amount               The amount of MAGIC to deposit.
     */
    function deposit(uint256 _amount) external virtual override nonReentrant {
        _deposit(msg.sender, _amount);
    }

    /**
     * @notice Deposit MAGIC to mint drMAGIC, according to the current mint ratio.
     *         Can mint to another address besides depositor. Depositor must always
     *         directly provide MAGIC,
     *
     * @param user                  The address to receive the minted drMAGIC.
     * @param _amount               The amount of MAGIC to deposit.
     */
    function depositFor(address user, uint256 _amount) external virtual override {
        _deposit(user, _amount);
    }

    /**
     * @dev Internal function for deposit logic. Calculates the amount of drMAGIC to
     *      mint, collects the specified MAGIC, and mints the drMAGIc to the specified
     *      user.
     *
     * @param user                  The address to receive the minted drMAGIC.
     * @param _amount               The amount of MAGIC to deposit.
     */
    function _deposit(address user, uint256 _amount) internal nonReentrant {
        require(!paused, "new deposits paused");
        require(_amount > 0, "Deposit amount 0");

        uint256 toMint = _amount * mintRatio;

        magic.safeTransferFrom(msg.sender, address(this), _amount);
        drMagic.mint(msg.sender, toMint);

        emit Deposit(user, _amount, toMint);
    }

    // ======================================= ADMIN OPERATIONS =======================================

    /**
     * @notice Withdraw deposited MAGIC. Any MAGIC withdrawn from this contract should be directed
     *         towards generating emissions for drMAGIC staking and other reward pools. The admin
     *         can defined the allowed withdrawers.
     *
     * @param _amount               The amount of MAGIC to withdraw.
     */
    function withdrawMagic(uint256 _amount) external virtual override onlyRole(WITHDRAW_ROLE) {
        require(_amount > 0, "Withdraw amount 0");

        magic.safeTransfer(msg.sender, _amount);

        emit WithdrawMagic(msg.sender, _amount);
    }

    /**
     * @notice Change the ratio of units of drMAGIC minted per unit of MAGIC deposited. Can be used
     *         to encourage a certain drMAGIC/MAGIC peg or concentrate/dilute yield per unit of drMAGIC.
     *
     * @dev    The ratio has 18 units of precision, such that a value of 1e18 represents a 1-1 mint ratio.
     *
     * @param _ratio               The ratio of drMAGIC to mint per MAGIC deposited.
     */
    function setMintRatio(uint256 _ratio) external override onlyRole(ADMIN_ROLE) {
        require(_ratio > 0, "Ratio 0");

        mintRatio = _ratio;

        emit SetMintRatio(_ratio);
    }

    /**
     * @notice Pause the contract, preventing new minting of drMAGIC. Can be used in case of bugs,
     *         or limiting access to drMAGIC if managing supply. Can only be called by admin.
     *
     * @param _paused               Whether deposits should be paused.
     */
    function setPaused(bool _paused) external override onlyRole(ADMIN_ROLE) {
        paused = _paused;

        emit SetPaused(_paused);
    }
}
