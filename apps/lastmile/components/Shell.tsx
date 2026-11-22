'use client';

import Link from 'next/link';
import { api, useLoad } from '../lib/api';

export function Shell({ children, account }: { children: React.ReactNode; account?: React.ReactNode }) {
  const health = useLoad(api.health);
  return <div className="workspace-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="workspace-topbar">
      <Link href="/" className="workspace-brand" aria-label="lastmile qa. home">
        <span className="eyes-mark" aria-hidden="true"><i /><i /></span>
        <span>lastmile qa.</span>
      </Link>
      <div className="workspace-account">
      <div className="runner-status" aria-live="polite">
        <i className={health.error ? 'offline' : health.loading ? 'checking' : ''} aria-hidden="true" />
        {health.loading ? 'Connecting…' : health.error ? 'Runner offline' : 'Runner online'}
      </div>
      {account}
      </div>
    </header>
    <main className="workspace-main" id="main-content" tabIndex={-1}>{children}</main>
    <footer className="workspace-footer"><span>Built for the people on the other side of your app.</span><span>lastmile qa.</span></footer>
  </div>;
}
