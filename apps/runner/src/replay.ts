import { createHash } from 'node:crypto';
import type { InputValue } from '@lastmile/contracts';
import { BrowserActionSchema, type BrowserAction, type EvidenceRun, type RecordedAction, type ReplayPlan } from '@lastmile/contracts/runtime';
import { safeMessage } from './verifier';

export const MAX_REPLAY_ACTIONS = 100;
const MAX_TEXT = 200;
const BLOCKED_PREFIX = '/api/test';
const DUMMY_ORIGIN = 'http://placeholder.invalid';
export type ReplayResult = { compatible: boolean; message?: string };
export type ActionExecutor = (action: BrowserAction) => Promise<string>;

class ReplayError extends Error {}
const fail = (message: string): never => { throw new ReplayError(message); };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, canonical(item)]));
  }
  if (value === undefined || typeof value === 'function') return fail('Replay data is not canonical JSON');
  return value;
}

/** SHA-256 over canonical (key-sorted) JSON of everything except the hash itself. */
export function hashReplayPlan(plan: Omit<ReplayPlan, 'hash'> | ReplayPlan): string {
  const { version, sourceRunIds, scenarioHash, buildId, actions } = plan;
  return createHash('sha256').update(JSON.stringify(canonical({ version, sourceRunIds, scenarioHash, buildId, actions }))).digest('hex');
}

/** Relative app paths only, never the protected test API (including encoded or dot-segment spellings). */
export function isAllowedNavigatePath(path: unknown): boolean {
  if (typeof path !== 'string' || path.length > 2000 || !/^\/(?!\/)[^\\]*$/.test(path) || /[\u0000-\u001f]/.test(path)) return false;
  let url: URL;
  try { url = new URL(path, DUMMY_ORIGIN); } catch { return false; }
  if (url.origin !== DUMMY_ORIGIN) return false;
  let decoded = url.pathname;
  for (let round = 0; round < 4; round += 1) {
    if (decoded.includes('\\')) return false;
    if (decoded.toLowerCase().startsWith(BLOCKED_PREFIX)) return false;
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return false; }
    if (next === decoded) return true;
    decoded = new URL(next.startsWith('/') ? next : `/${next}`, DUMMY_ORIGIN).pathname;
  }
  return false;
}

function checkInputRef(name: string, inputs: Record<string, InputValue>, kind: 'scalar' | 'fixture', position: number): void {
  if (!Object.hasOwn(inputs, name)) fail(`Action ${position}: unknown input reference`);
  const value = inputs[name];
  const isFixture = typeof value === 'object' && value !== null && 'fixtureId' in value;
  if (kind === 'fixture' && !isFixture) fail(`Action ${position}: upload input is not a fixture`);
  if (kind === 'scalar' && isFixture) fail(`Action ${position}: input reference is a fixture, not a value`);
}

/** Strict shape, navigation and input-reference validation; returns detached copies. */
function checkActions(actions: unknown, inputs: Record<string, InputValue>): RecordedAction[] {
  if (!Array.isArray(actions) || actions.length === 0) return fail('Replay has no recorded actions');
  if (actions.length > MAX_REPLAY_ACTIONS) return fail('Too many actions in replay');
  return actions.map((entry: unknown, index) => {
    const position = index + 1;
    const recorded = entry as Partial<RecordedAction> | null;
    if (!recorded || typeof recorded !== 'object' || typeof recorded.url !== 'string' || typeof recorded.observation !== 'string') fail(`Action ${position} is malformed`);
    const parsed = BrowserActionSchema.safeParse(recorded!.action);
    if (!parsed.success) return fail(`Action ${position} is not a valid browser action`);
    const action = parsed.data;
    if (action.tool === 'navigate' && !isAllowedNavigatePath(action.path)) fail(`Action ${position}: navigation path is not allowed`);
    if ((action.tool === 'fill' || action.tool === 'select') && 'input' in action.value) checkInputRef(action.value.input, inputs, 'scalar', position);
    if (action.tool === 'uploadFixture') checkInputRef(action.input, inputs, 'fixture', position);
    if(recorded!.routeVersion!==undefined&&recorded!.routeVersion!==2)fail(`Action ${position}: unsupported route evidence`);
    return { action, url: recorded!.url!, observation: recorded!.observation!, ...(typeof recorded!.urlBefore==='string'?{urlBefore:recorded!.urlBefore}:{}),...(typeof recorded!.focusBefore==='string'?{focusBefore:recorded!.focusBefore}:{}),...(recorded!.routeVersion===2?{routeVersion:2 as const}:{}) };
  });
}

function pathOnly(url: string): string {
  try { return new URL(url, DUMMY_ORIGIN).pathname; } catch { return ''; }
}
function fullRoute(raw:string):string {try{const url=new URL(raw,DUMMY_ORIGIN);return url.pathname+url.search+url.hash;}catch{return '';}}

/** First line only, bounded, with run input values replaced by symbolic references. */
function sanitizeObservation(text: string, inputs: Record<string, InputValue>): string {
  let result = safeMessage(text);
  const entries = Object.entries(inputs)
    .filter((entry): entry is [string, string | number] => (typeof entry[1] === 'string' || typeof entry[1] === 'number') && String(entry[1]).length >= 3)
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [name, value] of entries) result = result.split(String(value)).join(`{{input:${name}}}`);
  return result.slice(0, MAX_TEXT);
}

/** Builds a data-only plan from one verifier-passed, agent-finished run. Throws if ineligible. */
export function buildReplay(run: EvidenceRun): ReplayPlan {
  const evidence = run.evidence;
  if (!evidence) return fail('Run has no execution evidence');
  if (run.status !== 'completed' || run.verdict !== 'passed') return fail('Only a verifier-passed run can become a replay');
  if (!run.assertions.length || run.assertions.some(assertion => assertion.status !== 'passed')) return fail('Run assertions did not all pass');
  if (evidence.replayHash) return fail('A replay run cannot be the source of another replay');
  if (!evidence.buildId) return fail('Run evidence has no build identity');
  if (!evidence.scenarioHash) return fail('Run evidence has no scenario hash');
  if (!evidence.finishedByAgent) return fail('Run has no agent finish evidence');
  const actions = checkActions(evidence.actions, run.inputs).map(entry => ({
    ...entry, action: entry.action, url: entry.routeVersion===2?fullRoute(entry.url):pathOnly(entry.url), observation: sanitizeObservation(entry.observation, run.inputs),
  }));
  const body = { version: 1 as const, sourceRunIds: [run.id], scenarioHash: evidence.scenarioHash, buildId: evidence.buildId, actions };
  return { ...body, hash: hashReplayPlan(body) };
}

/** Checks integrity (hash), exact build/scenario identity and strict action validity. Context may differ. */
export function validateReplay(plan: ReplayPlan, run: EvidenceRun): ReplayResult {
  try {
    if (!plan || typeof plan !== 'object' || plan.version !== 1) return fail('Unsupported replay version');
    if (!Array.isArray(plan.sourceRunIds) || !plan.sourceRunIds.length || plan.sourceRunIds.some(id => typeof id !== 'string')) return fail('Replay has no source runs');
    if (typeof plan.scenarioHash !== 'string' || typeof plan.buildId !== 'string' || !plan.scenarioHash || !plan.buildId) return fail('Replay is missing build or scenario identity');
    if (typeof plan.hash !== 'string' || plan.hash !== hashReplayPlan(plan)) return fail('Replay hash does not match its content');
    checkActions(plan.actions, run.inputs);
    const evidence = run.evidence;
    if (!evidence?.buildId || !evidence.scenarioHash) return fail('Run has no build or scenario identity to compare');
    if (evidence.buildId !== plan.buildId) return fail('Replay build mismatch');
    if (evidence.scenarioHash !== plan.scenarioHash) return fail('Replay scenario mismatch');
    return { compatible: true };
  } catch (error) {
    return { compatible: false, message: error instanceof ReplayError ? error.message : `Replay validation failed: ${safeMessage(error)}` };
  }
}

const ERROR_OBSERVATION = /^\s*(error|failed|blocked|denied)\b/i;

/**
 * Runs the plan's actions sequentially through the shared dispatcher, with no model involved. The first
 * thrown error (or error-style observation) stops the replay and is reported as incompatible; the caller
 * records that as replay_mismatch, never as a product defect.
 */
export async function executeReplay(plan: ReplayPlan, run: EvidenceRun, execute: ActionExecutor, inspect?:()=>Promise<{url:string;focus:string}>): Promise<ReplayResult> {
  const validation = validateReplay(plan, run);
  if (!validation.compatible) return validation;
  const actions = checkActions(plan.actions, run.inputs);
  for (const [index, entry] of actions.entries()) {
    const position = index + 1;
    try {
      if(entry.action.tool==='pressKey'&&(!inspect||entry.focusBefore===undefined))return fail('Keyboard replay lacks semantic focus evidence');
      if(entry.routeVersion===2&&!inspect)return fail('Replay requires full route inspection');
      if(inspect&&entry.action.tool!=='navigate'){const current=await inspect();const route=entry.routeVersion===2?fullRoute(current.url):pathOnly(current.url);if(entry.urlBefore!==undefined&&route!==entry.urlBefore)return fail('Replay route differs');if(entry.action.tool==='pressKey'&&current.focus!==entry.focusBefore)return fail('Replay focused control differs');}
      const observation = await execute(entry.action);
      if (typeof observation === 'string' && ERROR_OBSERVATION.test(observation)) return fail('dispatcher reported an error');
      if(entry.routeVersion===2&&inspect&&fullRoute((await inspect()).url)!==fullRoute(entry.url))return fail('Replay reached a different destination');
    } catch (error) {
      const detail = error instanceof ReplayError ? error.message : safeMessage(error);
      return { compatible: false, message: `Replay mismatch at action ${position} (${entry.action.tool}): ${detail}` };
    }
  }
  return { compatible: true };
}
