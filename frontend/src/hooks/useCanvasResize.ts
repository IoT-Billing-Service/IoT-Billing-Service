'use client';

import { useEffect, useRef, useCallback } from 'react';

// Shared ResizeObserver instance to avoid creating multiple observers
class SharedResizeObserver {
  private observer: ResizeObserver | null = null;
  private callbacks = new Map<Element, (entry: ResizeObserverEntry) => void>();
  private finalizationRegistry: FinalizationRegistry<Element>;

  constructor() {
    this.finalizationRegistry = new FinalizationRegistry((element: Element) => {
      this.unobserve(element);
    });

    this.observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const callback = this.callbacks.get(entry.target);
        if (callback) {
          callback(entry);
        } else {
          // Clean up if no callback found (element might have been GC'd)
          this.unobserve(entry.target);
        }
      });
    });
  }

  observe(element: Element, callback: (entry: ResizeObserverEntry) => void) {
    if (!this.observer) return;
    this.callbacks.set(element, callback);
    this.finalizationRegistry.register(element, element);
    this.observer.observe(element);
  }

  unobserve(element: Element) {
    if (!this.observer) return;
    this.callbacks.delete(element);
    this.observer.unobserve(element);
  }

  disconnect() {
    if (!this.observer) return;
    this.observer.disconnect();
    this.callbacks.clear();
  }
}

// Singleton instance
let sharedObserver: SharedResizeObserver | null = null;

function getSharedObserver(): SharedResizeObserver {
  if (!sharedObserver) {
    sharedObserver = new SharedResizeObserver();
  }
  return sharedObserver;
}

export function useCanvasResize(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  onResize: (width: number, height: number) => void,
) {
  const onResizeRef = useRef(onResize);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const handleResize = useCallback((entry: ResizeObserverEntry) => {
    const { width, height } = entry.contentRect;
    onResizeRef.current(width, height);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = getSharedObserver();
    observer.observe(canvas, handleResize);

    return () => {
      observer.unobserve(canvas);
    };
  }, [canvasRef, handleResize]);
}
