'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ExternalLink, FileText, History, Play, Users } from 'lucide-react';
import { api, useLoad } from '../lib/api';

const links = [
  { href: '/', label: 'Run', icon: Play },
  { href: '/scenarios', label: 'Scenarios', icon: FileText },
  { href: '/contexts', label: 'Context packs', icon: Users },
  { href: '/runs', label: 'Run history', icon: History },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const health = useLoad(api.health, []);
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <div className="shell">
      <aside className="side">
        <Link href="/" className="brand">LastMile QA<small>seller journey workbench</small></Link>
        <nav className="nav" aria-label="Primary">
          {links.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined}><Icon size={16} aria-hidden /> {label}</Link>
          ))}
        </nav>
        <div className="side-foot">
          <div aria-live="polite">
            {health.loading ? 'Checking runner…' : health.error ? <span>Runner offline</span> : (
              <span>Runner online · {health.data?.executionReady ? 'execution ready' : 'execution not ready'}</span>
            )}
          </div>
          <a href="http://127.0.0.1:3001" target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden /> Open seller demo</a>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
