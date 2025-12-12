import { expect, test } from '@playwright/test';

test('browser wasm gas fixtures align with wasm32 baselines', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('[data-runstate="done"]', { timeout: 30000 });

  const rows = page.locator('[data-test-case]');
  await expect(rows).toHaveCount(6);

  await expect(
    page.locator('[data-test-case][data-status="fail"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-test-case][data-status="ok"]')).toHaveCount(
    6,
  );
});
