'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api, useLoad } from '../lib/api';

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const health = useLoad(api.health);
  return <div className="workspace-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="workspace-topbar">
      <Link href="/" className="workspace-brand" aria-label="LastMile home">
        <span className="eyes-mark" aria-hidden="true"><i /><i /></span>
        <span>lastmile<span className="brand-period">.</span></span>
      </Link>
      <nav aria-label="Primary"><Link href="/" aria-current={path === '/' ? 'page' : undefined}>Projects</Link></nav>
      <div className="runner-status" aria-live="polite">
        <i className={health.error ? 'offline' : health.loading ? 'checking' : ''} aria-hidden="true" />
        {health.loading ? 'Connecting…' : health.error ? 'Runner offline' : 'Runner online'}
      </div>
    </header>
    <main className="workspace-main" id="main-content" tabIndex={-1}>{children}</main>
    <footer className="workspace-footer"><span>Built for the people on the other side of your app.</span><span>LastMile QA</span></footer>
  </div>;
}
