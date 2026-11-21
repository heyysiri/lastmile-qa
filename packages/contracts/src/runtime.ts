import { z } from 'zod';
import { LocatorSchema, type RunRecord } from './index';

export const ValueRefSchema = z.union([
  z.object({ input: z.string().min(1) }).strict(),
  z.object({ literal: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
]);
export const BrowserActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('navigate'), path: z.string() }).strict(),
  z.object({ tool: z.literal('click'), locator: LocatorSchema }).strict(),
  z.object({ tool: z.literal('fill'), locator: LocatorSchema, value: ValueRefSchema }).strict(),
  z.object({ tool: z.literal('select'), locator: LocatorSchema, value: ValueRefSchema }).strict(),
  z.object({ tool: z.literal('pressKey'), key: z.string().min(1).max(40) }).strict(),
  z.object({ tool: z.literal('scroll'), direction: z.enum(['up', 'down']), pixels: z.number().int().min(1).max(1000) }).strict(),
  z.object({ tool: z.literal('uploadFixture'), locator: LocatorSchema, input: z.string() }).strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type RecordedAction = { action: BrowserAction; url: string; observation: string };
export type ReplayPlan = { version: 1; hash: string; sourceRunIds: string[]; scenarioHash: string; buildId: string; actions: RecordedAction[] };
export type ExecutionEvidence = {
  buildId: string; scenarioHash: string; policyVersion: string; model: string;
  actions: RecordedAction[]; modelCalls: number; finishedByAgent: boolean;
  replayHash?: string; replayCompatible?: boolean;
};
export type EvidenceRun = RunRecord & { evidence?: ExecutionEvidence };
export type InvestigationFactor = 'viewport' | 'locale' | 'network' | 'interaction' | 'reducedMotion' | 'inputs';
export type InvestigationTrial = { role: 'target' | 'control' | 'candidate'; factor?: InvestigationFactor; repeat: number; run: EvidenceRun };
export type DifferentialResult = {
  id: string; targetRunId: string; controlRunId: string; replayHash: string;
  status: 'running' | 'completed'; conclusion: 'reproducible_failure' | 'inconclusive';
  isolationStatus: 'isolated' | 'unresolved' | 'not_attempted'; likelyTriggers: InvestigationFactor[];
  attemptsUsed: number; maxAttempts: number; trials: InvestigationTrial[];
  untestedFactors: InvestigationFactor[]; message: string; createdAt: string;
};
