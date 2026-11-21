import { test, expect } from './runner-ui.fixture';

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
