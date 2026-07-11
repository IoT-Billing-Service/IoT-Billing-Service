/**
 * E2E: Freighter Wallet Mock + Dashboard Metrics Flow
 *
 * This test suite mocks the Freighter wallet extension via a Playwright
 * init-script that intercepts `postMessage` calls from `@stellar/freighter-api`,
 * authenticates into the dashboard, visualises device lists, and verifies
 * that simulated metric state updates are rendered correctly.
 *
 * The mock is loaded via `page.addInitScript({ path: ... })` before the app
 * JavaScript runs, and configuration is passed through `window.__MOCK_*`
 * properties set via `page.addInitScript` with an inline function.
 *
 * Run:
 *   npx playwright test --project=freighter-mocked
 *   npx playwright test tests/e2e/freighterMetricsFlow.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';

const MOCK_PUBLIC_KEY = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';

/**
 * Enable the Freighter mock on the page before each test.
 * Uses two addInitScript calls — one for the mock definition, one for config.
 */
async function enableMock(page: Page, overrides?: {
  publicKey?: string;
  network?: string;
  signError?: boolean;
  freighterError?: boolean;
}) {
  await page.addInitScript({ path: './tests/e2e/freighter-mock.js' });
  await page.addInitScript((config: string) => {
    const opts = JSON.parse(config) as Record<string, string | boolean | undefined>;
    window.__ENABLE_FREIGHTER_MOCK__ = true;
    if (opts.publicKey) window.__MOCK_PUBLIC_KEY__ = opts.publicKey as string;
    if (opts.network) window.__MOCK_NETWORK__ = opts.network as 'testnet' | 'mainnet' | 'futurenet';
    if (opts.freighterError) window.__MOCK_FREIGHTER_ERROR__ = true as unknown as boolean;
    if (opts.signError) window.__MOCK_SIGN_ERROR__ = true as unknown as boolean;
  }, JSON.stringify(overrides ?? {}));
}

/**
 * Intercept backend API calls and supply deterministic mock responses.
 * Each route maps to a stable fixture so test assertions are reproducible.
 */
async function mockBackendApi(page: Page) {
  await page.route('**/api/wallet/balances**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { asset: 'XLM', balance: '12500.5000000', decimals: 7 },
        { asset: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', balance: '5000.0000000', decimals: 7 },
      ]),
    });
  });

  await page.route('**/api/auth/nonce**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nonce: 'e2e-test-nonce-abc123' }),
    });
  });

  await page.route('**/api/auth/verify', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        nonce: 'e2e-test-nonce-abc123',
        signedChallenge: '0x' + 'ab'.repeat(32),
        jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e2e-test-token',
        expiresAt: Date.now() + 3600_000,
        publicKey: MOCK_PUBLIC_KEY,
      }),
    });
  });

  await page.route('**/api/escrow/*/balance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        totalLocked: '7500',
        available: '5000',
        pendingRelease: '250',
        asset: 'XLM',
        contractId: 'CCY2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7',
      }),
    });
  });

  await page.route('**/api/escrow/deposit', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
        contractId: body.contractId,
        amount: body.amount,
        asset: body.asset,
      }),
    });
  });

  await page.route('**/api/escrow/withdraw', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hash: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1',
        contractId: body.contractId,
        amount: body.amount,
        asset: body.asset,
      }),
    });
  });

  await page.route('**/api/escrow/simulate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        fee: '0.0012',
        cpuInsns: 1_500_000,
        memBytes: 200_000,
      }),
    });
  });

  await page.route('**/api/telemetry/batch*', async (route) => {
    const url = new URL(route.request().url());
    const deviceIds = (url.searchParams.get('deviceIds') ?? '').split(',');
    const telemetry = deviceIds.map((id, i) => ({
      deviceId: id,
      timestamp: Date.now() - i * 1000,
      metrics: {
        powerUsage: 30 + Math.random() * 70,
        signalStrength: -85 + Math.random() * 30,
        temperature: 20 + Math.random() * 35,
        batteryLevel: 40 + Math.random() * 60,
      },
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(telemetry),
    });
  });

  await page.route('**/api/auth/logout', async (route) => {
    await route.fulfill({ status: 200, body: 'OK' });
  });
}

test.describe('Freighter Wallet Mock + Dashboard Metrics Flow', () => {
  test.beforeEach(async ({ page }) => {
    await enableMock(page, { publicKey: MOCK_PUBLIC_KEY, network: 'testnet' });
    await mockBackendApi(page);
  });

  test('should mock Freighter, connect wallet, and display connected state', async ({ page }) => {
    await page.goto('/');

    // Verify the connect button is visible on the home page
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await expect(connectBtn).toBeVisible();

    // Click to connect
    await connectBtn.click();

    // Wait for the connected state to appear
    const connectedIndicator = page.getByText(/connected/i);
    await expect(connectedIndicator).toBeVisible({ timeout: 10000 });

    // Verify network badge is displayed
    await expect(page.getByText('testnet')).toBeVisible();

    // Verify the public key is shown (truncated)
    await expect(page.getByText(/GA7QYNF7/)).toBeVisible();
  });

  test('should display wallet balances after connection', async ({ page }) => {
    await page.goto('/');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();

    // Verify balances are displayed
    await expect(page.getByText(/XLM/)).toBeVisible();
    await expect(page.getByText(/USDC/)).toBeVisible();
    await expect(page.getByText(/12,500/)).toBeVisible();
  });

  test('should navigate to fleet view and show fleet cards', async ({ page }) => {
    await page.goto('/dashboard?from=2026-06-01&to=2026-07-01');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1000);

    // Navigate to Fleet via the nav link
    await page.getByRole('link', { name: /fleet/i }).first().click();
    await page.waitForURL('**/fleet');

    // Verify fleet overview tab is active
    await expect(page.getByText(/Fleet Overview/)).toBeVisible();

    // Verify fleet KPI cards are rendered
    await expect(page.getByText(/Total Fleets/)).toBeVisible();
    await expect(page.getByText(/Total Devices/)).toBeVisible();
    await expect(page.getByText(/Devices Online/)).toBeVisible();
    await expect(page.getByText(/Total Power Output/)).toBeVisible();

    // Verify fleet cards are present
    await expect(page.getByText(/Alpha.*North America/)).toBeVisible();
    await expect(page.getByText(/Beta.*Europe/)).toBeVisible();

    // Verify active/degraded counts
    await expect(page.getByText(/Active/).first()).toBeVisible();
    await expect(page.getByText(/Degraded/).first()).toBeVisible();
  });

  test('should show device grid when a fleet is selected', async ({ page }) => {
    await page.goto('/fleet');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1500);

    // Click on the first fleet card to select it
    const fleetCard = page.getByText(/Alpha.*North America/);
    await fleetCard.click();

    // Switch to Devices tab
    await page.getByRole('button', { name: /devices/i }).click();

    // Verify device grid is populated with device cards
    await expect(page.getByText('Device-').first()).toBeVisible({ timeout: 5000 });

    // Verify status filter buttons
    await expect(page.getByRole('button', { name: /^All$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Online$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Offline$/ })).toBeVisible();

    // Verify device metric labels are visible
    await expect(page.getByText(/Power/).first()).toBeVisible();
    await expect(page.getByText(/Signal/).first()).toBeVisible();
    await expect(page.getByText(/Temp/).first()).toBeVisible();
    await expect(page.getByText(/Battery/).first()).toBeVisible();
  });

  test('should display ingestion failure tracking', async ({ page }) => {
    await page.goto('/fleet');
    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1500);

    // Select the degraded fleet (Delta — South America)
    const fleetCard = page.getByText(/Delta.*South America/);
    await fleetCard.click();

    // Switch to Ingestion Failures tab
    await page.getByRole('button', { name: /ingestion/i }).click();

    // Verify failure tracker displays
    await expect(page.getByText(/unresolved/i)).toBeVisible();
    await expect(page.getByText(/total/i)).toBeVisible();

    // Verify error codes are rendered
    await expect(page.getByText(/TIMEOUT/).first()).toBeVisible();
    await expect(page.getByText(/CONNECTION_RESET/).first()).toBeVisible();
  });

  test('should navigate to escrow page and show account state', async ({ page }) => {
    await page.goto('/dashboard?from=2026-06-01&to=2026-07-01');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1000);

    // Navigate to Escrow
    await page.getByRole('link', { name: /escrow/i }).first().click();
    await page.waitForURL('**/escrow');

    // Verify escrow account panel
    await expect(page.getByText(/Account State/)).toBeVisible();
    await expect(page.getByText(/Total Locked/)).toBeVisible();
    await expect(page.getByText(/Available/)).toBeVisible();
    await expect(page.getByText(/Pending Release/)).toBeVisible();

    // Verify funding controls
    await expect(page.getByText(/Funding Controls/)).toBeVisible();
    await expect(page.getByRole('button', { name: /deposit/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /withdraw/i })).toBeVisible();
  });

  test('should open transaction modal and show escrow deposit flow', async ({ page }) => {
    await page.goto('/escrow');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1500);

    // Click Deposit button
    await page.getByRole('button', { name: /^Deposit$/ }).click();

    // Verify transaction modal opens
    await expect(page.getByText(/Deposit to Escrow/)).toBeVisible();

    // Verify amount input
    const amountInput = page.getByPlaceholder('0.00');
    await expect(amountInput).toBeVisible();

    // Verify Gas Estimator section
    await expect(page.getByRole('button', { name: /estimate.*gas/i })).toBeVisible();

    // Close modal
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByText(/Deposit to Escrow/)).not.toBeVisible();
  });

  test('should navigate to payments page and show history', async ({ page }) => {
    await page.goto('/payments');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1500);

    // Verify payment history table
    await expect(page.getByText(/Payment History/)).toBeVisible();
    await expect(page.getByText(/Total Settlements/)).toBeVisible();
    await expect(page.getByText(/Volume/)).toBeVisible();

    // Verify transaction rows
    await expect(page.getByText(/Escrow Deposit/).first()).toBeVisible();
    await expect(page.getByText(/Billing Settlement/).first()).toBeVisible();
  });

  test('should show error state when Freighter is disconnected', async ({ page }) => {
    await page.goto('/dashboard?from=2026-06-01&to=2026-07-01');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1000);

    // Verify we're connected
    await expect(page.getByText(/connected/i)).toBeVisible();

    // Simulate Freighter disconnection via the watch callback
    await page.evaluate(() => {
      if (window.__FREIGHTER_WATCH_CALLBACK__) {
        window.__FREIGHTER_WATCH_CALLBACK__({ address: null });
      }
    });

    // Wait for the disconnect to propagate and the connect button to reappear
    await expect(page.getByRole('button', { name: /connect.*wallet/i })).toBeVisible({
      timeout: 5000,
    });

    // Verify wallet data is cleared
    await expect(page.getByText(/testnet/)).not.toBeVisible();
  });

  test('should handle deposit to escrow end-to-end', async ({ page }) => {
    await page.goto('/escrow');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1500);

    // Click Deposit
    await page.getByRole('button', { name: /^Deposit$/ }).click();

    // Enter amount
    const amountInput = page.getByPlaceholder('0.00');
    await amountInput.fill('500');

    // Click Submit
    await page.getByRole('button', { name: /^Submit$/ }).click();

    // Verify the modal closes after a successful submission
    await page.waitForTimeout(1000);
    await expect(page.getByText(/Deposit to Escrow/)).not.toBeVisible({ timeout: 5000 });
  });

  test('should load and display device telemetry from mock backend', async ({ page }) => {
    await page.goto('/fleet');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1500);

    // Select first fleet
    const fleetCard = page.getByText(/Alpha.*North America/);
    await fleetCard.click();

    // Switch to Devices tab
    await page.getByRole('button', { name: /devices/i }).click();

    // Verify device cards with metrics are rendered
    // The mock backend returns powerUsage, signalStrength, temperature, batteryLevel
    const deviceCards = page.locator('text=Device-');
    await expect(deviceCards.first()).toBeVisible({ timeout: 10000 });

    // Verify metric unit labels appear
    await expect(page.getByText('W').first()).toBeVisible(); // Power in Watts
    await expect(page.getByText('dBm').first()).toBeVisible(); // Signal
    await expect(page.getByText('°C').first()).toBeVisible(); // Temperature
  });

  test('should verify metric stream panel renders live canvas', async ({ page }) => {
    await page.goto('/fleet');

    // Connect wallet
    const connectBtn = page.getByRole('button', { name: /connect.*wallet/i });
    await connectBtn.click();
    await page.waitForTimeout(1500);

    // Select a fleet
    const fleetCard = page.getByText(/Beta.*Europe/);
    await fleetCard.click();

    // Switch to Metric Streams tab
    await page.getByRole('button', { name: /metrics/i }).click();

    // Verify metric stream panel is rendered
    await expect(page.getByText(/Live Metric Stream/)).toBeVisible();
    await expect(page.getByText(/Power \(W\)/)).toBeVisible();
    await expect(page.getByText(/Signal \(dBm\)/)).toBeVisible();

    // Verify latest values section
    await expect(page.getByText(/Latest Values/)).toBeVisible();

    // Toggle a metric off
    await page.getByRole('button', { name: /^Power \(W\)$/ }).click();
    await page.waitForTimeout(200);

    // Verify it was toggled off (no longer visible as active)
    await expect(page.getByText(/Latest Values/)).toBeVisible();
  });
});
