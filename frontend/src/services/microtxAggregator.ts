import BigNumber from 'bignumber.js';

// Configure BigNumber for high-precision arithmetic
BigNumber.config({
  DECIMAL_PLACES: 20,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});

interface AggregationState {
  rawSum: BigNumber;
  roundedSum: BigNumber;
  cumulativeRoundError: BigNumber;
  count: number;
}

function precisionAssert(
  condition: boolean,
  message: string,
  error: BigNumber.Value,
  threshold: BigNumber.Value = 1e-12,
): void {
  if (process.env.NODE_ENV !== 'production') {
    if (!condition) {
      const err = new BigNumber(error);
      const thr = new BigNumber(threshold);
      console.warn(
        `[Precision Assertion Failed] ${message} - Cumulative error: ${err.toString()}, Threshold: ${thr.toString()}`,
      );
    }
  }
}

export class MicrotxAggregator {
  private state: AggregationState;

  constructor(initialError: BigNumber.Value = 0) {
    this.state = {
      rawSum: new BigNumber(0),
      roundedSum: new BigNumber(0),
      cumulativeRoundError: new BigNumber(initialError),
      count: 0,
    };
  }

  add(microTxValue: BigNumber.Value): void {
    const value = new BigNumber(microTxValue);
    this.state.rawSum = this.state.rawSum.plus(value);
    this.state.count += 1;
  }

  addBatch(microTxValues: BigNumber.Value[]): void {
    microTxValues.forEach((val) => this.add(val));
  }

  getDisplayedTotal(): string {
    // Apply cumulative error correction
    const correctedSum = this.state.rawSum.plus(this.state.cumulativeRoundError);
    // Format for display (7 decimals, Stellar native precision)
    this.state.roundedSum = correctedSum.decimalPlaces(7, BigNumber.ROUND_HALF_EVEN);
    // Update error for next window
    this.state.cumulativeRoundError = this.state.cumulativeRoundError.plus(
      this.state.rawSum.minus(this.state.roundedSum),
    );
    // Debug assertion
    precisionAssert(
      this.state.cumulativeRoundError.abs().isLessThan(new BigNumber('1e-12')),
      'Cumulative rounding error exceeded safe threshold',
      this.state.cumulativeRoundError,
    );
    return this.state.roundedSum.toFixed(7);
  }

  reset(): void {
    this.state = {
      rawSum: new BigNumber(0),
      roundedSum: new BigNumber(0),
      cumulativeRoundError: new BigNumber(0),
      count: 0,
    };
  }

  getState(): AggregationState {
    return { ...this.state };
  }
}
