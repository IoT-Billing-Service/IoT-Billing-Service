interface Window {
  __mockFreighter?: boolean;
  __mockFreighterError?: boolean;
  __mockPublicKey?: string;

  // Extended mock API for comprehensive E2E tests
  __ENABLE_FREIGHTER_MOCK__?: boolean;
  __MOCK_PUBLIC_KEY__?: string;
  __MOCK_NETWORK__?: 'testnet' | 'mainnet' | 'futurenet';
  __MOCK_FREIGHTER_ERROR__?: boolean;
  __MOCK_SIGN_ERROR__?: boolean;
  __MOCK_TX_ERROR__?: boolean;

  /** Callback registered by WatchWalletChanges mock */
  __FREIGHTER_WATCH_CALLBACK__?: ((event: { address: string | null }) => void) | null;

  /** Freighter API mock object */
  __FREIGHTER_MOCK__?: Record<string, unknown>;

  /** Stellar SDK mock object */
  __STELLAR_SDK_MOCK__?: Record<string, unknown>;

  /** Mock WatchWalletChanges constructor */
  WatchWalletChanges?: new (interval: number) => {
    watch: (callback: (event: { address: string | null }) => void) => void;
    stop: () => void;
  };
}

interface ImportMeta {
  env: Record<string, string | undefined>;
}
