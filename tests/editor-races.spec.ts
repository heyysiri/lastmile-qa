import { test, expect } from '@playwright/test';
import { storeScenario, inventoryScenario, desktopContext } from '../packages/contracts/src/examples';

test('pending save freezes editing and selection, then keeps acknowledgement', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/runner/scenarios', route => route.fulfill({ json: [storeScenario] }));
  await page.route(`**/api/runner/scenarios/${storeScenario.id}`, async route => {
    await held;
    await route.fulfill({ json: { ...route.request().postDataJSON(), revision: 2 } });
  });
  await page.goto('/scenarios');
  await page.getByLabel('Name', { exact: true }).fill('Saved store task');
  await page.getByRole('button', { name: 'Save as new revision' }).click();
  try {
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Duplicate' })).toBeDisabled();
    await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.getByRole('status')).toContainText('Saved "Saved store task" as revision 2.');
});

test('stale revision refreshes from server while preserving unsaved text', async ({ page }) => {
  let latest = storeScenario;
  await page.route('**/api/runner/scenarios', route => route.fulfill({ json: [latest, inventoryScenario] }));
  await page.route(`**/api/runner/scenarios/${storeScenario.id}`, route => {
    const body = route.request().postDataJSON();
    return body.revision === 1
      ? route.fulfill({ status: 409, json: { code: 'stale_revision', message: 'Revision changed' } })
      : route.fulfill({ json: { ...body, revision: 3 } });
  });
  await page.goto('/scenarios');
  await page.getByLabel('Name', { exact: true }).fill('My unsaved change');
  latest = { ...storeScenario, label: 'Another edit', revision: 2 };
  await page.getByRole('button', { name: 'Save as new revision' }).click();
  await page.getByRole('button', { name: 'Load latest revision' }).click();
  await expect(page.getByLabel('Unsaved draft')).toContainText('My unsaved change');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Another edit');
  await page.getByRole('button', { name: /Update stock quantity/ }).click();
  await expect(page.getByLabel('Unsaved draft')).toHaveCount(0);
  await page.getByRole('button', { name: /Another edit/ }).click();
  await expect(page.getByLabel('Unsaved draft')).toContainText('My unsaved change');
  await page.getByLabel('Name', { exact: true }).fill('My reconciled change');
  await page.getByRole('button', { name: 'Save as new revision' }).click();
  await expect(page.getByRole('status')).toContainText('revision 3');
  await expect(page.getByLabel('Unsaved draft')).toHaveCount(0);
});

test('known terms accepts comma-separated typing and saves separate terms', async ({ page }) => {
  await page.route('**/api/runner/context-packs', route => route.fulfill({ json: [desktopContext] }));
  let saved: unknown;
  await page.route(`**/api/runner/context-packs/${desktopContext.id}`, route => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { ...(saved as object), revision: 2 } });
  });
  await page.goto('/contexts');
  const terms = page.getByLabel('Known terms');
  await terms.fill('');
  await terms.pressSequentially('SKU,inventory');
  await expect(terms).toHaveValue('SKU,inventory');
  await page.getByRole('button', { name: 'Save as new revision' }).click();
  await expect(page.getByRole('status')).toContainText('revision 2');
  expect(saved).toMatchObject({ knownTerms: ['SKU', 'inventory'] });
});
