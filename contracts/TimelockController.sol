// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title IoTTimelockController
 * @dev Extended TimelockController for IoT Billing upgrade governance
 * @notice Minimum delay: 48 hours for production safety
 * @custom:security-contact security@iotbilling.example
 */
contract IoTTimelockController is TimelockController {
    
    /// @dev Minimum delay enforced (48 hours = 172800 seconds)
    uint256 public constant MINIMUM_DELAY = 172800;
    
    /// @dev Maximum delay allowed (30 days = 2592000 seconds)
    uint256 public constant MAXIMUM_DELAY = 2592000;

    /// @dev Mapping of approved target contracts
    mapping(address => bool) public approvedTargets;

    /// @dev Events
    event TargetApproved(address indexed target);
    event TargetRevoked(address indexed target);
    event OperationScheduledWithDetails(
        bytes32 indexed id,
        address indexed target,
        uint256 value,
        bytes data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay,
        uint256 executeAfter
    );

    /// @dev Errors
    error DelayTooShort(uint256 provided, uint256 minimum);
    error DelayTooLong(uint256 provided, uint256 maximum);
    error TargetNotApproved(address target);
    error ZeroAddress();

    /**
     * @notice Constructor
     * @param minDelay Initial minimum delay (must be >= MINIMUM_DELAY)
     * @param proposers Addresses that can propose operations
     * @param executors Addresses that can execute operations
     * @param admin Admin address (can be address(0) for no admin)
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        if (minDelay < MINIMUM_DELAY) revert DelayTooShort(minDelay, MINIMUM_DELAY);
        if (minDelay > MAXIMUM_DELAY) revert DelayTooLong(minDelay, MAXIMUM_DELAY);
    }

    /**
     * @notice Approve a target contract for scheduled operations
     */
    function approveTarget(address target) external onlyRole(PROPOSER_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedTargets[target] = true;
        emit TargetApproved(target);
    }

    /**
     * @notice Revoke approval for a target contract
     */
    function revokeTarget(address target) external onlyRole(PROPOSER_ROLE) {
        approvedTargets[target] = false;
        emit TargetRevoked(target);
    }

    /**
     * @notice Schedule an operation with enhanced validation
     * @dev Override to enforce minimum delay and target approval
     */
    function schedule(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public virtual override onlyRole(PROPOSER_ROLE) {
        if (!approvedTargets[target] && target != address(this)) {
            revert TargetNotApproved(target);
        }
        if (delay < MINIMUM_DELAY) revert DelayTooShort(delay, MINIMUM_DELAY);
        if (delay > MAXIMUM_DELAY) revert DelayTooLong(delay, MAXIMUM_DELAY);

        super.schedule(target, value, data, predecessor, salt, delay);

        emit OperationScheduledWithDetails(
            hashOperation(target, value, data, predecessor, salt),
            target,
            value,
            data,
            predecessor,
            salt,
            delay,
            block.timestamp + delay
        );
    }

    /**
     * @notice Batch schedule operations
     */
    function scheduleBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public virtual override onlyRole(PROPOSER_ROLE) {
        if (delay < MINIMUM_DELAY) revert DelayTooShort(delay, MINIMUM_DELAY);
        if (delay > MAXIMUM_DELAY) revert DelayTooLong(delay, MAXIMUM_DELAY);

        for (uint256 i = 0; i < targets.length; i++) {
            if (!approvedTargets[targets[i]] && targets[i] != address(this)) {
                revert TargetNotApproved(targets[i]);
            }
        }

        super.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
    }

    /**
     * @notice Cancel an operation
     */
    function cancel(bytes32 id) public virtual override onlyRole(PROPOSER_ROLE) {
        super.cancel(id);
    }

    /**
     * @notice Execute a scheduled operation
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata payload,
        bytes32 predecessor,
        bytes32 salt
    ) public virtual override onlyRole(EXECUTOR_ROLE) {
        super.execute(target, value, payload, predecessor, salt);
    }

    /**
     * @notice Execute a batch of scheduled operations
     */
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) public virtual override onlyRole(EXECUTOR_ROLE) {
        super.executeBatch(targets, values, payloads, predecessor, salt);
    }

    /**
     * @notice Update minimum delay (must go through timelock itself)
     */
    function updateDelay(uint256 newDelay) external virtual override {
        if (newDelay < MINIMUM_DELAY) revert DelayTooShort(newDelay, MINIMUM_DELAY);
        if (newDelay > MAXIMUM_DELAY) revert DelayTooLong(newDelay, MAXIMUM_DELAY);
        super.updateDelay(newDelay);
    }
}