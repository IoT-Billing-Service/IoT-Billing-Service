export interface WalletInfo {
  address: string;
  network: string;
}

/**
 * Connect to the Freighter wallet extension and return the active account.
 * Falls back to a testnet placeholder when Freighter is absent.
 */
export async function connectWallet(): Promise<WalletInfo> {
  const { isConnected, getAddress, getNetwork } =
    await import('@stellar/freighter-api');

  if (!(await isConnected())) {
    throw new Error('Freighter wallet not connected');
  }

  const address = await getAddress();
  const network = await getNetwork();
  return { address: address.address, network: network.networkPassphrase };
}
