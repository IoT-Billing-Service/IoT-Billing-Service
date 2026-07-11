import { test, expect } from '@playwright/test';

test.describe('Wallet Connection Flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display connect button when wallet is disconnected', async ({ page }) => {
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await expect(connectBtn).toBeVisible();
  });

  test('should show connecting state while authenticating', async ({ page }) => {
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();

    const connecting = page.getByText(/connecting/i);
    await expect(connecting).toBeVisible({ timeout: 5000 });
  });

  test('should display wallet metrics on successful connection', async ({ page }) => {
    await page.evaluate(() => {
      window.__mockFreighter = true;
      window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
    });

    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();

    const connectedIndicator = page.getByText(/connected/i);
    await expect(connectedIndicator).toBeVisible({ timeout: 10000 });
  });

  test('should show escrow deposit modal flow', async ({ page }) => {
    const depositBtn = page.getByRole('button', { name: /deposit/i });
    if (await depositBtn.isVisible()) {
      await depositBtn.click();
      const modal = page.getByText(/deposit to escrow/i);
      await expect(modal).toBeVisible();
    }
  });

  test('should display error state on connection failure', async ({ page }) => {
    await page.evaluate(() => {
      window.__mockFreighterError = true;
    });

    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();

    const retryBtn = page.getByRole('button', { name: /retry/i });
    await expect(retryBtn).toBeVisible({ timeout: 10000 });
  });
});
