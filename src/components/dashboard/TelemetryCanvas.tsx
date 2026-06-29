'use client';

import { useRef, useCallback } from 'react';
import { useCanvasResize } from '@/hooks/useCanvasResize';

interface TelemetryCanvasProps {
  id: string;
  width?: number;
  height?: number;
}

export function TelemetryCanvas({ id, width = 200, height = 100 }: TelemetryCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleResize = useCallback(
    (w: number, h: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#0f0';
        ctx.font = '12px monospace';
        ctx.fillText(`Canvas ${id}`, 10, 20);
      }
    },
    [id],
  );

  useCanvasResize(canvasRef, handleResize);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-label={`Telemetry canvas ${id}`}
    />
  );
}
