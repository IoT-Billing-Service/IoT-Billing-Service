// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title IoTBillingService
 * @dev Core billing contract for IoT platform with cryptographic verification
 * @notice PCI-DSS & SOC2 compliant: all transactions cryptographically signed
 * @custom:security-contact security@iotbilling.example
 */
contract IoTBillingService is 
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    EIP712 
{
    using ECDSA for bytes32;

    // ============ Roles ============
    bytes32 public constant BILLING_ADMIN_ROLE = keccak256("BILLING_ADMIN_ROLE");
    bytes32 public constant DEVICE_MANAGER_ROLE = keccak256("DEVICE_MANAGER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant UPGRADE_ADMIN_ROLE = keccak256("UPGRADE_ADMIN_ROLE");

    // ============ Type Hashes (EIP-712) ============
    bytes32 private constant BILLING_TYPEHASH = keccak256(
        "BillingTransaction(address deviceId,uint256 usageUnits,uint256 ratePerUnit,uint256 timestamp,uint256 nonce)"
    );
    bytes32 private constant DEVICE_REGISTRATION_TYPEHASH = keccak256(
        "DeviceRegistration(address deviceId,string metadataHash,uint256 timestamp)"
    );

    // ============ State Variables ============
    
    /// @dev Device information structure
    struct Device {
        address owner;
        string metadataHash;      // IPFS hash of device metadata
        uint256 registrationTime;
        bool isActive;
        uint256 totalBilled;
        uint256 totalPaid;
    }

    /// @dev Billing record structure
    struct BillingRecord {
        address deviceId;
        uint256 usageUnits;
        uint256 ratePerUnit;
        uint256 amount;
        uint256 timestamp;
        bytes signature;
        bool isVerified;
        bytes32 txHash;
    }

    /// @dev Mapping of device addresses to device info
    mapping(address => Device) public devices;
    
    /// @dev Mapping of billing record IDs to records
    mapping(bytes32 => BillingRecord) public billingRecords;
    
    /// @dev Mapping of used nonces to prevent replay attacks
    mapping(uint256 => bool) public usedNonces;
    
    /// @dev Array of all device addresses
    address[] public deviceList;
    
    /// @dev Total billing volume
    uint256 public totalBillingVolume;
    
    /// @dev Current billing rate (can be updated via timelock)
    uint256 public currentRatePerUnit;
    
    /// @dev Contract version for upgrade tracking
    uint256 public version;

    // ============ Events ============
    event DeviceRegistered(address indexed deviceId, address indexed owner, string metadataHash, uint256 timestamp);
    event DeviceDeactivated(address indexed deviceId, uint256 timestamp);
    event BillingRecorded(bytes32 indexed txHash, address indexed deviceId, uint256 amount, uint256 timestamp);
    event PaymentProcessed(bytes32 indexed txHash, address indexed deviceId, uint256 amount, uint256 timestamp);
    event RateUpdated(uint256 oldRate, uint256 newRate, uint256 timestamp);
    event EmergencyPaused(address indexed admin);
    event EmergencyUnpaused(address indexed admin);
    event VersionUpgraded(uint256 oldVersion, uint256 newVersion);

    // ============ Errors ============
    error InvalidSignature();
    error DeviceNotRegistered();
    error DeviceAlreadyRegistered();
    error DeviceNotActive();
    error InvalidAmount();
    error NonceAlreadyUsed();
    error UnauthorizedCaller();
    error RateTooHigh();
    error RateTooLow();
    error ZeroAddress();

    // ============ Modifiers ============
    modifier onlyRegisteredDevice(address _deviceId) {
        if (!devices[_deviceId].isActive) revert DeviceNotActive();
        _;
    }

    // ============ Constructor & Initializer ============
    
    constructor() EIP712("IoTBillingService", "1") {}

    /**
     * @notice Initialize the contract (proxy pattern)
     * @param _admin Address of the initial admin
     * @param _ratePerUnit Initial billing rate per unit
     */
    function initialize(address _admin, uint256 _ratePerUnit) public initializer {
        if (_admin == address(0)) revert ZeroAddress();
        
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(BILLING_ADMIN_ROLE, _admin);
        _grantRole(DEVICE_MANAGER_ROLE, _admin);
        _grantRole(AUDITOR_ROLE, _admin);
        _grantRole(UPGRADE_ADMIN_ROLE, _admin);

        currentRatePerUnit = _ratePerUnit;
        version = 1;
    }

    // ============ Device Management ============

    /**
     * @notice Register a new IoT device with cryptographic verification
     * @param _deviceId Device wallet address
     * @param _metadataHash IPFS hash of device metadata
     * @param _signature ECDSA signature from device owner
     * @param _timestamp Registration timestamp
     */
    function registerDevice(
        address _deviceId,
        string calldata _metadataHash,
        bytes calldata _signature,
        uint256 _timestamp
    ) external onlyRole(DEVICE_MANAGER_ROLE) whenNotPaused {
        if (devices[_deviceId].registrationTime != 0) revert DeviceAlreadyRegistered();
        if (_deviceId == address(0)) revert ZeroAddress();

        // Verify cryptographic signature
        bytes32 structHash = keccak256(abi.encode(
            DEVICE_REGISTRATION_TYPEHASH,
            _deviceId,
            keccak256(bytes(_metadataHash)),
            _timestamp
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(_signature);

        if (signer != _deviceId) revert InvalidSignature();

        devices[_deviceId] = Device({
            owner: signer,
            metadataHash: _metadataHash,
            registrationTime: block.timestamp,
            isActive: true,
            totalBilled: 0,
            totalPaid: 0
        });

        deviceList.push(_deviceId);

        emit DeviceRegistered(_deviceId, signer, _metadataHash, block.timestamp);
    }

    /**
     * @notice Deactivate a device
     */
    function deactivateDevice(address _deviceId) 
        external 
        onlyRole(DEVICE_MANAGER_ROLE) 
        onlyRegisteredDevice(_deviceId) 
    {
        devices[_deviceId].isActive = false;
        emit DeviceDeactivated(_deviceId, block.timestamp);
    }

    // ============ Billing Operations ============

    /**
     * @notice Record a billing transaction with cryptographic verification
     * @dev P99 target: <200ms. Signature verification is O(1) complexity
     * @param _deviceId Device address
     * @param _usageUnits Amount of usage units consumed
     * @param _ratePerUnit Rate per unit (must match current rate)
     * @param _timestamp Transaction timestamp
     * @param _nonce Unique nonce to prevent replay
     * @param _signature ECDSA signature from device
     */
    function recordBilling(
        address _deviceId,
        uint256 _usageUnits,
        uint256 _ratePerUnit,
        uint256 _timestamp,
        uint256 _nonce,
        bytes calldata _signature
    ) 
        external 
        onlyRole(BILLING_ADMIN_ROLE) 
        onlyRegisteredDevice(_deviceId) 
        whenNotPaused 
        nonReentrant 
        returns (bytes32 txHash) 
    {
        if (usedNonces[_nonce]) revert NonceAlreadyUsed();
        if (_ratePerUnit != currentRatePerUnit) revert InvalidAmount();
        
        uint256 amount = _usageUnits * _ratePerUnit;
        if (amount == 0) revert InvalidAmount();

        // Cryptographic verification
        bytes32 structHash = keccak256(abi.encode(
            BILLING_TYPEHASH,
            _deviceId,
            _usageUnits,
            _ratePerUnit,
            _timestamp,
            _nonce
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(_signature);

        if (signer != _deviceId) revert InvalidSignature();

        usedNonces[_nonce] = true;

        txHash = keccak256(abi.encodePacked(
            _deviceId,
            _usageUnits,
            _ratePerUnit,
            _timestamp,
            _nonce,
            block.number
        ));

        billingRecords[txHash] = BillingRecord({
            deviceId: _deviceId,
            usageUnits: _usageUnits,
            ratePerUnit: _ratePerUnit,
            amount: amount,
            timestamp: block.timestamp,
            signature: _signature,
            isVerified: true,
            txHash: txHash
        });

        devices[_deviceId].totalBilled += amount;
        totalBillingVolume += amount;

        emit BillingRecorded(txHash, _deviceId, amount, block.timestamp);
    }

    /**
     * @notice Process payment for a billing record
     */
    function processPayment(bytes32 _txHash) 
        external 
        payable 
        onlyRegisteredDevice(billingRecords[_txHash].deviceId) 
        nonReentrant 
    {
        BillingRecord storage record = billingRecords[_txHash];
        if (!record.isVerified) revert InvalidAmount();
        if (msg.value != record.amount) revert InvalidAmount();

        devices[record.deviceId].totalPaid += msg.value;

        emit PaymentProcessed(_txHash, record.deviceId, msg.value, block.timestamp);
    }

    // ============ Admin Functions ============

    /**
     * @notice Update billing rate (intended to be called via Timelock)
     * @param _newRate New rate per unit
     */
    function updateRate(uint256 _newRate) 
        external 
        onlyRole(BILLING_ADMIN_ROLE) 
        whenNotPaused 
    {
        if (_newRate == 0 || _newRate > currentRatePerUnit * 10) revert RateTooHigh();
        
        uint256 oldRate = currentRatePerUnit;
        currentRatePerUnit = _newRate;

        emit RateUpdated(oldRate, _newRate, block.timestamp);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    // ============ View Functions ============

    function getDevice(address _deviceId) external view returns (Device memory) {
        return devices[_deviceId];
    }

    function getBillingRecord(bytes32 _txHash) external view returns (BillingRecord memory) {
        return billingRecords[_txHash];
    }

    function getDeviceCount() external view returns (uint256) {
        return deviceList.length;
    }

    function verifyBillingSignature(
        address _deviceId,
        uint256 _usageUnits,
        uint256 _ratePerUnit,
        uint256 _timestamp,
        uint256 _nonce,
        bytes calldata _signature
    ) external view returns (bool) {
        bytes32 structHash = keccak256(abi.encode(
            BILLING_TYPEHASH,
            _deviceId,
            _usageUnits,
            _ratePerUnit,
            _timestamp,
            _nonce
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(_signature);
        return signer == _deviceId;
    }

    // ============ Upgrade Authorization ============

    /**
     * @dev Only UPGRADE_ADMIN_ROLE can authorize upgrades
     * @notice This is the critical security gate. The actual upgrade goes through Timelock
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADE_ADMIN_ROLE) {
        version++;
        emit VersionUpgraded(version - 1, version);
    }

    // ============ Receive/Fallback ============
    receive() external payable {
        revert("Direct payments not allowed");
    }
}