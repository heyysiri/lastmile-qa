'use client';
import { useState } from 'react';

type Item = { sku: string; name: string; quantity: number };

export function InventoryForm({ initial }: { initial: Item[] }) {
  const [items, setItems] = useState(initial);
  const first = items[0];
  const [value, setValue] = useState(String(first?.quantity ?? ''));
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!first) return <section className="panel"><h2 style={{ marginTop: 0 }}>No products yet</h2><p className="lede">Products will appear here once your store has stock to track.</p></section>;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMessage(null);
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) { setMessage({ kind: 'err', text: 'Enter stock as a whole number, like 12.' }); setBusy(false); return; }
    try {
      const res = await fetch('/api/inventory', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: first.sku, quantity: Number(trimmed) }) });
      const body = await res.json();
      if (!res.ok) { setMessage({ kind: 'err', text: body.message ?? 'Could not save inventory' }); return; }
      setItems(body.inventory); setValue(String(body.inventory[0].quantity));
      setMessage({ kind: 'ok', text: 'Inventory saved' });
    } catch { setMessage({ kind: 'err', text: 'Could not reach the server. Check your connection and try again.' }); }
    finally { setBusy(false); }
  }
  return (
    <form className="panel" onSubmit={submit} aria-labelledby="inv-h" noValidate>
      <h2 id="inv-h" style={{ marginTop: 0 }}>Stock</h2>
      <div className="product"><div><strong>{first.name}</strong><span className="sku">{first.sku}</span></div><div>In stock: <strong>{first.quantity}</strong></div></div>
      <div className="field">
        <label htmlFor="qty">Stock quantity for {first.name}</label>
        <input disabled={busy} id="qty" name="quantity" type="text" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} aria-describedby="qty-hint" aria-invalid={message?.kind === 'err'} />
        <span id="qty-hint" className="hint">Whole units available to sell. Use 0 when sold out.</span>
      </div>
      <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save inventory'}</button>
      <div role={message?.kind === 'err' ? 'alert' : 'status'} className={message ? `status ${message.kind}` : 'status'}>{message?.text}</div>
    </form>
  );
}
