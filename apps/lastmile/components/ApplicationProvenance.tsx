'use client';

import type { ApplicationContext } from '@lastmile/contracts/populations';
import { fieldName } from './RunEvidence';
import { StudioError } from './Studio';
import { Pending } from './ui';

export function ApplicationProvenance({ context, error, loading, onRetry, recorded }: {
  context?: ApplicationContext | null; error?: unknown; loading?: boolean; onRetry?: () => void; recorded?: boolean;
}) {
  return <details className="studio-card studio-disclosure population-context">
    <summary>{recorded ? 'Recorded application context' : 'Application context'}</summary>
    <p>Requirements define expected behavior. Code describes the implementation. Observations record what the app showed.</p>
    <StudioError error={error} onRetry={onRetry} />
    {loading && !context && <Pending label="Loading application context…" />}
    {!loading && !context && !error && <p className="muted">No context was captured for this execution.</p>}
    {context && <>
      <p className="field-hint">Version <code>{context.version}</code> · {new Date(context.capturedAt).toLocaleString()}</p>
      {context.sources.length === 0 && <p className="muted">No context sources were recorded.</p>}
      <ul className="context-sources">{context.sources.map(source => <li key={`${source.kind}:${source.path}`}>
        <span className={`pill pill-${source.kind === 'requirement' ? 'mint' : 'lilac'}`}>{fieldName(source.kind)}</span>
        <strong>{source.path}</strong>
        <small>Digest <code>{source.digest}</code></small>
        <pre>{source.excerpt}</pre>
      </li>)}</ul>
    </>}
  </details>;
}
