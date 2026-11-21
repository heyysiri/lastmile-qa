'use client';
import { useState } from 'react';

export function StoreForm({ initialName, initialStatus, shortTimeout = false }: { initialName: string; initialStatus: string | null; shortTimeout?: boolean }) {
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState<{ name: string; status: string } | null>(initialStatus ? { name: initialName, status: initialStatus } : null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMessage(null);
    try {
      const res = await fetch('/api/store', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal: shortTimeout ? AbortSignal.timeout(700) : undefined });
      const body = await res.json();
      if (!res.ok) { setMessage({ kind: 'err', text: body.message ?? 'Could not save the store' }); return; }
      setSaved(body.store); setName(body.store.name);
      setMessage({ kind: 'ok', text: 'Store saved' });
    } catch { setMessage({ kind: 'err', text: 'Could not reach the server. Check your connection and try again.' }); }
    finally { setBusy(false); }
  }
  return (
    <form className="panel" onSubmit={submit} aria-labelledby="store-h" noValidate>
      <h2 id="store-h" style={{ marginTop: 0 }}>Your store</h2>
      <div className="field">
        <label htmlFor="store-name">Store name</label>
        <input disabled={busy} id="store-name" name="storeName" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" aria-describedby="store-hint" aria-invalid={message?.kind === 'err'} />
        <span id="store-hint" className="hint">Shoppers see this name. Up to 80 characters.</span>
      </div>
      <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save store'}</button>
      <div role={message?.kind === 'err' ? 'alert' : 'status'} className={message ? `status ${message.kind}` : 'status'}>{message?.text}</div>
      {saved && <p className="sub">Current store: <strong>{saved.name}</strong> ({saved.status})</p>}
    </form>
  );
}
