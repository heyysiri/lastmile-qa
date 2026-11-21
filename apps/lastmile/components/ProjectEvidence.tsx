import type {
  Project, ProjectCheckResult, ProjectDiscovery, ProjectFinding, ProjectRun, ProjectTester, ProjectTesterResult, SourceReference,
} from '@lastmile/contracts/projects';
import { displayValue, fieldName, RunScreenshot, RunSteps } from './RunEvidence';
import { plural, TesterFace } from './Studio';

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
      return <article className="project-finding" data-confidence={finding.confidence} key={finding.id}>
        <div className="project-finding-heading">
          <h3>{finding.title}</h3>
          <span className={`pill pill-${finding.confidence === 'confirmed' ? 'peach' : 'lilac'}`}>{confidenceLabel[finding.confidence]}</span>
        </div>
        {tester && <p className="project-finding-role">{tester.name} · {tester.role}</p>}
        <p>{finding.description}</p>
        <details className="project-disclosure finding-context"><summary>Why it matters & evidence</summary>
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
    <p>{result.journey.title}</p>
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
