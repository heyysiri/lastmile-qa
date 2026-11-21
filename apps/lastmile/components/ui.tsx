'use client';
import { Loader2 } from 'lucide-react';
import type { ApiFailure } from '../lib/api';

export function ErrorNote({ error, onRetry }: { error: ApiFailure | string | null; onRetry?: () => void }) {
  if (!error) return null;
  const e = typeof error === 'string' ? null : error;
  const offline = e?.code === 'runner_offline' || e?.code === 'dashboard_offline';
  return (
    <div className="note bad" role="alert">
      <strong>{offline ? 'Runner unreachable' : 'Request failed'}</strong>
      <div>{e ? e.message : error as string}{e && e.status ? ` (HTTP ${e.status}${e.code ? `, ${e.code}` : ''})` : ''}</div>
      {onRetry && <button type="button" className="secondary" onClick={onRetry} style={{ marginTop: '.4rem' }}>Retry</button>}
    </div>
  );
}

export function Pending({ label }: { label: string }) {
  return <p className="muted" role="status"><Loader2 size={14} className="spin" aria-hidden /> {label}</p>;
}

export function StatusBadge({ value }: { value: string | null }) {
  const cls = value === 'passed' || value === 'completed' ? 'ok' : value === 'failed' ? 'bad' : value === 'running' || value === 'queued' ? 'info' : 'warn';
  return <span className={`badge ${cls}`}>{value ?? 'no verdict'}</span>;
}
