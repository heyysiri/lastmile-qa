import { test, expect } from './runner-ui.fixture';
import { randomUUID } from 'node:crypto';
const seller = 'http://127.0.0.1:3001';
const runnerHeaders = { Authorization: 'Bearer ui-test' };
const sellerHeaders = { Authorization: `Bearer ${process.env.TEST_API_TOKEN || 'local-development-test'}` };

test('seller onboarding persists through the visible UI and stays namespace isolated', async ({ page, request }) => {
  const setup = await request.post(`${seller}/api/test/sessions`, { headers: sellerHeaders, data: { fixtureId: 'fresh-seller' } });
  expect(setup.status()).toBe(201);
  const session = await setup.json();
  await page.context().addCookies([{ name: session.cookie.name, value: session.cookie.value, url: seller }]);
  await page.goto(`${seller}/onboarding`);
  await page.getByLabel(/store name/i).fill('Siri Crafts');
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByText('Store saved', { exact: true })).toBeVisible();
  const readback = await request.get(`${seller}/api/test/state?namespaceId=${session.namespaceId}`, { headers: sellerHeaders });
  expect(readback.ok()).toBe(true);
  expect((await readback.json()).store).toMatchObject({ name: 'Siri Crafts', status: 'ready' });
  await page.reload();
  await expect(page.getByLabel(/store name/i)).toHaveValue('Siri Crafts');
  const other = await request.post(`${seller}/api/test/sessions`, { headers: sellerHeaders, data: { fixtureId: 'fresh-seller' } });
  const otherSession = await other.json();
  const isolated = await request.get(`${seller}/api/test/state?namespaceId=${otherSession.namespaceId}`, { headers: sellerHeaders });
  expect((await isolated.json()).store).toBeNull();
});

test('inventory changes persist through the visible UI', async ({ page, request }) => {
  const setup = await request.post(`${seller}/api/test/sessions`, { headers: sellerHeaders, data: { fixtureId: 'active-seller' } });
  const session = await setup.json();
  await page.context().addCookies([{ name: session.cookie.name, value: session.cookie.value, url: seller }]);
  await page.goto(`${seller}/inventory`);
  await page.getByLabel(/quantity/i).fill('23');
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByText('Inventory saved', { exact: true })).toBeVisible();
  const response = await request.get(`${seller}/api/test/state?namespaceId=${session.namespaceId}`, { headers: sellerHeaders });
  expect((await response.json()).inventory[0].quantity).toBe(23);
});

test('new scenario revisions and original run snapshots survive configuration changes', async ({ request, isolatedRunner }) => {
  const runner = await isolatedRunner.listen({ host: '127.0.0.1', port: 0 });
  const scenariosResponse = await request.get(`${runner}/api/scenarios`, { headers: runnerHeaders });
  const [template] = await scenariosResponse.json();
  const id = `manual-${randomUUID()}`;
  const created = await request.post(`${runner}/api/scenarios`, { headers: runnerHeaders, data: { ...template, id, revision: 1, label: 'My independent task' } });
  expect(created.status()).toBe(201);
  const original = await created.json();
  const contexts = await request.get(`${runner}/api/context-packs`, { headers: runnerHeaders });
  const [context] = await contexts.json();
  const launch = await request.post(`${runner}/api/runs`, { headers: runnerHeaders, data: { requestId: randomUUID(), scenarioId: id, scenarioRevision: original.revision, contextPackId: context.id, contextRevision: context.revision } });
  expect(launch.status()).toBe(202);
  const { id: runId } = await launch.json();
  const edited = await request.put(`${runner}/api/scenarios/${id}`, { headers: runnerHeaders, data: { ...original, label: 'Changed after launch' } });
  expect(edited.ok()).toBe(true);
  const run = await request.get(`${runner}/api/runs/${runId}`, { headers: runnerHeaders });
  expect((await run.json()).scenario.label).toBe('My independent task');
});
