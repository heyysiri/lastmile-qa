import { test, expect } from '@playwright/test';

test('run detail reload resolves and empty artifacts are not errors', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Launch run' }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'Browser execution is not configured yet' })).toBeVisible();
  await expect(page.getByText('The runner stored no artifacts for this run.')).toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
});

test('retry after lost launch response uses the same persisted request', async ({ page }) => {
  const keys: string[] = [];
  const ids: string[] = [];
  await page.route('**/api/runner/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().postDataJSON().requestId);
    const response = await route.fetch();
    ids.push((await response.json()).id);
    if (keys.length === 1) return route.abort('failed');
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Launch run' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Launch run' }).click();
  await expect(page).toHaveURL(/\/runs\//);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(ids[1]).toBe(ids[0]);
});

for (const flow of [
  { path: 'onboarding', endpoint: 'store', label: 'Store name', value: 'Siri Crafts' },
  { path: 'inventory', endpoint: 'inventory', label: 'Stock quantity for Cotton scarf', value: '23' },
]) {
  test(`${flow.path} freezes submitted input while saving`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:3001/${flow.path}`);
    await page.getByRole('button', { name: 'Start demo session' }).click();
    const input = page.getByLabel(flow.label, { exact: true });
    await input.fill(flow.value);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/${flow.endpoint}`, async route => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: /^Save/ }).click();
    try { await expect(input).toBeDisabled(); } finally { release(); }
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(flow.value);
  });
}
