'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GitCompareArrows, Play } from 'lucide-react';
import { compileInputs, type InputValue } from '@lastmile/contracts';
import { LaunchPopulationRequestSchema, type PersistentTask, type PopulationDetail, type PopulationExecution, type PopulationTester } from '@lastmile/contracts/populations';
import type { ApplicationWorkflow } from '@lastmile/contracts/studies';
import { api, type Health } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { checkpointBaselines, populationExecutionHref, usePendingWrite } from '../lib/populations';
import { ExpectedChecks, fieldName } from './RunEvidence';
import { StudioError, TesterFace } from './Studio';

const supportsScalarInputs = (workflow: ApplicationWorkflow) =>
  Object.values(workflow.scenario.inputSlots).every(slot => slot.type !== 'file');

function scalarInputs(workflow: ApplicationWorkflow | undefined, source: Record<string, InputValue>) {
  return Object.fromEntries(Object.keys(workflow?.scenario.inputSlots ?? {}).flatMap(key => {
    const value = source[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [[key, value]] : [];
  }));
}

function taskIsValid(tester: PopulationTester | undefined, task: PersistentTask, workflow?: ApplicationWorkflow) {
  if (!tester || !workflow) return false;
  if (Object.entries(workflow.scenario.inputSlots).some(([id, slot]) =>
    slot.type === 'text' && slot.required && !String(task.inputs[id] ?? '').trim())) return false;
  try {
    compileInputs(workflow.scenario, { ...tester.profile.context, inputs: task.inputs });
    return true;
  } catch { return false; }
}

export function PopulationLaunch({ population, workflows, executions, active, canLaunch, health, refresh }: {
  population: PopulationDetail; workflows: ApplicationWorkflow[]; executions: PopulationExecution[];
  active?: PopulationExecution; canLaunch: boolean; health: Health | null; refresh: () => void;
}) {
  const router = useRouter();
  const availableWorkflows = workflows.filter(supportsScalarInputs);
  const [mode, setMode] = useState<'continue' | 'checkpoint'>('continue');
  const [releaseLabel, setReleaseLabel] = useState('');
  const [baselineExecutionId, setBaselineExecutionId] = useState('');
  const [tasks, setTasks] = useState<PersistentTask[]>(() => population.testers.map(({ id, profile }) => ({
    testerId: id, workflowId: profile.workflowId, goal: profile.goal,
    inputs: scalarInputs(availableWorkflows.find(item => item.id === profile.workflowId), profile.context.inputs),
  })));
  const launch = usePendingWrite(`lastmile-pending-population-launch-${population.id}`, LaunchPopulationRequestSchema,
    request => api.launchPopulation(population.id, request),
    id => router.push(populationExecutionHref(population.id, id)),
    (error, rejected) => {
      setMode(rejected.mode);
      setReleaseLabel(rejected.releaseLabel);
      if (rejected.mode === 'continue') setTasks(rejected.tasks);
      else setBaselineExecutionId(error.code === 'invalid_baseline' ? '' : rejected.baselineExecutionId);
      if (error.status === 409) refresh();
    });
  const displayedMode = launch.pending?.mode ?? mode;
  const displayedTasks = launch.pending?.mode === 'continue' ? launch.pending.tasks : tasks;
  const displayedBaseline = launch.pending?.mode === 'checkpoint' ? launch.pending.baselineExecutionId : baselineExecutionId;
  const baselines = displayedMode === 'checkpoint' ? checkpointBaselines(population, executions) : [];
  const valid = LaunchPopulationRequestSchema.safeParse(mode === 'continue'
    ? { requestId: 'draft', releaseLabel, mode, tasks }
    : { requestId: 'draft', releaseLabel, mode, baselineExecutionId });
  const browserReady = health?.executionReady === true;
  const modeReady = mode === 'continue'
    ? Boolean(health?.modelConfigured && tasks.every(task => taskIsValid(population.testers.find(item => item.id === task.testerId), task, availableWorkflows.find(item => item.id === task.workflowId))))
    : baselines.some(execution => execution.id === baselineExecutionId);
  const blocked = !launch.ready || launch.busy || !canLaunch || Boolean(active) || !browserReady || !modeReady || !valid.success;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (launch.pending) void launch.submit();
    else if (!blocked && valid.success) void launch.submit({ ...valid.data, requestId: newRequestId() });
  }

  return <section className="studio-card population-launch" aria-labelledby="population-launch-title">
    <div className="card-heading"><span className="icon-tile"><Play size={18} aria-hidden="true" /></span><h2 id="population-launch-title">Start an execution</h2></div>
    {active && <p className="note warn" role="status">An execution is already queued or running. <Link href={populationExecutionHref(population.id, active.id)}>View live execution</Link></p>}
    <form onSubmit={submit} noValidate={Boolean(launch.pending)}>
      <fieldset className="plain-fieldset" disabled={Boolean(launch.pending) || launch.busy}>
        <legend className="sr-only">Execution mode</legend>
        <div className="population-modes">
          <label className="count-option">
            <input type="radio" name="population-mode" checked={displayedMode === 'continue'} onChange={() => setMode('continue')} />
            <span><strong>Continue their journeys</strong><small>AI-guided · uses the same accounts and recent observations.</small></span>
          </label>
          <label className="count-option">
            <input type="radio" name="population-mode" checked={displayedMode === 'checkpoint'} onChange={() => setMode('checkpoint')} />
            <span><strong>Compare a release</strong><small>No model calls · replays frozen actions and checks in cloned accounts.</small></span>
          </label>
        </div>
        <label className="field"><span>Release label</span><input required maxLength={120} placeholder="e.g. Spring candidate" value={launch.pending?.releaseLabel ?? releaseLabel} onChange={event => setReleaseLabel(event.target.value)} /></label>
        {displayedMode === 'continue' ? <>
          <p className="field-hint">Choose a task for every tester. The runner checks the current build and saves each account’s starting checkpoint. Model usage may incur charges.</p>
          {!availableWorkflows.length && <p className="note warn">No workflows with scalar inputs are available for this application.</p>}
          <div className="population-task-grid">
            {population.testers.map((tester, index) => {
              const task = displayedTasks.find(item => item.testerId === tester.id) ?? tasks[index];
              return <NextTask key={tester.id} tester={tester} task={task} index={index} workflows={availableWorkflows}
                onChange={patch => setTasks(current => current.map(item => item.testerId === tester.id ? { ...item, ...patch } : item))} />;
            })}
          </div>
        </> : <>
          <p className="field-hint">The baseline’s starting states, inputs, and expectations are frozen. Each replay uses a separate clone and leaves the continuing accounts untouched.</p>
          <label className="field"><span>Baseline execution</span>
            <select required value={baselines.some(execution => execution.id === displayedBaseline) ? displayedBaseline : ''} onChange={event => setBaselineExecutionId(event.target.value)} disabled={!baselines.length}>
              <option value="">Select a passing baseline</option>
              {baselines.map(execution => <option key={execution.id} value={execution.id}>{execution.releaseLabel} · {execution.buildId} · {new Date(execution.createdAt).toLocaleString()}</option>)}
            </select>
          </label>
          {!baselines.length && <p className="field-hint">A baseline needs a completed AI-guided journey with passing checks, recorded actions, and a starting checkpoint for every tester.</p>}
        </>}
      </fieldset>
      {health && (!browserReady || (displayedMode === 'continue' && !health.modelConfigured)) &&
        <p className="note warn">{!browserReady ? 'Browser execution is unavailable.' : 'A configured model is required for continuing journeys.'}</p>}
      <button type="submit" disabled={launch.pending ? launch.busy : blocked}>
        {displayedMode === 'continue' ? <Play size={16} aria-hidden="true" /> : <GitCompareArrows size={16} aria-hidden="true" />}
        {launch.busy ? 'Submitting…' : launch.pending ? 'Recover launch' : displayedMode === 'continue' ? 'Continue with these tasks' : 'Run checkpoint comparison'}
      </button>
      <StudioError error={launch.error} />
      {launch.pending && !launch.busy && <p className="field-hint">Recover the original request to check whether this execution started.</p>}
    </form>
  </section>;
}

function NextTask({ tester, task, index, workflows, onChange }: {
  tester: PopulationTester; task: PersistentTask; index: number; workflows: ApplicationWorkflow[];
  onChange: (patch: Partial<PersistentTask>) => void;
}) {
  const workflow = workflows.find(item => item.id === task.workflowId);

  function changeInput(id: string, value?: PersistentTask['inputs'][string]) {
    const inputs = { ...task.inputs };
    if (value === undefined) delete inputs[id];
    else inputs[id] = value;
    onChange({ inputs });
  }

  return <fieldset className={`population-task tone-${index % 3}`}>
    <legend><span className="sr-only">Next task for </span>{tester.profile.name}</legend>
    <div className="population-task-face"><TesterFace index={index} /></div>
    <label className="field"><span>Workflow</span>
      <select value={task.workflowId} disabled={!workflows.length} onChange={event => {
        const next = workflows.find(item => item.id === event.target.value);
        if (next) onChange({ workflowId: next.id, goal: next.scenario.goal, inputs: scalarInputs(next, next.defaultInputs) });
      }}>
        {!workflow && <option value={task.workflowId}>Choose an available workflow</option>}
        {workflows.map(item => <option key={item.id} value={item.id}>{item.scenario.label}</option>)}
      </select>
    </label>
    <label className="field"><span>Goal</span><textarea className="compact" required minLength={5} maxLength={2000} value={task.goal} onChange={event => onChange({ goal: event.target.value })} /></label>
    {workflow && <>
      <p className="field-hint">{workflow.description}</p>
      {Object.entries(workflow.scenario.inputSlots).map(([id, slot]) => {
        const value = task.inputs[id];
        return <label className="field" key={id}><span>{fieldName(id)}</span>
          {slot.type === 'boolean' ? <select required={slot.required} value={typeof value === 'boolean' ? String(value) : ''} onChange={event => changeInput(id, event.target.value === '' ? undefined : event.target.value === 'true')}>
            <option value="">Choose a value</option><option value="true">Yes</option><option value="false">No</option>
          </select> : <input required={slot.required} type={slot.type} step={slot.type === 'number' ? 'any' : undefined}
            value={typeof value === 'string' || typeof value === 'number' ? value : ''}
            onChange={event => changeInput(id, event.target.value === '' ? undefined : slot.type === 'number' ? event.target.valueAsNumber : event.target.value)} />}
        </label>;
      })}
      <details className="studio-disclosure"><summary>Expected checks</summary><ExpectedChecks scenario={workflow.scenario} inputs={task.inputs} /></details>
    </>}
  </fieldset>;
}
