import { test, expect } from '@playwright/test';

// Extend Window interface for our mocked properties
declare global {
  interface Window {
    __mockFreighter?: boolean;
    __mockPublicKey?: string;
    __mockFreighterError?: boolean;
    __mockHardwareWallet?: boolean;
  }
}

test.describe('Wallet Disconnection Security', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should terminate session within 2 seconds of wallet disconnection', async ({ page }) => {
    // Mock Freighter wallet connection
    await page.evaluate(() => {
      window.__mockFreighter = true;
      window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
    });

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();

    // Wait for connection to complete
    const connectedIndicator = page.getByText(/connected/i);
    await expect(connectedIndicator).toBeVisible({ timeout: 10000 });

    // Record the time when we disconnect
    const disconnectStartTime = Date.now();

    // Simulate wallet disconnection by triggering watchWalletChanges callback
    await page.evaluate(() => {
      // Simulate wallet lock/disconnect event
      const event = new CustomEvent('freighter-wallet-change', {
        detail: { address: null }
      });
      window.dispatchEvent(event);
    });

    // Wait for the UI to return to the "Connect Wallet" screen
    const connectBtnAfterDisconnect = page.getByRole('button', { name: /connect.*wallet/i });
    await expect(connectBtnAfterDisconnect).toBeVisible({ timeout: 3000 });

    const disconnectEndTime = Date.now();
    const disconnectDuration = disconnectEndTime - disconnectStartTime;

    // Assert that the disconnection happened within 2 seconds
    expect(disconnectDuration).toBeLessThan(2000);

    // Verify that user is logged out (no authenticated content visible)
    const dashboard = page.getByText(/dashboard/i);
    await expect(dashboard).not.toBeVisible();
  });

  test('should prevent API calls after wallet disconnection', async ({ page }) => {
    // Mock Freighter wallet
    await page.evaluate(() => {
      window.__mockFreighter = true;
      window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
    });

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();

    await page.waitForTimeout(2000); // Wait for connection

    // Set up request interception to track API calls
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/')) {
        apiCalls.push(request.url());
      }
    });

    // Simulate wallet disconnection
    await page.evaluate(() => {
      const event = new CustomEvent('freighter-wallet-change', {
        detail: { address: null }
      });
      window.dispatchEvent(event);
    });

    // Wait 500ms for disconnection to process
    await page.waitForTimeout(500);

    // Try to make an API call (should fail or not be attempted)
    const apiCallCountBefore = apiCalls.length;
    
    // Attempt to trigger an action that would normally make an API call
    // This should be blocked since wallet is disconnected
    await page.evaluate(() => {
      fetch('/api/escrow/balance?publicKey=GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7')
        .catch(() => {/* ignore */});
    });

    await page.waitForTimeout(500);

    // Verify no new authenticated API calls were made after disconnection
    // (or if they were made, they should have been rejected)
    const newApiCalls = apiCalls.slice(apiCallCountBefore);
    const authenticatedCalls = newApiCalls.filter(url => 
      url.includes('/api/escrow') || 
      url.includes('/api/wallet') || 
      url.includes('/api/transactions')
    );

    // Either no calls were made, or if they were, the session should be invalid
    expect(authenticatedCalls.length).toBe(0);
  });

  test('should clear query cache on wallet disconnection', async ({ page }) => {
    // Mock wallet connection
    await page.evaluate(() => {
      window.__mockFreighter = true;
      window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
    });

    // Connect and wait for data to load
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(2000);

    // Check if cached data is present (e.g., balance displayed)
    const balanceElement = page.getByText(/balance/i);
    const hasCachedData = await balanceElement.isVisible().catch(() => false);

    // Disconnect wallet
    await page.evaluate(() => {
      const event = new CustomEvent('freighter-wallet-change', {
        detail: { address: null }
      });
      window.dispatchEvent(event);
    });

    // Wait for disconnection
    await page.waitForTimeout(500);

    // Verify cached data is cleared (balance should not be visible)
    if (hasCachedData) {
      await expect(balanceElement).not.toBeVisible();
    }

    // Verify we're back at the connect screen
    const connectBtnAfter = page.getByRole('button', { name: /connect.*wallet/i });
    await expect(connectBtnAfter).toBeVisible();
  });

  test('should handle hardware wallet lock immediately', async ({ page }) => {
    // Mock hardware wallet connection
    await page.evaluate(() => {
      window.__mockFreighter = true;
      window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
      window.__mockHardwareWallet = true;
    });

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(2000);

    const lockStartTime = Date.now();

    // Simulate hardware wallet lock (similar to disconnection)
    await page.evaluate(() => {
      const event = new CustomEvent('freighter-wallet-change', {
        detail: { address: null, reason: 'locked' }
      });
      window.dispatchEvent(event);
    });

    // Wait for return to connect screen
    const connectBtnAfterLock = page.getByRole('button', { name: /connect.*wallet/i });
    await expect(connectBtnAfterLock).toBeVisible({ timeout: 3000 });

    const lockEndTime = Date.now();
    const lockDuration = lockEndTime - lockStartTime;

    // Verify immediate response (under 2 seconds)
    expect(lockDuration).toBeLessThan(2000);
  });

  test('should call /api/auth/logout on wallet disconnection', async ({ page }) => {
    // Track API calls
    const logoutCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/logout')) {
        logoutCalls.push(request.url());
      }
    });

    // Mock wallet
    await page.evaluate(() => {
      window.__mockFreighter = true;
      window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
    });

    // Connect
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(2000);

    // Disconnect
    await page.evaluate(() => {
      const event = new CustomEvent('freighter-wallet-change', {
        detail: { address: null }
      });
      window.dispatchEvent(event);
    });

    // Wait for logout call
    await page.waitForTimeout(1000);

    // Verify logout was called
    expect(logoutCalls.length).toBeGreaterThan(0);
  });
});
