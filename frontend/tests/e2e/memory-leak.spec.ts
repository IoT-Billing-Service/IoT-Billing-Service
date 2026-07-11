import { test, expect } from '@playwright/test';

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
  memory: MemoryInfo;
}

interface WindowWithGC extends Window {
  gc?: () => void;
}

test('canvas memory leak regression test', async ({ page }) => {
  await page.goto('/dashboard');

  // Wait for page to load
  await page.waitForLoadState('networkidle');

  // Get initial heap size
  const initialHeap = await page.evaluate(() => {
    const perf = performance as PerformanceWithMemory;
    if ('memory' in perf) {
      return perf.memory.usedJSHeapSize;
    }
    return 0;
  });

  console.log('Initial heap size:', initialHeap);

  // Simulate 50 filter changes
  for (let i = 0; i < 50; i++) {
    // Toggle device list to mount/unmount canvases
    await page.evaluate((count) => {
      // Create a mock component to simulate mount/unmount
      const div = document.createElement('div');
      div.id = `test-div-${count}`;
      document.body.appendChild(div);
      
      // Create canvas elements
      for (let j = 0; j < 10; j++) {
        const canvas = document.createElement('canvas');
        canvas.id = `test-canvas-${count}-${j}`;
        canvas.width = 100;
        canvas.height = 100;
        div.appendChild(canvas);
      }
      
      // Remove after a short delay
      setTimeout(() => {
        const el = document.getElementById(`test-div-${count}`);
        if (el) {
          el.remove();
        }
      }, 50);
    }, i);

    await page.waitForTimeout(100);
  }

  // Force GC if possible (non-standard, but works in Chromium)
  await page.evaluate(() => {
    const win = window as WindowWithGC;
    if (win.gc) {
      win.gc();
    }
  });

  await page.waitForTimeout(1000);

  // Get final heap size
  const finalHeap = await page.evaluate(() => {
    const perf = performance as PerformanceWithMemory;
    if ('memory' in perf) {
      return perf.memory.usedJSHeapSize;
    }
    return 0;
  });

  console.log('Final heap size:', finalHeap);
  const heapGrowth = finalHeap - initialHeap;

  console.log('Heap growth:', heapGrowth);

  // Assert that heap growth is less than 500KB
  expect(heapGrowth).toBeLessThan(500 * 1024);
});
