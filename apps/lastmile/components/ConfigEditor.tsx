'use client';
import { useEffect, useMemo, useState } from 'react';
import { Copy, Plus, Save } from 'lucide-react';
import type { ContextPack, InputValue, ScenarioDefinition } from '@lastmile/contracts';
import { storeScenario, desktopContext } from '@lastmile/contracts/examples';
import { ApiFailure, api, useLoad } from '../lib/api';
import {
  duplicateContext, duplicateScenario, formatLocator,
  parseContextJson, parseScenarioJson, type Parsed,
} from '../lib/editor';
import { ErrorNote, Pending } from './ui';

type Kind = 'scenario' | 'context';
type Item = ScenarioDefinition | ContextPack;
type Tab = 'form' | 'json';

export function ConfigEditor({ kind }: { kind: Kind }) {
  const isScenario = kind === 'scenario';
  const list = useLoad<Item[]>(isScenario ? api.scenarios : api.contexts, [kind]);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Item | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<{ id: string; json: string } | null>(null);

  const items = list.data ?? [];
  useEffect(() => {
    if (selected === null && items.length) { setSelected(items[0].id); setDraft(items[0]); setIsNew(false); }
  }, [items, selected]);

  const pick = (item: Item) => { setSelected(item.id); setDraft(item); setIsNew(false); };
  const startNew = () => { setSelected('new'); setDraft(isScenario ? { ...storeScenario, id: '', label: '', goal: '' } as ScenarioDefinition : { ...desktopContext, id: '', label: '' }); setIsNew(true); };
  const duplicate = () => {
    if (!draft) return;
    const ids = items.map(i => i.id);
    const copy = isScenario ? duplicateScenario(draft as ScenarioDefinition, ids) : duplicateContext(draft as ContextPack, ids);
    setSelected('new'); setDraft(copy); setIsNew(true);
  };

  return (
    <>
      <h1>{isScenario ? 'Scenarios' : 'Context packs'}</h1>
      <p className="muted">
        {isScenario
          ? 'A scenario is a seller goal plus an outcome contract. Edits create a new revision; past runs keep the revision they used.'
          : 'A context pack describes who is testing and under what conditions. Edits create a new revision.'}
      </p>
      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {saved && <div className="note ok" role="status">{saved}</div>}
      {recoveryDraft && recoveryDraft.id === draft?.id && <label className="field"><span>Unsaved draft</span><textarea readOnly value={recoveryDraft.json} /><small>Your previous edits are preserved here. Copy the changes you want into the latest revision below.</small></label>}
      <div className="grid2">
        <section className="panel" aria-label={isScenario ? 'Scenario list' : 'Context pack list'}>
          <div className="row" style={{ marginBottom: '.6rem' }}>
            <button type="button" onClick={startNew} disabled={saving}><Plus size={14} aria-hidden /> New</button>
            <button type="button" className="secondary" onClick={duplicate} disabled={!draft || saving}><Copy size={14} aria-hidden /> Duplicate</button>
          </div>
          {list.loading && !list.data && <Pending label="Loading…" />}
          {!list.loading && !list.error && items.length === 0 && <p className="muted">Nothing saved yet. Create one to get started.</p>}
          <ul className="list">
            {items.map(i => (
              <li key={i.id}>
                <button type="button" aria-pressed={selected === i.id} onClick={() => pick(i)} disabled={saving}>
                  <span>{i.label}<br /><span className="mono muted">{i.id}</span></span><span className="badge">rev {i.revision}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        {draft ? (
          <Editor key={`${selected}:${draft.revision}:${isNew}:${draft.id}`} kind={kind} base={draft} isNew={isNew}
            saving={saving} onSaving={setSaving}
            onReload={async previous => {
              const fresh = await (isScenario ? api.scenarios() : api.contexts());
              const latest = fresh.find(item => item.id === draft.id);
              if (!latest) throw new Error('This item no longer exists. Copy your draft before leaving.');
              setRecoveryDraft({ id: draft.id, json: previous }); list.setData(fresh); pick(latest);
            }}
            onSaved={async saved => { setRecoveryDraft(current => current?.id === saved.id ? null : current); await list.reload(); setSelected(saved.id); setDraft(saved); setIsNew(false); setSaved(`Saved "${saved.label}" as revision ${saved.revision}.`); }} />
        ) : <section className="panel muted">Select or create an item to edit.</section>}
      </div>
    </>
  );
}

function Editor({ kind, base, isNew, saving, onSaving, onReload, onSaved }: { kind: Kind; base: Item; isNew: boolean; saving: boolean; onSaving: (saving: boolean) => void; onReload: (draft: string) => Promise<void>; onSaved: (i: Item) => Promise<void> }) {
  const isScenario = kind === 'scenario';
  const [tab, setTab] = useState<Tab>('form');
  const [working, setWorking] = useState<Item>(base);
  const [id, setId] = useState(base.id);
  const [json, setJson] = useState(() => JSON.stringify(base, null, 2));
  const [apiError, setApiError] = useState<ApiFailure | null>(null);

  // Candidate built from the active tab
  const candidate: Parsed<Item> = useMemo(() => {
    if (tab === 'json') return isScenario ? parseScenarioJson(json) : parseContextJson(json);
    const withId = { ...working, id };
    return isScenario ? parseScenarioJson(JSON.stringify(withId)) : parseContextJson(JSON.stringify(withId));
  }, [tab, json, working, id, isScenario]);

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    if (next === 'json') setJson(JSON.stringify({ ...working, id }, null, 2));
    else {
      const parsed = isScenario ? parseScenarioJson(json) : parseContextJson(json);
      if (!parsed.ok) return; // keep user in JSON until it parses
      setWorking(parsed.value); setId(parsed.value.id);
    }
    setTab(next);
  };

  const save = async () => {
    if (saving || !candidate.ok) return;
    onSaving(true); setApiError(null);
    try {
      const v = candidate.value;
      let out: Item;
      if (isNew) out = isScenario ? await api.createScenario(v as ScenarioDefinition) : await api.createContext(v as ContextPack);
      else out = isScenario ? await api.updateScenario({ ...(v as ScenarioDefinition), id: base.id, revision: base.revision }) : await api.updateContext({ ...(v as ContextPack), id: base.id, revision: base.revision });
      await onSaved(out);
    } catch (e) {
      setApiError(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', String(e)));
    } finally { onSaving(false); }
  };

  const reloadLatest = async () => {
    onSaving(true);
    try { await onReload(tab === 'json' ? json : JSON.stringify({ ...working, id }, null, 2)); }
    catch (e) { setApiError(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', String(e))); }
    finally { onSaving(false); }
  };
  const stale = !isNew && apiError?.status === 409;
  return (
    <section className="panel" aria-label="Editor">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{isNew ? `New ${isScenario ? 'scenario' : 'context pack'}` : `${base.label} · revision ${base.revision}`}</h2>
      </div>
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="tabs" role="tablist" aria-label="Editor mode">
        <button type="button" role="tab" aria-selected={tab === 'form'} onClick={() => switchTab('form')}>Form</button>
        <button type="button" role="tab" aria-selected={tab === 'json'} onClick={() => switchTab('json')}>Full JSON</button>
      </div>
      {tab === 'form' && (
        <>
          <label className="field"><span>ID</span>
            <input value={id} onChange={e => setId(e.target.value)} readOnly={!isNew} aria-readonly={!isNew} className="mono" />
            <small>{isNew ? 'Letters, numbers, - and _ only. Cannot change after creation.' : 'Fixed after creation. Use Duplicate to make a new id.'}</small>
          </label>
          {isScenario
            ? <ScenarioFields value={working as ScenarioDefinition} onChange={setWorking} />
            : <ContextFields value={working as ContextPack} onChange={setWorking} />}
        </>
      )}
      {tab === 'json' && (
        <label className="field"><span>Full declarative definition</span>
          <textarea value={json} onChange={e => setJson(e.target.value)} spellCheck={false} aria-describedby="json-help" />
          <small id="json-help">Validated with the shared schema. Fix errors before switching back to the form.</small>
        </label>
      )}
      {!candidate.ok && (
        <div className="note bad" role="alert"><strong>Not valid yet</strong>
          <ul>{candidate.errors.slice(0, 8).map((m, i) => <li key={i}>{m}</li>)}</ul></div>
      )}
      {apiError && (stale
        ? <div className="note warn" role="alert">Someone saved a newer revision. Load it and re-apply your changes; your unsaved draft will be kept for reference. <button type="button" onClick={reloadLatest}>Load latest revision</button></div>
        : <ErrorNote error={apiError} />)}
      <button type="button" onClick={save} disabled={saving || !candidate.ok}>
        <Save size={14} aria-hidden /> {saving ? 'Saving…' : isNew ? 'Create' : 'Save as new revision'}
      </button>
      </fieldset>
    </section>
  );
}

function ScenarioFields({ value, onChange }: { value: ScenarioDefinition; onChange: (s: ScenarioDefinition) => void }) {
  // Loose edits: apply directly; schema validation happens in the candidate.
  const set = (patch: Partial<ScenarioDefinition>) => onChange({ ...value, ...patch });
  return (
    <>
      <label className="field"><span>Name</span><input value={value.label} onChange={e => set({ label: e.target.value })} /></label>
      <label className="field"><span>Goal</span>
        <textarea className="short" value={value.goal} onChange={e => set({ goal: e.target.value })} />
        <small>Plain-language task the tester is asked to complete.</small></label>
      <label className="field"><span>Entry path</span><input className="mono" value={value.entryPath} onChange={e => set({ entryPath: e.target.value })} />
        <small>Path on the demo app where the journey starts, e.g. /onboarding.</small></label>
      <label className="field"><span>Initial state</span><input className="mono" value={value.initialStateId} onChange={e => set({ initialStateId: e.target.value })} /></label>
      <h3>Inputs required</h3>
      <p className="muted">{Object.entries(value.inputSlots).map(([k, s]) => `${k} (${s.type}${s.required ? ', required' : ''})`).join(' · ') || 'None'}</p>
      <h3>Outcome contract ({value.contract.scope === 'ui_and_api' ? 'screen and saved data' : 'screen only'})</h3>
      <ul>
        {value.contract.assertions.map(a => (
          <li key={a.id}><span className="mono">{a.id}</span>{' '}
            {'locator' in a ? `expects ${a.kind === 'visible' ? 'visible' : 'field'} ${formatLocator(a.locator)}` : `checks stored ${a.path}`}
          </li>
        ))}
      </ul>
      <p className="muted">Edit inputs and assertions in the Full JSON tab.</p>
    </>
  );
}

function ContextFields({ value, onChange }: { value: ContextPack; onChange: (c: ContextPack) => void }) {
  const set = (patch: Partial<ContextPack>) => onChange({ ...value, ...patch });
  const num = (s: string) => (s === '' ? 0 : Number(s));
  const setInput = (k: string, raw: string) => {
    const old = value.inputs[k];
    let next: InputValue = raw;
    if (typeof old === 'number') next = Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : 0;
    if (typeof old === 'boolean') next = raw === 'true';
    set({ inputs: { ...value.inputs, [k]: next } });
  };
  const net = value.network;
  const [knownTerms, setKnownTerms] = useState(value.knownTerms.join(', '));
  return (
    <>
      <label className="field"><span>Name</span><input value={value.label} onChange={e => set({ label: e.target.value })} /></label>
      <div className="cols">
        <label className="field"><span>Viewport width (px)</span><input type="number" value={value.viewport.width} onChange={e => set({ viewport: { ...value.viewport, width: num(e.target.value) } })} /></label>
        <label className="field"><span>Viewport height (px)</span><input type="number" value={value.viewport.height} onChange={e => set({ viewport: { ...value.viewport, height: num(e.target.value) } })} /></label>
        <label className="field"><span>Locale</span><input value={value.locale} onChange={e => set({ locale: e.target.value })} /><small>Browser locale, e.g. en-IN. Does not translate the app.</small></label>
        <label className="field"><span>Preferred language</span><input value={value.preferredLanguage} onChange={e => set({ preferredLanguage: e.target.value })} /><small>Guidance only.</small></label>
        <label className="field"><span>Familiarity</span>
          <select value={value.familiarity} onChange={e => set({ familiarity: e.target.value as ContextPack['familiarity'] })}>
            <option value="first_time">First-time seller</option><option value="experienced">Experienced seller</option></select><small>Declared knowledge; behavioral simulation.</small></label>
        <label className="field"><span>Interaction</span>
          <select value={value.interaction} onChange={e => set({ interaction: e.target.value as ContextPack['interaction'] })}>
            <option value="pointer">Pointer</option><option value="keyboard_only">Keyboard only</option></select></label>
        <label className="field"><span>Motion preference</span>
          <select value={value.reducedMotion} onChange={e => set({ reducedMotion: e.target.value as ContextPack['reducedMotion'] })}>
            <option value="no-preference">No preference</option><option value="reduce">Reduce motion</option></select></label>
        <label className="field"><span>Network</span>
          <select value={net.mode} onChange={e => set({ network: e.target.value === 'normal' ? { mode: 'normal' } : { mode: 'request_delay', delayMs: 1000, pathPrefix: '/api' } })}>
            <option value="normal">Normal</option><option value="request_delay">Delay requests</option></select></label>
        {net.mode === 'request_delay' && (<>
          <label className="field"><span>Delay (ms)</span><input type="number" value={net.delayMs} onChange={e => set({ network: { ...net, delayMs: num(e.target.value) } })} /></label>
          <label className="field"><span>Delay requests under path</span><input className="mono" value={net.pathPrefix} onChange={e => set({ network: { ...net, pathPrefix: e.target.value } })} /><small>Injected delay, not bandwidth shaping.</small></label>
        </>)}
      </div>
      <label className="field"><span>Known terms</span>
        <input value={knownTerms} onChange={e => { setKnownTerms(e.target.value); set({ knownTerms: e.target.value.split(',').map(t => t.trim()).filter(Boolean) }); }} />
        <small>Comma separated vocabulary this person already understands.</small></label>
      <h3>Input values</h3>
      {Object.keys(value.inputs).length === 0 && <p className="muted">No input values.</p>}
      <div className="cols">
        {Object.entries(value.inputs).map(([k, v]) => typeof v === 'object'
          ? <div key={k} className="field"><span>{k}</span><small>Fixture file: {v.fixtureId} (edit in Full JSON)</small></div>
          : <label key={k} className="field"><span>{k}</span>
              {typeof v === 'boolean'
                ? <select value={String(v)} onChange={e => setInput(k, e.target.value)}><option value="true">true</option><option value="false">false</option></select>
                : <input type={typeof v === 'number' ? 'number' : 'text'} value={String(v)} onChange={e => setInput(k, e.target.value)} />}
            </label>)}
      </div>
    </>
  );
}
