// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IoTBillingService.sol";

/**
 * @title IoTBillingServiceV2
 * @dev Version 2: Adds subscription billing and discount tiers
 */
contract IoTBillingServiceV2 is IoTBillingService {
    
    /// @dev Subscription tiers
    enum Tier { NONE, BASIC, PRO, ENTERPRISE }

    struct Subscription {
        Tier tier;
        uint256 startTime;
        uint256 endTime;
        uint256 discountBps; // Basis points (100 = 1%)
    }

    /// @dev Mapping of device to subscription
    mapping(address => Subscription) public subscriptions;

    /// @dev Tier discounts (basis points)
    mapping(Tier => uint256) public tierDiscounts;

    /// @dev New events
    event SubscriptionCreated(address indexed deviceId, Tier tier, uint256 discountBps, uint256 endTime);
    event SubscriptionCancelled(address indexed deviceId, uint256 timestamp);
    event TierDiscountUpdated(Tier tier, uint256 newDiscountBps);

    /// @dev New errors
    error InvalidTier();
    error SubscriptionActive();
    error SubscriptionExpired();
    error InvalidDiscount();

    /**
     * @notice Reinitializer for V2 upgrade
     */
    function initializeV2() public reinitializer(2) {
        tierDiscounts[Tier.BASIC] = 500;      // 5%
        tierDiscounts[Tier.PRO] = 1500;         // 15%
        tierDiscounts[Tier.ENTERPRISE] = 2500;  // 25%
    }

    /**
     * @notice Create a subscription for a device
     */
    function createSubscription(
        address _deviceId,
        Tier _tier,
        uint256 _duration
    ) external onlyRole(BILLING_ADMIN_ROLE) onlyRegisteredDevice(_deviceId) whenNotPaused {
        if (_tier == Tier.NONE) revert InvalidTier();
        if (subscriptions[_deviceId].endTime > block.timestamp) revert SubscriptionActive();

        uint256 discount = tierDiscounts[_tier];
        uint256 endTime = block.timestamp + _duration;

        subscriptions[_deviceId] = Subscription({
            tier: _tier,
            startTime: block.timestamp,
            endTime: endTime,
            discountBps: discount
        });

        emit SubscriptionCreated(_deviceId, _tier, discount, endTime);
    }

    /**
     * @notice Override recordBilling to apply subscription discounts
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
        override
        onlyRole(BILLING_ADMIN_ROLE) 
        onlyRegisteredDevice(_deviceId) 
        whenNotPaused 
        nonReentrant 
        returns (bytes32 txHash) 
    {
        // Apply discount if subscription is active
        uint256 effectiveRate = _ratePerUnit;
        Subscription memory sub = subscriptions[_deviceId];
        if (sub.endTime > block.timestamp && sub.discountBps > 0) {
            effectiveRate = _ratePerUnit * (10000 - sub.discountBps) / 10000;
        }

        // Reuse parent logic with effective rate
        if (usedNonces[_nonce]) revert NonceAlreadyUsed();
        if (_ratePerUnit != currentRatePerUnit) revert InvalidAmount();
        
        uint256 amount = _usageUnits * effectiveRate;
        if (amount == 0) revert InvalidAmount();

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
            effectiveRate,
            _timestamp,
            _nonce,
            block.number,
            version
        ));

        billingRecords[txHash] = BillingRecord({
            deviceId: _deviceId,
            usageUnits: _usageUnits,
            ratePerUnit: effectiveRate,
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
     * @notice Update tier discount
     */
    function updateTierDiscount(Tier _tier, uint256 _discountBps) 
        external 
        onlyRole(BILLING_ADMIN_ROLE) 
        whenNotPaused
    {
        if (_tier == Tier.NONE) revert InvalidTier();
        if (_discountBps > 5000) revert InvalidDiscount(); // Max 50%
        
        tierDiscounts[_tier] = _discountBps;
        emit TierDiscountUpdated(_tier, _discountBps);
    }
}
