'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, FlaskConical, Folders, SlidersHorizontal } from 'lucide-react';
import { api, useLoad } from '../lib/api';

const advanced = [
  { href: '/studies', label: 'Studies' },
  { href: '/populations', label: 'Populations' },
  { href: '/executions', label: 'History' },
  { href: '/scenarios', label: 'Scenarios' },
  { href: '/contexts', label: 'Context packs' },
  { href: '/runs', label: 'Individual runs' },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isProjectPage = path === '/' || path.startsWith('/projects/') || path.startsWith('/project-repairs/');
  const health = useLoad(api.health);
  return (
    <div className={isProjectPage ? "shell project-shell" : "shell"}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="side">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true"><FlaskConical size={20} /><i /></span>
          <span>LastMile<small>QA studio</small></span>
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href="/" aria-current={isProjectPage ? 'page' : undefined}>
            <Folders size={17} aria-hidden="true" /> Projects
          </Link>
          <details className="nav-advanced" open={advanced.some(item => path.startsWith(item.href)) || undefined}>
            <summary><SlidersHorizontal size={16} aria-hidden="true" /> Advanced <ChevronDown size={14} className="nav-chevron" aria-hidden="true" /></summary>
            <div>{advanced.map(({ href, label }) => <Link key={href} href={href} aria-current={path.startsWith(href) ? 'page' : undefined}>{label}</Link>)}</div>
          </details>
        </nav>
        <div className="side-foot" aria-live="polite">
          <i className={health.error ? 'offline' : health.loading ? 'checking' : ''} aria-hidden="true" />
          {health.loading ? 'Checking runner…' : health.error ? 'Runner offline' : 'Runner online'}
        </div>
      </aside>
      <main className="main" id="main-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
