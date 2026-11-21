import type {
  Project, ProjectContextInvestigation, ProjectCheckResult, ProjectDiscovery, ProjectFinding, ProjectJourney, ProjectRun, ProjectTester, ProjectTesterResult, SourceReference,
} from '@lastmile/contracts/projects';
import type { ProjectStageEvidence } from '@lastmile/contracts/runtime';
import { displayValue, fieldName, RunScreenshot, RunSteps } from './RunEvidence';
import { plural, TesterFace } from './Studio';

export function ContextInvestigation({ investigation }: { investigation: ProjectContextInvestigation }) {
  return <section className="project-report" aria-label="Network comparison">
    <h2>{investigation.outcome === 'likely_trigger' ? 'Likely network trigger' : 'Network comparison inconclusive'}</h2>
    <p>{investigation.message}</p>
    <p className="field-hint">This comparison uses the same recorded actions and checks in fresh private copies, changing only the network condition.</p>
  </section>;
}

export function SourceCitations({ sources }: { sources: SourceReference[] }) {
  if (!sources.length) return null;
  return <details className="project-disclosure">
    <summary>Source citations</summary>
    <ul className="project-sources">{sources.map(source => <li key={`${source.path}:${source.startLine}:${source.endLine}:${source.hash}`}>
      <strong>{source.path}</strong> <span className="muted">Lines {source.startLine}–{source.endLine}</span>
      {source.excerpt && <pre tabIndex={0}>{source.excerpt}</pre>}
      <details className="project-disclosure"><summary>Source hash</summary><code>{source.hash}</code></details>
    </li>)}</ul>
  </details>;
}

export function MeasuredResults({ run, discovery = run?.discovery }: { run?: ProjectRun; discovery?: ProjectDiscovery }) {
  if (!run && !discovery) return null;
  return <details className="project-disclosure">
    <summary>Measured results</summary>
    <dl className="project-metrics">
      {discovery && <>
        <div><dt>Repository index</dt><dd>{plural(discovery.index.fileCount, 'source file')}</dd><dd>{plural(discovery.index.sourceLines, 'indexed line')}</dd><dd>{plural(discovery.index.excludedFiles, 'excluded file')}</dd></div>
        <div><dt>Discovery</dt><dd>{duration(discovery.durationMs)}</dd><dd>{plural(discovery.modelCalls, 'model call')}</dd></div>
      </>}
      {run && <>
        <div><dt>Team run</dt><dd>{duration(run.metrics.elapsedMs)}</dd><dd>{plural(run.metrics.modelCalls, 'model call')}</dd><dd>{plural(run.metrics.browserActions, 'browser action')}</dd></div>
        <div><dt>Journeys</dt><dd>{run.metrics.passed} passed</dd><dd>{run.metrics.failed} failed</dd><dd>{run.metrics.inconclusive} inconclusive</dd></div>
      </>}
    </dl>
    <details className="project-disclosure">
      <summary>Technical details</summary>
      {run && <p>Run ID <code>{run.id}</code></p>}
      {(run?.sourceVersion || discovery?.index.version) && <p>Source version <code>{run?.sourceVersion ?? discovery?.index.version}</code></p>}
    </details>
  </details>;
}

function duration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

export function TesterAccount({ tester, accounts }: { tester: ProjectTester; accounts: Project['accounts'] }) {
  const account = tester.accountId && accounts.find(item => item.id === tester.accountId);
  return <span>{account ? `Development account: ${account.label}` : 'Browser profile'}</span>;
}

export function networkDescription(network: ProjectTester['context']['network']) {
  switch (network.mode) {
    case 'normal': return 'Normal connection';
    case 'offline': return 'Offline';
    case 'request_delay': return `Requests to ${network.pathPrefix} delayed by ${duration(network.delayMs)}`;
    case 'throttled': return `Slower connection: ${duration(network.latencyMs)} latency, ${network.downloadKbps} kbps download, ${network.uploadKbps} kbps upload`;
  }
}

export function TesterPersona({ tester }: { tester: ProjectTester }) {
  const context = tester.context;
  return <>
    <p className="tester-bio">{tester.summary}</p>
    {tester.selectionReason && <p><strong>Why selected:</strong> {tester.selectionReason}</p>}
    <p className="field-hint">{context.familiarity === 'first_time' ? 'First-time user' : 'Experienced user'} · {context.preferredLanguage} · {context.interaction === 'keyboard_only' ? 'Keyboard only' : 'Pointer'}<br />{networkDescription(context.network)}</p>
    <details className="project-disclosure"><summary>Persona details</summary>
      {context.background && <p>{context.background}</p>}
      <dl>
        <dt>Screen</dt><dd>{context.viewport.width} × {context.viewport.height}</dd>
        <dt>Locale</dt><dd>{context.locale}</dd>
        <dt>Motion</dt><dd>{context.reducedMotion === 'reduce' ? 'Reduced motion' : 'No preference'}</dd>
        {context.knownTerms.length > 0 && <><dt>Familiar terms</dt><dd>{context.knownTerms.join(', ')}</dd></>}
      </dl>
    </details>
  </>;
}

export function JourneyStages({ journey, network, evidence, compact = false }: {
  compact?: boolean; journey: ProjectJourney; network: ProjectTester['context']['network']; evidence?: ProjectStageEvidence[];
}) {
  if (!journey.stages?.length) return null;
  let currentNetwork = network;
  const content = <div>
    <p className="field-hint">Pauses are actual short interruptions, not simulated days.</p>
    <ol className="project-journeys" aria-label="Journey stages">{journey.stages.map((stage, index) => {
      currentNetwork = stage.network ?? currentNetwork;
      const recorded = evidence?.find(item => item.id === stage.id);
      const behavior = recorded ?? { ...stage, network: currentNetwork };
      return <li key={stage.id}>
        <strong>Stage {index + 1}: {stage.label}</strong>
        {evidence && <span className="badge">{recorded ? recorded.completed ? 'Completed' : 'Incomplete' : 'Not recorded'}</span>}
        <p>{stage.goal}</p>
        <p className="field-hint">{evidence && !recorded && 'Planned: '}{behavior.transition === 'reopen' ? 'Leave and return in the same browser profile' : 'Continue in the current page'}.
          {behavior.pauseMs ? <> Pause for {duration(behavior.pauseMs)}.</> : null} {networkDescription(behavior.network)}.
          {stage.entryPath && <> Open <code>{stage.entryPath}</code>.</>}
        </p>
      </li>;
    })}</ol>
  </div>;
  return compact ? <details className="project-disclosure"><summary>{journey.stages.map(stage => stage.label).join(' → ')}</summary>{content}</details> : content;
}

const confidenceLabel: Record<ProjectFinding['confidence'], string> = {
  confirmed: 'Confirmed',
  suspected: 'Suspected',
  inconclusive: 'Inconclusive',
};

export function RunFindings({ run, project, title = 'Latest findings', actions, detailLink }: {
  run: ProjectRun; project: Project; title?: string; actions?: React.ReactNode; detailLink?: React.ReactNode;
}) {
  const team = run.discovery?.plan.testers ?? project.discovery?.plan.testers ?? [];
  const findTester = (testerId: string) => run.results.find(result => result.tester.id === testerId)?.tester
    ?? team.find(tester => tester.id === testerId);

  return <section className="project-report" aria-label={title}>
    <div className="run-overview" aria-label="Journey outcomes">
      <div><span className="outcome-dot failed" /><strong>{run.metrics.failed}</strong><span>Failed</span></div>
      <div><span className="outcome-dot passed" /><strong>{run.metrics.passed}</strong><span>Passed</span></div>
      <div><span className="outcome-dot unclear" /><strong>{run.metrics.inconclusive}</strong><span>Inconclusive</span></div>
      <div className="run-duration"><strong>{duration(run.metrics.elapsedMs)}</strong><span>Run time</span></div>
    </div>
    <div className={run.results.length ? 'project-report-grid' : undefined}>
    <div className="project-finding-column">
    <div className="project-section-heading"><h2>{title}</h2>{detailLink}</div>
    {run.status === 'interrupted' && <p className="note warn" role="status">The test team stopped before finishing. Review the evidence it recorded.</p>}
    {run.error && <p className="note warn">{run.error}</p>}
    {run.findings.map(finding => {
      const tester = findTester(finding.testerId);
      const result = run.results.find(item => item.journey.id === finding.journeyId);
      const failed = result?.checks.find(check => finding.failedCheckIds.includes(check.id));
      const definition = result?.journey.checks.find(check => check.id === failed?.id);
      const generatedTitle = failed?.label === finding.title && definition && ['label', 'fieldName'].includes(definition.locator.by);
      const title = generatedTitle ? `${fieldName(definition.locator.value)} did not match` : finding.title;
      return <article className="project-finding" data-confidence={finding.confidence} key={finding.id}>
        <div className="project-finding-heading">
          <h3>{title}</h3>
          <span className={`pill pill-${finding.confidence === 'confirmed' ? 'peach' : 'lilac'}`}>{confidenceLabel[finding.confidence]}</span>
        </div>
        {tester && <p className="project-finding-role">{tester.name} · {tester.role}</p>}
        {generatedTitle && failed ? <div className="check-values">
          <span><b>Expected</b> {displayValue(failed.expected)}</span>
          <span><b>Observed</b> {displayValue(failed.actual)}</span>
        </div> : <p>{finding.description}</p>}
        <details className="project-disclosure finding-context"><summary>Why it matters & evidence</summary>
          {generatedTitle && <p>{finding.description}</p>}
          {finding.impact && <p>{finding.impact}</p>}
          <SourceCitations sources={finding.sources} />
        </details>
      </article>;
    })}
    {run.summary && <details className="project-disclosure"><summary>Run summary</summary><p className="project-summary">{run.summary}</p></details>}
    {!run.findings.length && !run.summary && !run.error && run.status === 'completed' && <p className="project-summary">
      {run.metrics.failed ? 'The team recorded failed checks.' : run.metrics.inconclusive ? 'Some checks were inconclusive.' : run.metrics.passed ? 'The recorded checks passed.' : 'The team finished without recording any checks.'}
    </p>}
    {actions && <div className="project-report-action">{actions}</div>}
    </div>
    {run.results.length > 0 && <div className="project-results">
      <h3>Tester results</h3>
      <TesterResults results={run.results} accounts={project.accounts} />
    </div>}
    </div>
    <MeasuredResults run={run} />
  </section>;
}

export function TesterResults({ results, accounts }: { results: ProjectTesterResult[]; accounts: Project['accounts'] }) {
  return <div className="project-tester-results">{results.map((result, index) => <article key={result.run.id} className="project-result">
    <header className="tester-heading">
      <TesterFace index={index} />
      <div>
        <h4>{result.tester.name} · {result.tester.role}</h4>
        <p><TesterAccount tester={result.tester} accounts={accounts} />{result.sessionContinued && <> · Continued browser session</>}</p>
      </div>
    </header>
    <details className="project-disclosure"><summary>About this tester</summary><TesterPersona tester={result.tester} /></details>
    <p><strong>{result.journey.title}</strong></p>
    <JourneyStages compact journey={result.journey} network={result.tester.context.network} evidence={result.run.evidence?.stages ?? []} />
    <ProjectChecks checks={result.checks} />
    {result.run.steps.length > 0 && <RunSteps run={result.run} />}
    {result.run.artifacts.some(path => /\.png$/i.test(path)) && <details className="project-disclosure">
      <summary>Browser screenshot</summary>
      <RunScreenshot run={result.run} />
    </details>}
  </article>)}</div>;
}

function ProjectChecks({ checks }: { checks: ProjectCheckResult[] }) {
  const passing = checks.filter(check => check.status === 'passed');
  const other = checks.filter(check => check.status !== 'passed');
  if (!checks.length) return <p className="muted">No checks were recorded.</p>;
  return <>
    <CheckList checks={other} />
    {passing.length > 0 && <details className="project-disclosure">
      <summary>{plural(passing.length, 'passed check')}</summary>
      <CheckList checks={passing} />
    </details>}
  </>;
}

function CheckList({ checks }: { checks: ProjectCheckResult[] }) {
  if (!checks.length) return null;
  return <ul className="observed-checks">{checks.map(check => <li key={check.id}>
    <div className="check-title">
      <strong>{check.label}</strong>
      {check.atStageStart && <small>Checked before the tester acts</small>}
      <span className={`pill pill-${check.status === 'failed' ? 'peach' : check.status === 'passed' ? 'mint' : 'lilac'}`}>
        {check.status === 'not_evaluated' ? 'Not evaluated' : fieldName(check.status)}
      </span>
    </div>
    {check.status !== 'not_evaluated' && <div className="check-values">
      <span><b>Expected</b> {displayValue(check.expected)}</span>
      <span><b>Observed</b> {displayValue(check.actual)}</span>
    </div>}
    {check.message && <p className="field-hint">{check.message}</p>}
    <details className="project-disclosure"><summary>Check details</summary>
      <p>{fieldName(check.phase)} · Based on {check.basis === 'implementation' ? 'implementation' : check.basis === 'requirement' ? 'a requirement' : 'a source test'}</p>
      <SourceCitations sources={check.sources} />
    </details>
  </li>)}</ul>;
}
