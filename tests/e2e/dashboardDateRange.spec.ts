import { test, expect } from '@playwright/test';

test.describe('Dashboard Billing Date Range', () => {
  test.beforeEach(async ({ page }) => {
    // Mirrors the mock pattern used in walletFlows.spec.ts so the dashboard
    // stats actually render instead of showing the "connect wallet" gate.
    await page.addInitScript(() => {
      window.__mockFreighter = true;
      window.__mockPublicKey = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
    });
  });

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

  test('does not render all-time billing data when searchParams are missing', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/\/dashboard\?from=.*&to=.*/);

    // An all-time dataset (5 years, since contract inception) would produce
    // a "Total Usage" range label spanning multiple years. The fixed page
    // should only ever show the 30-day default window here.
    const usageLabel = page.getByText(/Total Usage \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\)/);
    await expect(usageLabel).toBeVisible({ timeout: 10000 });

    const labelText = await usageLabel.textContent();
    const dates = labelText?.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    expect(dates).toHaveLength(2);

    const fromYear = new Date(dates[0] as string).getFullYear();
    const toYear = new Date(dates[1] as string).getFullYear();

    // Same-year (or at most one year apart) range confirms this is the
    // 30-day default, not a multi-year all-time fallback.
    expect(toYear - fromYear).toBeLessThanOrEqual(1);
  });

  test('renders data scoped to an explicit custom date range', async ({ page }) => {
    await page.goto('/dashboard?from=2026-01-01&to=2026-06-01');

    const usageLabel = page.getByText('Total Usage (2026-01-01 to 2026-06-01)');
    await expect(usageLabel).toBeVisible({ timeout: 10000 });
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