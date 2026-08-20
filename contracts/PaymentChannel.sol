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
 * @title PaymentChannel
 * @dev Peer-to-peer payment channel for high-frequency IoT microtransactions (Issue #295)
 * @notice Provides off-chain cryptographically signed payment vouchers with on-chain dispute resolution.
 * PCI-DSS & SOC2 compliant: tamper-evident cryptographic state and audit events.
 */
contract PaymentChannel is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    EIP712
{
    using ECDSA for bytes32;

    bytes32 public constant CHANNEL_ADMIN_ROLE = keccak256("CHANNEL_ADMIN_ROLE");
    bytes32 public constant EMERGENCY_PAUSER_ROLE = keccak256("EMERGENCY_PAUSER_ROLE");

    bytes32 private constant VOUCHER_TYPEHASH = keccak256(
        "PaymentVoucher(bytes32 channelId,uint256 sequence,uint256 cumulativeAmount,bytes32 nonce,uint256 expiresAt)"
    );

    enum ChannelStatus { OPEN, CLOSING, DISPUTED, SETTLED, EXPIRED }

    struct Channel {
        bytes32 channelId;
        address sender;
        address recipient;
        uint256 totalDeposit;
        uint256 settledAmount;
        uint256 sequence;
        ChannelStatus status;
        uint256 disputePeriod;
        uint256 disputeExpiresAt;
        uint256 expiresAt;
    }

    mapping(bytes32 => Channel) public channels;

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed sender,
        address indexed recipient,
        uint256 totalDeposit,
        uint256 expiresAt
    );
    event ChannelTopUp(bytes32 indexed channelId, uint256 additionalDeposit, uint256 newTotalDeposit);
    event VoucherClaimed(bytes32 indexed channelId, uint256 sequence, uint256 cumulativeAmount);
    event ChannelClosed(bytes32 indexed channelId, uint256 recipientPayout, uint256 senderRefund);
    event DisputeInitiated(bytes32 indexed channelId, uint256 sequence, uint256 claimedAmount, uint256 challengeDeadline);
    event DisputeSettled(bytes32 indexed channelId, uint256 recipientPayout, uint256 senderRefund);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() EIP712("IoTBillingPaymentChannel", "1") {
        _disableInitializers();
    }

    function initialize(address defaultAdmin) external initializer {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(CHANNEL_ADMIN_ROLE, defaultAdmin);
        _grantRole(EMERGENCY_PAUSER_ROLE, defaultAdmin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /**
     * @notice Open a new payment channel by depositing native currency.
     */
    function openChannel(
        bytes32 channelId,
        address recipient,
        uint256 expirationDuration,
        uint256 disputePeriod
    ) external payable whenNotPaused nonReentrant {
        require(msg.value > 0, "Deposit must be greater than zero");
        require(recipient != address(0) && recipient != msg.sender, "Invalid recipient");
        require(channels[channelId].sender == address(0), "Channel already exists");

        uint256 expiresAt = block.timestamp + (expirationDuration > 0 ? expirationDuration : 30 days);
        uint256 dispPeriod = disputePeriod > 0 ? disputePeriod : 1 days;

        channels[channelId] = Channel({
            channelId: channelId,
            sender: msg.sender,
            recipient: recipient,
            totalDeposit: msg.value,
            settledAmount: 0,
            sequence: 0,
            status: ChannelStatus.OPEN,
            disputePeriod: dispPeriod,
            disputeExpiresAt: 0,
            expiresAt: expiresAt
        });

        emit ChannelOpened(channelId, msg.sender, recipient, msg.value, expiresAt);
    }

    /**
     * @notice Top up collateral on an active channel.
     */
    function topUp(bytes32 channelId) external payable whenNotPaused nonReentrant {
        Channel storage ch = channels[channelId];
        require(ch.status == ChannelStatus.OPEN, "Channel not open");
        require(msg.value > 0, "Top-up must be positive");

        ch.totalDeposit += msg.value;
        emit ChannelTopUp(channelId, msg.value, ch.totalDeposit);
    }

    /**
     * @notice Hash an off-chain voucher payload according to EIP-712.
     */
    function hashVoucher(
        bytes32 channelId,
        uint256 sequence,
        uint256 cumulativeAmount,
        bytes32 nonce,
        uint256 expiresAt
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VOUCHER_TYPEHASH,
                    channelId,
                    sequence,
                    cumulativeAmount,
                    nonce,
                    expiresAt
                )
            )
        );
    }

    /**
     * @notice Verify signature on a payment voucher.
     */
    function verifyVoucher(
        bytes32 channelId,
        uint256 sequence,
        uint256 cumulativeAmount,
        bytes32 nonce,
        uint256 expiresAt,
        bytes calldata signature
    ) public view returns (bool) {
        Channel storage ch = channels[channelId];
        if (ch.sender == address(0)) return false;
        bytes32 digest = hashVoucher(channelId, sequence, cumulativeAmount, nonce, expiresAt);
        address recovered = digest.recover(signature);
        return recovered == ch.sender;
    }

    /**
     * @notice Cooperatively close a channel with final voucher signature from sender.
     */
    function closeChannel(
        bytes32 channelId,
        uint256 sequence,
        uint256 cumulativeAmount,
        bytes32 nonce,
        uint256 expiresAt,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        Channel storage ch = channels[channelId];
        require(ch.status == ChannelStatus.OPEN || ch.status == ChannelStatus.DISPUTED, "Channel cannot be closed");
        require(msg.sender == ch.recipient || msg.sender == ch.sender, "Unauthorized closer");
        require(cumulativeAmount <= ch.totalDeposit, "Amount exceeds deposit");
        require(block.timestamp <= expiresAt, "Voucher expired");

        if (cumulativeAmount > 0) {
            require(verifyVoucher(channelId, sequence, cumulativeAmount, nonce, expiresAt, signature), "Invalid voucher signature");
            require(sequence > ch.sequence, "Stale sequence");
            ch.settledAmount = cumulativeAmount;
            ch.sequence = sequence;
        }

        ch.status = ChannelStatus.SETTLED;
        uint256 payout = ch.settledAmount;
        uint256 refund = ch.totalDeposit - payout;

        if (payout > 0) {
            (bool successPayout, ) = ch.recipient.call{value: payout}("");
            require(successPayout, "Recipient payout failed");
        }
        if (refund > 0) {
            (bool successRefund, ) = ch.sender.call{value: refund}("");
            require(successRefund, "Sender refund failed");
        }

        emit ChannelClosed(channelId, payout, refund);
    }

    /**
     * @notice Initiate a unilateral dispute challenge using latest signed voucher.
     */
    function initiateDispute(
        bytes32 channelId,
        uint256 sequence,
        uint256 cumulativeAmount,
        bytes32 nonce,
        uint256 expiresAt,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        Channel storage ch = channels[channelId];
        require(ch.status == ChannelStatus.OPEN || ch.status == ChannelStatus.DISPUTED, "Channel not disputable");
        require(msg.sender == ch.recipient || msg.sender == ch.sender, "Unauthorized disputer");
        require(cumulativeAmount <= ch.totalDeposit, "Amount exceeds deposit");
        require(verifyVoucher(channelId, sequence, cumulativeAmount, nonce, expiresAt, signature), "Invalid voucher signature");
        require(sequence > ch.sequence, "Sequence not strictly greater");

        ch.sequence = sequence;
        ch.settledAmount = cumulativeAmount;
        ch.status = ChannelStatus.DISPUTED;
        uint256 challengeDeadline = block.timestamp + ch.disputePeriod;
        ch.disputeExpiresAt = challengeDeadline;

        emit DisputeInitiated(channelId, sequence, cumulativeAmount, challengeDeadline);
    }

    /**
     * @notice Settle a disputed channel after the challenge window expires.
     */
    function settleDispute(bytes32 channelId) external whenNotPaused nonReentrant {
        Channel storage ch = channels[channelId];
        require(ch.status == ChannelStatus.DISPUTED, "Channel is not in DISPUTED status");
        require(block.timestamp >= ch.disputeExpiresAt, "Dispute challenge period active");

        ch.status = ChannelStatus.SETTLED;
        uint256 payout = ch.settledAmount;
        uint256 refund = ch.totalDeposit - payout;

        if (payout > 0) {
            (bool successPayout, ) = ch.recipient.call{value: payout}("");
            require(successPayout, "Recipient payout failed");
        }
        if (refund > 0) {
            (bool successRefund, ) = ch.sender.call{value: refund}("");
            require(successRefund, "Sender refund failed");
        }

        emit DisputeSettled(channelId, payout, refund);
    }

    function pause() external onlyRole(EMERGENCY_PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
