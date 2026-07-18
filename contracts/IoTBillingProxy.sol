// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title IoTBillingProxy
 * @dev ERC1967 proxy for IoT Billing Service with immutable initialization
 */
contract IoTBillingProxy is ERC1967Proxy {
    
    /// @dev Emitted when proxy is deployed
    event ProxyDeployed(address indexed implementation, address indexed admin, bytes data);

    constructor(
        address _implementation,
        bytes memory _data
    ) ERC1967Proxy(_implementation, _data) {
        emit ProxyDeployed(_implementation, _msgSender(), _data);
    }

    /**
     * @notice Returns the current implementation address
     */
    function implementation() external view returns (address) {
        return _implementation();
    }
}