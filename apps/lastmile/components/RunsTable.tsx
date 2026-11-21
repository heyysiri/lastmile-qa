import Link from 'next/link';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import { StatusBadge } from './ui';

export function RunsTable({ runs }: { runs: EvidenceRun[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Run</th><th>Scenario · rev</th><th>Context · rev</th><th>Status</th><th>Verdict</th><th>Created</th></tr></thead>
        <tbody>
          {runs.map(r => (
            <tr key={r.id}>
              <td><Link href={`/runs/${encodeURIComponent(r.id)}`} className="mono">{r.id.slice(0, 12)}</Link></td>
              <td>{r.scenario.label} · {r.scenario.revision}</td><td>{r.context.label} · {r.context.revision}</td>
              <td><StatusBadge value={r.status} /></td><td><StatusBadge value={r.verdict} /></td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
