'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function StartSession({ fixtureId, description }: { fixtureId: 'fresh-seller' | 'active-seller'; description: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function start() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixtureId }) });
      if (!res.ok) throw new Error((await res.json()).message ?? 'Could not start a session');
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start a session'); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel" aria-labelledby="start-h">
      <h2 id="start-h" style={{ marginTop: 0 }}>Try the seller tools</h2>
      <p className="lede" style={{ marginBottom: '1rem' }}>{description}</p>
      <button className="btn" type="button" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start demo session'}</button>
      <div role="alert" className={error ? 'status err' : 'status'}>{error}</div>
    </section>
  );
}
