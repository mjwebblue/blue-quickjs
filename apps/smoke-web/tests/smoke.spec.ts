import { SMOKE_BASELINE } from '@blue-quickjs/test-harness';
import { loadQuickjsWasmMetadata } from '@blue-quickjs/quickjs-wasm';
import { expect, test } from '@playwright/test';

test('browser smoke matches the Node baseline', async ({ page }) => {
  const metadata = await loadQuickjsWasmMetadata();
  const wasmExpected = metadata.variants?.wasm32?.release?.wasm.sha256 ?? null;

  await page.goto('/');
  await page.waitForSelector('[data-runstate="done"]', { timeout: 30000 });

  await expect(page.locator('[data-field="status"] [data-actual]')).toHaveText(
    'ok',
  );
  await expect(page.locator('[data-field][data-match="false"]')).toHaveCount(0);

  await expect(
    page.locator('[data-field="result-hash"] [data-actual]'),
  ).toHaveText(SMOKE_BASELINE.resultHash);
  await expect(
    page.locator('[data-field="manifest-hash"] [data-actual]'),
  ).toHaveText(SMOKE_BASELINE.manifestHash);
  await expect(
    page.locator('[data-field="tape-hash"] [data-actual]'),
  ).toHaveText(SMOKE_BASELINE.tapeHash);
  await expect(
    page.locator('[data-field="gas-used"] [data-actual]'),
  ).toHaveText(SMOKE_BASELINE.gasUsed.toString());
  await expect(
    page.locator('[data-field="gas-remaining"] [data-actual]'),
  ).toHaveText(SMOKE_BASELINE.gasRemaining.toString());
  await expect(page.locator('[data-field="emits"] [data-actual]')).toHaveText(
    SMOKE_BASELINE.emittedCount.toString(),
  );

  if (wasmExpected) {
    await expect(
      page.locator('[data-field="wasm-hash"] [data-actual]'),
    ).toHaveText(wasmExpected);
  }
});
