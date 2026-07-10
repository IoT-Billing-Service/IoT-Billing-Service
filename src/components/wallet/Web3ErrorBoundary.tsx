'use client';

import { Component, type ReactNode } from 'react';

type Web3ErrorCode =
  | 'WALLET_DISCONNECTED'
  | 'WRONG_NETWORK'
  | 'RPC_ENDPOINT_ERROR'
  | 'SOROBAN_NODE_DROPOUT'
  | 'CONTRACT_ERROR'
  | 'TRANSACTION_FAILED'
  | 'UNKNOWN';

interface Web3Error {
  code: Web3ErrorCode;
  message: string;
  recoverable: boolean;
  suggestion: string;
}

interface Web3ErrorBoundaryState {
  currentError: Web3Error | null;
  crashCount: number;
  crashTimes: number[];
}

interface Web3ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional callback fired when the boundary catches an error.
   * Useful for telemetry / logging.
   */
  onError?: (error: Web3Error) => void;
}

/**
 * Classifies Web3 / Soroban runtime errors into user-facing categories
 * with actionable recovery suggestions.
 */
function classifyWeb3Error(error: Error): Web3Error {
  const msg = error.message.toLowerCase();

  // Wallet disconnection / lock
  if (
    msg.includes('wallet') ||
    msg.includes('freighter') ||
    msg.includes('disconnect') ||
    msg.includes('locked')
  ) {
    return {
      code: 'WALLET_DISCONNECTED',
      message: error.message,
      recoverable: true,
      suggestion:
        'Your wallet has disconnected or locked. Please reconnect Freighter and refresh the page.',
    };
  }

  // Wrong network / RPC endpoint
  if (
    msg.includes('network') ||
    msg.includes('rpc') ||
    msg.includes('endpoint') ||
    msg.includes('wrong network') ||
    msg.includes('chain')
  ) {
    return {
      code: 'WRONG_NETWORK',
      message: error.message,
      recoverable: true,
      suggestion:
        'The Stellar network or RPC endpoint is misconfigured. Check that Freighter is set to the correct network (Testnet / Mainnet).',
    };
  }

  // Soroban RPC node dropout
  if (
    msg.includes('soroban') ||
    msg.includes('quickstart') ||
    msg.includes('timeout') ||
    msg.includes('connection refused') ||
    msg.includes('fetch') ||
    msg.includes('econnrefused')
  ) {
    return {
      code: 'SOROBAN_NODE_DROPOUT',
      message: error.message,
      recoverable: true,
      suggestion:
        'The Soroban RPC node is unreachable. If running a local quickstart node, ensure it is still running on the expected port (e.g. localhost:8000).',
    };
  }

  // Contract execution error
  if (msg.includes('contract') || msg.includes('soroban host') || msg.includes('simulation')) {
    return {
      code: 'CONTRACT_ERROR',
      message: error.message,
      recoverable: false,
      suggestion:
        'The smart contract returned an error. Verify contract parameters and state, then try again.',
    };
  }

  // Transaction failure
  if (msg.includes('transaction') || msg.includes('tx') || msg.includes('submission')) {
    return {
      code: 'TRANSACTION_FAILED',
      message: error.message,
      recoverable: true,
      suggestion:
        'The transaction could not be submitted. Check your account balance, sequence number, and network fees.',
    };
  }

  return {
    code: 'UNKNOWN',
    message: error.message,
    recoverable: false,
    suggestion:
      'An unexpected Web3 error occurred. Please check your browser console for details or contact support.',
  };
}

const WEB3_ERROR_ICONS: Record<Web3ErrorCode, string> = {
  WALLET_DISCONNECTED: '🔌',
  WRONG_NETWORK: '🌐',
  RPC_ENDPOINT_ERROR: '📡',
  SOROBAN_NODE_DROPOUT: '⚠️',
  CONTRACT_ERROR: '📄',
  TRANSACTION_FAILED: '💸',
  UNKNOWN: '❓',
};

const WEB3_ERROR_TITLES: Record<Web3ErrorCode, string> = {
  WALLET_DISCONNECTED: 'Wallet Disconnected',
  WRONG_NETWORK: 'Network Mismatch',
  RPC_ENDPOINT_ERROR: 'RPC Endpoint Error',
  SOROBAN_NODE_DROPOUT: 'Soroban Node Unreachable',
  CONTRACT_ERROR: 'Contract Execution Error',
  TRANSACTION_FAILED: 'Transaction Failed',
  UNKNOWN: 'Unknown Web3 Error',
};

export class Web3ErrorBoundary extends Component<Web3ErrorBoundaryProps, Web3ErrorBoundaryState> {
  constructor(props: Web3ErrorBoundaryProps) {
    super(props);
    this.state = {
      currentError: null,
      crashCount: 0,
      crashTimes: [],
    };
  }

  static getDerivedStateFromError(error: Error): Partial<Web3ErrorBoundaryState> {
    return { currentError: classifyWeb3Error(error) };
  }

  componentDidCatch(error: Error): void {
    const now = Date.now();
    const newCrashTimes = this.state.crashTimes.filter((t) => now - t < 8000);
    newCrashTimes.push(now);
    const newCrashCount = newCrashTimes.length;

    const classified = classifyWeb3Error(error);
    this.setState({
      crashCount: newCrashCount,
      crashTimes: newCrashTimes,
      currentError: classified,
    });

    this.props.onError?.(classified);
  }

  private reset = () => {
    this.setState({
      currentError: null,
    });
  };

  private reload = () => {
    window.location.reload();
  };

  private switchNetwork = () => {
    // In a real integration, this would prompt the user via Freighter to
    // switch networks. For now we reload so the app re-initialises with
    // whatever network Freighter currently reports.
    window.location.reload();
  };

  render() {
    const { currentError, crashCount } = this.state;
    const { children } = this.props;

    if (!currentError) return children;

    // Catastrophic crash loop — offer reload
    if (crashCount >= 3) {
      return (
        <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
          <div className="w-full max-w-md rounded-xl border border-red-800 bg-gray-900 p-8 text-center">
            <span className="text-4xl">🚨</span>
            <h2 className="mt-4 text-xl font-bold text-red-400">Repeated Web3 Errors</h2>
            <p className="mt-2 text-sm text-gray-400">
              The application has encountered multiple consecutive failures. This may indicate a
              persistent network or configuration issue.
            </p>
            <button
              onClick={this.reload}
              className="mt-6 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-500 transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    const icon = WEB3_ERROR_ICONS[currentError.code];
    const title = WEB3_ERROR_TITLES[currentError.code];

    return (
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl border border-yellow-800 bg-gray-900 p-6">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{icon}</span>
            <div>
              <h3 className="text-base font-semibold text-yellow-300">{title}</h3>
              <span className="inline-block mt-0.5 rounded bg-yellow-900/30 px-2 py-0.5 text-[10px] font-mono text-yellow-500">
                {currentError.code}
              </span>
            </div>
          </div>

          <p className="mt-4 text-sm text-gray-300">{currentError.suggestion}</p>

          {process.env.NODE_ENV === 'development' && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">
                Error details
              </summary>
              <pre className="mt-2 overflow-auto rounded bg-gray-950 p-3 text-xs text-red-400">
                {currentError.message}
              </pre>
            </details>
          )}

          <div className="mt-5 flex gap-3">
            {currentError.recoverable && (
              <button
                onClick={this.reset}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-600 transition-colors"
              >
                Dismiss
              </button>
            )}
            {currentError.code === 'WRONG_NETWORK' && (
              <button
                onClick={this.switchNetwork}
                className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
              >
                Switch Network
              </button>
            )}
            {currentError.code === 'SOROBAN_NODE_DROPOUT' && (
              <button
                onClick={this.reload}
                className="flex-1 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 transition-colors"
              >
                Retry Connection
              </button>
            )}
            {!currentError.recoverable && (
              <button
                onClick={this.reload}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-600 transition-colors"
              >
                Reload
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
