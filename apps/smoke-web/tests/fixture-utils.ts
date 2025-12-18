import type { Page } from '@playwright/test';

export async function readBrowserResults<T>(
  page: Page,
  url: string,
  key: string,
  label: string,
): Promise<T[]> {
  await page.goto(url);
  await page.waitForSelector('[data-runstate="done"]', { timeout: 60000 });

  const results = await page.evaluate(
    (resultKey) =>
      (window as unknown as Record<string, unknown>)[resultKey] ?? null,
    key,
  );

  if (!Array.isArray(results)) {
    throw new Error(`browser ${label} results are missing`);
  }

  return results as T[];
}

export function mapByName<T extends { name: string }>(
  results: T[],
): Map<string, T> {
  return new Map(results.map((result) => [result.name, result]));
}
