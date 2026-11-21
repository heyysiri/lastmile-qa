import { AlertCircle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { ApiFailure } from '../lib/api';

export function TesterFace({ index }: { index: number }) {
  return <span className={`tester-face face-${index % 3}`} aria-hidden="true">
    <span className="face-shape"><i /><i /><b /></span>
  </span>;
}

export function StudioError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const offline = error instanceof ApiFailure && ['runner_offline', 'dashboard_offline'].includes(error.code);
  return <div className="studio-error" role="alert">
    <AlertCircle size={18} aria-hidden="true" />
    <div>
      <strong>{offline ? 'Connection interrupted' : 'Something needs attention'}</strong>
      <p>{message}</p>
      {onRetry && <button type="button" className="text-button" onClick={onRetry}>Try again</button>}
    </div>
  </div>;
}

export function StudioBack({ href = '/studies', children = 'Studies' }: { href?: string; children?: React.ReactNode }) {
  return <Link href={href} className="studio-back"><ArrowLeft size={15} aria-hidden="true" />{children}</Link>;
}

export function studyHref(id: string) {
  return `/studies/${encodeURIComponent(id)}`;
}

export function executionHref(studyId: string, id: string) {
  return `${studyHref(studyId)}/executions/${encodeURIComponent(id)}`;
}

export function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
