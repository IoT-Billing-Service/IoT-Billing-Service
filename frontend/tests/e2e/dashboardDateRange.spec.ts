import { test, expect } from '@playwright/test';

// These tests cover the server-side date range handling in
// src/app/dashboard/page.tsx (redirect, validation, error states). That
// logic runs and resolves before DashboardClient's wallet gate is reached,
// so no wallet connection is required to verify the fix. Rendering of the
// actual wallet-gated stats/chart content is intentionally out of scope
// here, see WalletProvider.tsx, which talks to the real Freighter API and
// has no test-mode bypass at present.

test.describe('Dashboard Billing Date Range', () => {
  test('redirects to a default 30-day range when no searchParams are supplied', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/\/dashboard\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);

    const url = new URL(page.url());
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();

    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);
    const rangeDays = Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));

    // Default range is 30 days. This is the key regression check: the page
    // must NOT fall back to an unscoped / all-time query when searchParams
    // are missing.
    expect(rangeDays).toBe(30);
  });

  test('rejects a date range exceeding the maximum allowed span', async ({ page }) => {
    await page.goto('/dashboard?from=2020-01-01&to=2026-06-01');

    const errorMessage = page.getByText(/date range too large/i);
    await expect(errorMessage).toBeVisible();
  });

  test('rejects an invalid date value', async ({ page }) => {
    await page.goto('/dashboard?from=not-a-date&to=2026-06-01');

    const errorMessage = page.getByText(/invalid date range supplied/i);
    await expect(errorMessage).toBeVisible();
  });

  test('rejects a range where from is after to', async ({ page }) => {
    await page.goto('/dashboard?from=2026-06-01&to=2026-01-01');

    const errorMessage = page.getByText(/from.*date must be before.*to.*date/i);
    await expect(errorMessage).toBeVisible();
  });
});