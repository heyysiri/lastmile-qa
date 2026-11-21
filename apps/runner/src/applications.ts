import { desktopContext, inventoryScenario, storeScenario } from '@lastmile/contracts/examples';
import type { StudyApplication, StudyUser } from '@lastmile/contracts/studies';
import { z } from 'zod';

const seller = {
  id: 'seller-demo',
  name: 'Seller Hub demo',
  domain: 'Marketplace sellers',
  description: 'Connected seller demo for store setup and inventory quantity updates only. This checkpoint uses isolated demo fixtures and verifies the visible confirmation and saved state. Arbitrary app connections, file uploads, and other seller workflows are outside its coverage.',
};

const workflows = [
  {
    scenario: storeScenario,
    preserveStatePaths: ['inventory.0.quantity'],
    description: 'Start with a fresh seller. Save a nonempty storeName of up to 80 characters without surrounding whitespace and confirm the store is ready.',
    inputs: z.object({ storeName: z.string().min(1).max(80).refine(name => name === name.trim()) }).strict(),
  },
  {
    scenario: inventoryScenario,
    description: 'Start with an active seller with one product. Save a whole-number stock quantity from 0 through 1,000,000 for that product and confirm the save.',
    inputs: z.object({ quantity: z.number().int().min(0).max(1_000_000) }).strict(),
  },
];

export function createApplications(origin: string): StudyApplication[] {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The configured application needs an HTTP or HTTPS origin.');
  }
  return [{
    ...seller,
    origin: url.origin,
    workflows: workflows.map(({ scenario, description, preserveStatePaths }) => ({
      id: scenario.id,
      description,
      preserveStatePaths,
      scenario: structuredClone(scenario),
      defaultInputs: Object.fromEntries(Object.keys(scenario.inputSlots).map(slot => [slot, desktopContext.inputs[slot]])),
    })),
  }];
}

/** Apply value limits that the shared workflow contract cannot represent. */
export function validateApplicationInputValues(application: StudyApplication, user: StudyUser): void {
  if (application.id !== seller.id) return;
  const workflow = workflows.find(({ scenario }) => scenario.id === user.workflowId);
  if (workflow && !workflow.inputs.safeParse(user.context.inputs).success) {
    throw new Error('The model returned invalid workflow inputs. Generate the study again.');
  }
}
