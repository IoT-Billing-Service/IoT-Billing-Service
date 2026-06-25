# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboardDateRange.spec.ts >> Dashboard Billing Date Range >> does not render all-time billing data when searchParams are missing
- Location: tests/e2e/dashboardDateRange.spec.ts:35:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/Total Usage \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\)/)
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByText(/Total Usage \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\)/)

```

```yaml
- navigation: Dashboard Fleet Analytics Escrow Settings
- main:
  - paragraph: Connect your wallet to view dashboard data.
- alert
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.describe('Dashboard Billing Date Range', () => {
  4  |   test.beforeEach(async ({ page }) => {
  5  |     // Mirrors the mock pattern used in walletFlows.spec.ts so the dashboard
  6  |     // stats actually render instead of showing the "connect wallet" gate.
  7  |     await page.addInitScript(() => {
  8  |       window.__mockFreighter = true;
  9  |       window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
  10 |     });
  11 |   });
  12 | 
  13 |   test('redirects to a default 30-day range when no searchParams are supplied', async ({
  14 |     page,
  15 |   }) => {
  16 |     await page.goto('/dashboard');
  17 |     await page.waitForURL(/\/dashboard\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  18 | 
  19 |     const url = new URL(page.url());
  20 |     const from = url.searchParams.get('from');
  21 |     const to = url.searchParams.get('to');
  22 |     expect(from).not.toBeNull();
  23 |     expect(to).not.toBeNull();
  24 | 
  25 |     const fromDate = new Date(from as string);
  26 |     const toDate = new Date(to as string);
  27 |     const rangeDays = Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
  28 | 
  29 |     // Default range is 30 days. This is the key regression check: the page
  30 |     // must NOT fall back to an unscoped / all-time query when searchParams
  31 |     // are missing.
  32 |     expect(rangeDays).toBe(30);
  33 |   });
  34 | 
  35 |   test('does not render all-time billing data when searchParams are missing', async ({
  36 |     page,
  37 |   }) => {
  38 |     await page.goto('/dashboard');
  39 |     await page.waitForURL(/\/dashboard\?from=.*&to=.*/);
  40 | 
  41 |     // An all-time dataset (5 years, since contract inception) would produce
  42 |     // a "Total Usage" range label spanning multiple years. The fixed page
  43 |     // should only ever show the 30-day default window here.
  44 |     const usageLabel = page.getByText(/Total Usage \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\)/);
> 45 |     await expect(usageLabel).toBeVisible({ timeout: 10000 });
     |                              ^ Error: expect(locator).toBeVisible() failed
  46 | 
  47 |     const labelText = await usageLabel.textContent();
  48 |     const dates = labelText?.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  49 |     expect(dates).toHaveLength(2);
  50 | 
  51 |     const fromYear = new Date(dates[0] as string).getFullYear();
  52 |     const toYear = new Date(dates[1] as string).getFullYear();
  53 | 
  54 |     // Same-year (or at most one year apart) range confirms this is the
  55 |     // 30-day default, not a multi-year all-time fallback.
  56 |     expect(toYear - fromYear).toBeLessThanOrEqual(1);
  57 |   });
  58 | 
  59 |   test('renders data scoped to an explicit custom date range', async ({ page }) => {
  60 |     await page.goto('/dashboard?from=2026-01-01&to=2026-06-01');
  61 | 
  62 |     const usageLabel = page.getByText('Total Usage (2026-01-01 to 2026-06-01)');
  63 |     await expect(usageLabel).toBeVisible({ timeout: 10000 });
  64 |   });
  65 | 
  66 |   test('rejects a date range exceeding the maximum allowed span', async ({ page }) => {
  67 |     await page.goto('/dashboard?from=2020-01-01&to=2026-06-01');
  68 | 
  69 |     const errorMessage = page.getByText(/date range too large/i);
  70 |     await expect(errorMessage).toBeVisible();
  71 |   });
  72 | 
  73 |   test('rejects an invalid date value', async ({ page }) => {
  74 |     await page.goto('/dashboard?from=not-a-date&to=2026-06-01');
  75 | 
  76 |     const errorMessage = page.getByText(/invalid date range supplied/i);
  77 |     await expect(errorMessage).toBeVisible();
  78 |   });
  79 | 
  80 |   test('rejects a range where from is after to', async ({ page }) => {
  81 |     await page.goto('/dashboard?from=2026-06-01&to=2026-01-01');
  82 | 
  83 |     const errorMessage = page.getByText(/from.*date must be before.*to.*date/i);
  84 |     await expect(errorMessage).toBeVisible();
  85 |   });
  86 | });
```