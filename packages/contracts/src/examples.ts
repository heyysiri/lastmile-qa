import { ContextPackSchema, ScenarioSchema } from './index';
// Editable starter configuration only. The engine must never dispatch on these IDs.
export const storeScenario = ScenarioSchema.parse({
  id: 'store-setup', revision: 1, label: 'Set up a seller store',
  goal: 'Set up your seller store with the supplied storeName and save the profile. Confirm it is ready.',
  entryPath: '/onboarding', initialStateId: 'fresh-seller', inputSlots: { storeName: { type: 'text', required: true } },
  contract: { scope: 'ui_and_api', assertions: [
    { id: 'confirmation', kind: 'visible', locator: { by: 'text', value: 'Store saved' } },
    { id: 'store-name', kind: 'state_equals', path: 'store.name', expected: { input: 'storeName' } },
    { id: 'store-status', kind: 'state_equals', path: 'store.status', expected: { literal: 'ready' } },
  ] }, investigation: { factors: ['viewport', 'network'], maxAttempts: 12 },
});
export const inventoryScenario = ScenarioSchema.parse({
  id: 'inventory-update', revision: 1, label: 'Update stock quantity',
  goal: 'Open inventory and update the first product stock quantity to the supplied quantity. Save the change.',
  entryPath: '/inventory', initialStateId: 'active-seller', inputSlots: { quantity: { type: 'number', required: true } },
  contract: { scope: 'ui_and_api', assertions: [
    { id: 'confirmation', kind: 'visible', locator: { by: 'text', value: 'Inventory saved' } },
    { id: 'quantity', kind: 'state_equals', path: 'inventory.0.quantity', expected: { input: 'quantity' } },
  ] }, investigation: { factors: ['viewport', 'network'], maxAttempts: 12 },
});
export const desktopContext = ContextPackSchema.parse({
  id: 'desktop-seller', revision: 1, label: 'Desktop seller', viewport: { width: 1280, height: 800 },
  locale: 'en-IN', preferredLanguage: 'English', familiarity: 'experienced', knownTerms: [],
  interaction: 'pointer', reducedMotion: 'no-preference', network: { mode: 'normal' },
  inputs: { storeName: 'Siri Crafts', quantity: 12 },
});
export const mobileContext = ContextPackSchema.parse({
  ...desktopContext, id: 'mobile-seller', label: 'Small-screen seller', viewport: { width: 390, height: 844 }, familiarity: 'first_time',
});
