export interface PositionCalculationMessage {
  cols: number;
  rows: number;
  cellSize: number;
  fleetsLength: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface PositionResult {
  index: number;
  col: number;
  row: number;
  x: number;
  y: number;
}

self.onmessage = (event: MessageEvent<PositionCalculationMessage>) => {
  const { cols, rows, cellSize, fleetsLength, xMin, yMin, xMax, yMax } = event.data;

  // Perform bounds check and grid arithmetic
  const colStart = Math.max(0, Math.floor(xMin / cellSize));
  const colEnd = Math.min(cols - 1, Math.floor(xMax / cellSize));
  const rowStart = Math.max(0, Math.floor(yMin / cellSize));
  const rowEnd = Math.min(rows - 1, Math.floor(yMax / cellSize));

  const visibleCells: PositionResult[] = [];

  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      const index = r * cols + c;
      if (index >= fleetsLength) continue;

      visibleCells.push({
        index,
        col: c,
        row: r,
        x: c * cellSize,
        y: r * cellSize,
      });
    }
  }

  self.postMessage(visibleCells);
};
