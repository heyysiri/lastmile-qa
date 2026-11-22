import type { ProjectCase, GitHubProject } from '@lastmile/contracts/projects';
import { relativeTime } from '../lib/projects';

const coverage: Record<NonNullable<GitHubProject['coverageMode']>, string> = {
  retain: 'Existing coverage kept. New source changes only add tests.',
  refresh: 'Coverage refreshed for the latest source.',
};

/** The persistent saved tests that each sync keeps, listed under the team. */
export function TestInventory({ cases, coverageMode }: { cases?: ProjectCase[]; coverageMode?: GitHubProject['coverageMode'] }) {
  if (!cases?.length) return null;
  return <section className="project-inventory" aria-labelledby="inventory-heading">
    <div className="project-section-heading"><h2 id="inventory-heading">Saved tests <span>{cases.length}</span></h2></div>
    {coverageMode && <p className="field-hint">{coverage[coverageMode]}</p>}
    <ul className="project-case-list">{cases.map(item => <li key={item.id} data-case-id={item.id}>
      <div><strong>{item.journey.title}</strong><span className="muted">{item.tester.name} · {item.tester.role}</span></div>
      <span className={`badge ${item.outcome === 'passed' ? 'ok' : item.outcome === 'failed' ? 'bad' : 'warn'}`}>{item.outcome ?? 'Not run yet'}</span>
      <details className="project-disclosure">
        <summary>Details</summary>
        <p>Test ID <code>{item.id}</code></p>
        <p>Last seen in the source {relativeTime(item.lastSeenAt)}</p>
      </details>
    </li>)}</ul>
  </section>;
}
