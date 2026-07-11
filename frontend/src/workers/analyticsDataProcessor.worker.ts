interface AnalyticsChunk {
  startTime: number;
  endTime: number;
  data: number[];
  metadata?: Record<string, unknown>;
}

interface ProcessorMessage {
  type: 'processChunk' | 'processAll' | 'computeRange';
  chunks?: AnalyticsChunk[];
  payload?: {
    values: number[];
  };
}

interface ProcessorResponse {
  type: 'chunkProcessed' | 'allProcessed' | 'rangeResult';
  result?: {
    averages: number[];
    totals: number[];
    timestamps: number[];
  };
  range?: {
    min: number;
    max: number;
    count: number;
  };
}

function computeChunkStats(chunks: AnalyticsChunk[]) {
  const sorted = [...chunks].sort((a, b) => a.startTime - b.startTime);
  const averages: number[] = [];
  const totals: number[] = [];
  const timestamps: number[] = [];

  for (const chunk of sorted) {
    if (chunk.data.length === 0) continue;
    let sum = 0;
    for (let i = 0; i < chunk.data.length; i++) {
      const v = chunk.data[i] as number;
      sum += v;
    }
    averages.push(sum / chunk.data.length);
    totals.push(sum);
    timestamps.push(chunk.startTime);
  }

  return { averages, totals, timestamps };
}

function computeRange(values: number[]): { min: number; max: number; count: number } {
  if (values.length === 0) return { min: 0, max: 0, count: 0 };
  let min = values[0] as number;
  let max = values[0] as number;
  for (let i = 1; i < values.length; i++) {
    const v = values[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, count: values.length };
}

self.onmessage = (event: MessageEvent<ProcessorMessage>) => {
  const { type } = event.data;

  if (type === 'computeRange') {
    const values = event.data.payload?.values ?? [];
    const range = computeRange(values);
    const response: ProcessorResponse = { type: 'rangeResult', range };
    self.postMessage(response);
    return;
  }

  const chunks = event.data.chunks ?? [];
  const result = computeChunkStats(chunks);
  const responseType = type === 'processChunk' ? 'chunkProcessed' : 'allProcessed';
  const response: ProcessorResponse = { type: responseType, result };
  self.postMessage(response);
};
