const ATOMICS_AVAILABLE =
  typeof Atomics !== 'undefined' && typeof SharedArrayBuffer !== 'undefined';

type AtomicView = Uint32Array | Uint8Array;

type SharedOrArrayBuffer = SharedArrayBuffer | ArrayBuffer;

function createBuffer(byteLength: number): SharedOrArrayBuffer {
  return ATOMICS_AVAILABLE ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
}

function atomicLoad(view: AtomicView, index: number): number {
  const value = ATOMICS_AVAILABLE ? Atomics.load(view, index) : view[index];
  return value === undefined ? 0 : value;
}

function atomicStore(view: AtomicView, index: number, value: number): number {
  if (ATOMICS_AVAILABLE) {
    return Atomics.store(view, index, value);
  }
  view[index] = value;
  return value;
}

function atomicCompareExchange(
  view: AtomicView,
  index: number,
  expectedValue: number,
  replacementValue: number,
): number {
  if (ATOMICS_AVAILABLE) {
    return Atomics.compareExchange(view, index, expectedValue, replacementValue);
  }

  if (view[index] === expectedValue) {
    view[index] = replacementValue;
    return expectedValue;
  }

  return view[index] ?? 0;
}

export interface TelemetryDisplaySnapshot {
  buffer: Float64Array;
  start: number;
  count: number;
  stable: boolean;
}

const WRITE_PTR = 0;
const DISPLAY_PTR = 1;
const FREE_PTR = 2;

export class TelemetryBuffer {
  private readonly buffers: Float64Array[];
  private readonly control: Uint8Array;
  private readonly counts: Uint32Array;
  private readonly starts: Uint32Array;
  private readonly capacity: number;

  constructor(capacity = 10_000) {
    this.capacity = capacity;
    this.buffers = [
      new Float64Array(createBuffer(capacity * Float64Array.BYTES_PER_ELEMENT)),
      new Float64Array(createBuffer(capacity * Float64Array.BYTES_PER_ELEMENT)),
      new Float64Array(createBuffer(capacity * Float64Array.BYTES_PER_ELEMENT)),
    ];
    this.control = new Uint8Array(createBuffer(3));
    this.counts = new Uint32Array(createBuffer(3 * Uint32Array.BYTES_PER_ELEMENT));
    this.starts = new Uint32Array(createBuffer(3 * Uint32Array.BYTES_PER_ELEMENT));

    atomicStore(this.control, WRITE_PTR, 0);
    atomicStore(this.control, DISPLAY_PTR, 1);
    atomicStore(this.control, FREE_PTR, 2);
  }

  appendBatch(values: number[]): boolean {
    if (values.length === 0) return true;

    const writeId = atomicLoad(this.control, WRITE_PTR);
    const currentCount = atomicLoad(this.counts, writeId);
    const currentStart = atomicLoad(this.starts, writeId);
    const buffer = this.buffers[writeId]!;

    let newCount = currentCount + values.length;
    let newStart = currentStart;
    if (newCount > this.capacity) {
      newStart = (currentStart + (newCount - this.capacity)) % this.capacity;
      newCount = this.capacity;
    }

    let writePos = (currentStart + currentCount) % this.capacity;
    for (let i = 0; i < values.length; i++) {
      buffer[writePos] = values[i] ?? 0;
      writePos = (writePos + 1) % this.capacity;
    }

    const committed = atomicCompareExchange(this.counts, writeId, currentCount, newCount);
    if (committed !== currentCount) {
      return false;
    }

    if (newStart !== currentStart) {
      atomicStore(this.starts, writeId, newStart);
    }

    return true;
  }

  swapDisplayBuffer(): void {
    const writeId = atomicLoad(this.control, WRITE_PTR);
    const displayId = atomicLoad(this.control, DISPLAY_PTR);
    const freeId = atomicLoad(this.control, FREE_PTR);

    atomicStore(this.control, DISPLAY_PTR, writeId);
    atomicStore(this.control, WRITE_PTR, freeId);
    atomicStore(this.control, FREE_PTR, displayId);

    atomicStore(this.counts, freeId, 0);
    atomicStore(this.starts, freeId, 0);
  }

  readDisplaySnapshot(): TelemetryDisplaySnapshot {
    const displayId = atomicLoad(this.control, DISPLAY_PTR);
    const countBefore = atomicLoad(this.counts, displayId);
    const start = atomicLoad(this.starts, displayId);
    const buffer = this.buffers[displayId]!;
    const countAfter = atomicLoad(this.counts, displayId);

    return {
      buffer,
      start,
      count: countBefore,
      stable: countBefore === countAfter,
    };
  }
}
