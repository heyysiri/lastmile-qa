'use client';

import { useAuth, UserButton } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from './Shell';
import { selectBrowserWorkspace } from '../lib/workspace-storage';

function Workspace({ children }: { children: React.ReactNode }) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  const [readyFor, setReadyFor] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    try { selectBrowserWorkspace(sessionStorage, userId); } catch { /* Storage may be disabled; no persisted writes can be restored. */ }
    setReadyFor(userId);
  }, [userId]);
  if (!isLoaded || !isSignedIn || !userId || readyFor !== userId) return <main className="auth-loading">Opening your workspace…</main>;
  return <Shell key={userId} account={<UserButton />}>{children}</Shell>;
}

export function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (/^\/(sign-in|sign-up)(\/|$)/.test(pathname)) return children;
  return <Workspace>{children}</Workspace>;
}
