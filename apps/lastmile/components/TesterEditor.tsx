import { CheckCircle2 } from 'lucide-react';
import type { ContextPack, InputValue } from '@lastmile/contracts';
import type { StudyApplication, StudyUser } from '@lastmile/contracts/studies';
import { ExpectedChecks, fieldName } from './RunEvidence';
import { TesterFace } from './Studio';

export function TesterEditor({ user, index, application, disabled, onChange }: {
  user: StudyUser; index: number; application?: StudyApplication; disabled: boolean; onChange: (patch: Partial<StudyUser>) => void;
}) {
  const workflow = application?.workflows.find(item => item.id === user.workflowId);
  const context = user.context;
  const delay = context.network.mode === 'request_delay' ? context.network : undefined;
  const changeContext = (patch: Partial<ContextPack>) => onChange({ context: { ...context, ...patch } });

  function changeInput(id: string, value: InputValue | undefined) {
    const inputs = { ...context.inputs };
    if (value === undefined) delete inputs[id];
    else inputs[id] = value;
    changeContext({ inputs });
  }

  return <article className={`studio-card tester-editor tone-${index % 3}`} aria-labelledby={`tester-${user.id}`}>
    <header className="tester-heading">
      <TesterFace index={index} />
      <div>
        <h3 id={`tester-${user.id}`}>{user.name.trim() || 'Unnamed tester'}</h3>
        <p>{context.familiarity === 'first_time' ? 'First-time user' : 'Experienced user'} · {context.viewport.width} × {context.viewport.height} · {context.interaction === 'keyboard_only' ? 'Keyboard only' : 'Pointer'}</p>
      </div>
    </header>

    <fieldset className="plain-fieldset" disabled={disabled}>
      <div className="studio-fields">
        <label className="field"><span>Name</span><input required maxLength={80} value={user.name} onChange={event => onChange({ name: event.target.value })} /></label>
        <label className="field"><span>Workflow</span><select value={user.workflowId} disabled={!application?.workflows.length} onChange={event => {
          const next = application?.workflows.find(item => item.id === event.target.value);
          if (next) onChange({ workflowId: next.id, goal: next.scenario.goal, context: { ...context, inputs: { ...next.defaultInputs } } });
        }}>
          {!workflow && <option value={user.workflowId}>Workflow unavailable</option>}
          {application?.workflows.map(item => <option key={item.id} value={item.id}>{item.scenario.label}</option>)}
        </select><small>Changing workflows loads its default goal and inputs.</small></label>
      </div>
      <label className="field"><span>Situation</span><textarea className="short compact" required maxLength={1000} value={user.summary} onChange={event => onChange({ summary: event.target.value })} /></label>
      <label className="field"><span>Goal</span><textarea className="short compact" required minLength={5} maxLength={2000} value={user.goal} onChange={event => onChange({ goal: event.target.value })} /></label>
      <label className="field"><span>Why this tester matters</span><textarea className="short compact" required maxLength={1000} value={user.coverageReason} onChange={event => onChange({ coverageReason: event.target.value })} /></label>

      {workflow && <section className="checks-preview" aria-label="Success checks">
        {Object.entries(workflow.scenario.inputSlots).map(([id, slot]) => {
          const value = context.inputs[id];
          return <label className="field" key={id}><span>{fieldName(id)}</span>
            {slot.type === 'file' ? <small>File fixtures are unavailable.</small> : slot.type === 'boolean' ?
              <select required={slot.required} value={typeof value === 'boolean' ? String(value) : ''} onChange={event => changeInput(id, event.target.value === '' ? undefined : event.target.value === 'true')}>
                <option value="">Choose a value</option><option value="true">Yes</option><option value="false">No</option>
              </select> :
              <input required={slot.required} type={slot.type} step={slot.type === 'number' ? 'any' : undefined}
                value={typeof value === 'number' || typeof value === 'string' ? value : ''}
                onChange={event => changeInput(id, slot.type === 'text' ? event.target.value : event.target.value === '' ? undefined : event.target.valueAsNumber)} />}
          </label>;
        })}
        <h4><CheckCircle2 size={16} aria-hidden="true" /> How we’ll check success</h4>
        <ExpectedChecks scenario={workflow.scenario} inputs={context.inputs} />
      </section>}

      <details className="studio-disclosure">
        <summary>Tester context and assumptions</summary>
        <div className="studio-fields">
          <label className="field"><span>Screen width</span><input type="number" min={320} max={2560} required value={context.viewport.width || ''} onChange={event => changeContext({ viewport: { ...context.viewport, width: Number(event.target.value) } })} /></label>
          <label className="field"><span>Screen height</span><input type="number" min={480} max={1600} required value={context.viewport.height || ''} onChange={event => changeContext({ viewport: { ...context.viewport, height: Number(event.target.value) } })} /></label>
          <label className="field"><span>Familiarity</span><select value={context.familiarity} onChange={event => changeContext({ familiarity: event.target.value as ContextPack['familiarity'] })}>
            <option value="first_time">First-time user</option><option value="experienced">Experienced user</option>
          </select></label>
          <label className="field"><span>Interaction</span><select value={context.interaction} onChange={event => changeContext({ interaction: event.target.value as ContextPack['interaction'] })}>
            <option value="pointer">Pointer</option><option value="keyboard_only">Keyboard only</option>
          </select></label>
          <label className="field"><span>Browser locale</span><input required value={context.locale} onChange={event => changeContext({ locale: event.target.value })} /></label>
          <label className="field"><span>Preferred language</span><input required maxLength={80} value={context.preferredLanguage} onChange={event => changeContext({ preferredLanguage: event.target.value })} /></label>
          <label className="field"><span>Motion preference</span><select value={context.reducedMotion} onChange={event => changeContext({ reducedMotion: event.target.value as ContextPack['reducedMotion'] })}>
            <option value="no-preference">Default</option><option value="reduce">Reduced motion</option>
          </select></label>
          <label className="field"><span>Network</span><select value={context.network.mode} onChange={event => changeContext({ network: event.target.value === 'normal' ? { mode: 'normal' } : { mode: 'request_delay', delayMs: 300, pathPrefix: '/' } })}>
            <option value="normal">Normal</option><option value="request_delay">Add request delay</option>
          </select></label>
          {delay && <>
            <label className="field"><span>Delay (ms)</span><input type="number" min={0} max={3000} required value={delay.delayMs} onChange={event => changeContext({ network: { ...delay, delayMs: Number(event.target.value) } })} /></label>
            <label className="field"><span>Request path prefix</span><input required value={delay.pathPrefix} onChange={event => changeContext({ network: { ...delay, pathPrefix: event.target.value } })} /></label>
          </>}
        </div>
        <p className="field-hint">Familiarity and language guide the tester. Browser locale sets browser preferences and the app controls its own translations.</p>
        <label className="field"><span>Known terms</span><textarea className="short compact" placeholder="One term per line" value={context.knownTerms.join('\n')} onChange={event => changeContext({ knownTerms: event.target.value.split('\n') })} /></label>
        <label className="field"><span>Tester assumptions</span><textarea className="short compact" placeholder="One assumption per line" value={user.assumptions.join('\n')} onChange={event => onChange({ assumptions: event.target.value.split('\n') })} /></label>
      </details>
    </fieldset>
  </article>;
}
