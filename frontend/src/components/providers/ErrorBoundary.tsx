import { Component, ReactNode } from 'react';

type ErrorCategory = 'NETWORK' | 'CONTRACT' | 'UNKNOWN';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorCategory: ErrorCategory;
  crashCount: number;
  crashTimes: number[];
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorCategory: 'UNKNOWN',
      crashCount: 0,
      crashTimes: [],
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  private categorizeError(error: Error): ErrorCategory {
    const message = error.message.toLowerCase();
    if (message.includes('timeout') || message.includes('network') || message.includes('fetch')) {
      return 'NETWORK';
    }
    if (message.includes('contract') || message.includes('soroban')) {
      return 'CONTRACT';
    }
    return 'UNKNOWN';
  }

  componentDidCatch(error: Error): void {
    const now = Date.now();
    // Keep only crashes from last 5 seconds
    const newCrashTimes = this.state.crashTimes.filter((t) => now - t < 5000);
    newCrashTimes.push(now);
    const newCrashCount = newCrashTimes.length;

    this.setState({
      errorCategory: this.categorizeError(error),
      crashCount: newCrashCount,
      crashTimes: newCrashTimes,
    });
  }

  private unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    this.setState({ hasError: true, error });
  };

  componentDidMount(): void {
    window.addEventListener('unhandledrejection', this.unhandledRejectionHandler);
  }

  componentWillUnmount(): void {
    window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
  }

  private resetErrorBoundary = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorCategory: 'UNKNOWN',
    });
  };

  private reloadApplication = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { hasError, error, errorCategory, crashCount } = this.state;
    const { children } = this.props;

    if (!hasError) {
      return children;
    }

    const recoveryHints: Record<ErrorCategory, string> = {
      NETWORK: 'Check your network connection and try again.',
      CONTRACT: 'Please verify the contract details are correct.',
      UNKNOWN: 'An unexpected error occurred. We apologize for the inconvenience.',
    };

    if (crashCount >= 3) {
      return (
        <div className="min-h-screen bg-gray-900 flex items-center justify-center">
          <div className="bg-gray-800 p-8 rounded-xl border border-gray-700 max-w-md">
            <h2 className="text-2xl font-bold text-red-400 mb-4">Critical Error</h2>
            <div className="mb-4 text-gray-300">
              <p className="mb-2">{recoveryHints[errorCategory]}</p>
              <p className="text-sm text-gray-400 mt-2">Error: {error?.message}</p>
            </div>
            <button
              onClick={this.reloadApplication}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="bg-gray-800 p-8 rounded-xl border border-gray-700 max-w-md">
          <h2 className="text-xl font-semibold text-yellow-400 mb-4">Something went wrong</h2>
          <div className="mb-4 text-gray-300">
            <p className="mb-2">{recoveryHints[errorCategory]}</p>
          </div>
          <button
            onClick={this.resetErrorBoundary}
            className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
