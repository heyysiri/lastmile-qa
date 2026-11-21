import { Check, ImageIcon } from 'lucide-react';
import { resolveExpected, type Assertion, type InputValue, type RunRecord, type ScenarioDefinition } from '@lastmile/contracts';

export function fieldName(value: string) {
  const label = value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function checkLabel(check: Assertion) {
  if ('locator' in check) return check.locator.name || (check.locator.by === 'testId' ? fieldName(check.locator.value) : check.locator.value);
  const label = check.path.split('.').filter(segment => !/^\d+$/.test(segment)).join(' ');
  return fieldName(label);
}

export function displayValue(value: unknown): string {
  if (value === undefined) return 'Unavailable';
  if (value === null) return 'Empty';
  if (typeof value === 'string') return value || 'Empty text';
  return JSON.stringify(value);
}

export function ExpectedChecks({ scenario, inputs }: { scenario: ScenarioDefinition; inputs: Record<string, InputValue> }) {
  return <ul className="expected-checks">{scenario.contract.assertions.map(check => {
    const label = checkLabel(check);
    const expected = check.kind === 'visible' ? 'Visible on screen'
      : check.kind === 'state_count' ? check.expected
      : 'input' in check.expected && !Object.hasOwn(inputs, check.expected.input) ? 'Choose an input'
      : resolveExpected(check.expected, inputs);
    return <li key={check.id}><Check size={15} aria-hidden="true" /><span>{label}</span><strong>{displayValue(expected)}</strong></li>;
  })}</ul>;
}

export function RunChecks({ run }: { run: RunRecord }) {
  if (!run.assertions.length) return <p className="muted">No checks have been recorded.</p>;
  return <ul className="observed-checks">{run.assertions.map(result => {
    const check = run.scenario.contract.assertions.find(item => item.id === result.id);
    const tone = result.status === 'passed' ? 'mint' : result.status === 'failed' ? 'peach' : 'lilac';
    return <li key={result.id}>
      <div className="check-title"><strong>{check ? checkLabel(check) : fieldName(result.id)}</strong><span className={`pill pill-${tone}`}>{result.status === 'not_evaluated' ? 'Not evaluated' : fieldName(result.status)}</span></div>
      {result.status !== 'not_evaluated' && <div className="check-values">
        <span><b>Expected</b> {check?.kind === 'visible' ? 'Visible on screen' : displayValue(result.expected)}</span>
        <span><b>Observed</b> {check?.kind === 'visible' && result.status === 'passed' ? 'Visible on screen' : check?.kind === 'visible' && typeof result.actual === 'boolean' ? result.actual ? 'Visible on screen' : 'Hidden or absent' : displayValue(result.actual)}</span>
      </div>}
      {result.message && <p className="field-hint">{result.message}</p>}
    </li>;
  })}</ul>;
}

export function artifactHref(runId: string, path: string) {
  const name = path.split('/').at(-1) ?? '';
  return `/api/runner/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
}

export function RunScreenshot({ run }: { run: RunRecord }) {
  const screenshots = run.artifacts.filter(path => /\.png$/i.test(path));
  const latest = [...run.steps].reverse().find(step => step.screenshot && screenshots.includes(step.screenshot));
  const final = screenshots.find(path => path.split('/').at(-1) === 'final.png');
  const screenshot = final ?? latest?.screenshot ?? screenshots.at(-1);
  if (!screenshot) return null;
  const href = artifactHref(run.id, screenshot);
  return <figure className="evidence-shot">
    <a href={href} target="_blank" rel="noreferrer" aria-label="Open screenshot">
      <img src={href} alt={final ? 'Final browser screenshot' : latest ? `Browser screenshot after step ${latest.index}` : 'Recorded browser screenshot'} loading="lazy" />
      <span className="shot-caption"><ImageIcon size={15} aria-hidden="true" />Open screenshot</span>
    </a>
  </figure>;
}

export function RunSteps({ run }: { run: RunRecord }) {
  return <details className="studio-disclosure run-steps">
    <summary>Journey steps <span className="badge">{run.steps.length}</span></summary>
    {run.steps.length ? <ol className="step-list">{run.steps.map(step => (
      <li key={step.index}>
        <strong>{fieldName(step.action)}</strong>
        {step.observation.includes('\n') ? <details className="step-observation">
          <summary>{step.observation.split('\n', 1)[0]}</summary>
          <pre>{step.observation}</pre>
        </details> : <p>{step.observation}</p>}
        {step.screenshot && run.artifacts.includes(step.screenshot) && <a href={artifactHref(run.id, step.screenshot)} target="_blank" rel="noreferrer">Screenshot for step {step.index}</a>}
      </li>
    ))}</ol> : <p className="muted">No steps recorded.</p>}
  </details>;
}
