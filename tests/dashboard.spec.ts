import { test, expect } from './runner-ui.fixture';
import { randomUUID } from 'node:crypto';

test('advanced task and context authoring persists across reload', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const scenarioId = `task-${suffix}`;
  const scenarioName = `Manual onboarding ${suffix}`;
  const contextId = `seller-${suffix}`;
  const contextName = `Siri mobile ${suffix}`;
  await page.goto('/scenarios');
  await page.getByRole('button', { name: /Set up a seller store/ }).click();
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await page.getByRole('textbox', { name: /^ID/ }).fill(scenarioId);
  await page.getByLabel('Name', { exact: true }).fill(scenarioName);
  await page.getByLabel('Goal').fill('Set up my seller store using the supplied storeName, save it, and confirm it is ready.');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${scenarioName} · revision 1` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(scenarioName) })).toBeVisible();

  await page.goto('/contexts');
  await page.getByRole('button', { name: /Small-screen seller/ }).click();
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await page.getByRole('textbox', { name: /^ID/ }).fill(contextId);
  await page.getByLabel('Name', { exact: true }).fill(contextName);
  await page.getByLabel('storeName', { exact: true }).fill('Siri Crafts');
  await page.getByLabel('Viewport width (px)', { exact: true }).fill('390');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${contextName} · revision 1` })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(contextName) })).toBeVisible();
});

test('context editor rejects an unsupported viewport and fits a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/contexts');
  await page.getByRole('button', { name: /Desktop seller/ }).click();
  await page.getByLabel('Viewport width (px)', { exact: true }).fill('0');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Not valid yet');
  await expect(page.getByRole('button', { name: 'Save as new revision' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
