'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { EvidenceRun, InvestigationFactor, InvestigationRecord, InvestigationRequest } from '@lastmile/contracts/runtime';
import { api, ApiFailure, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { ErrorNote, StatusBadge } from './ui';

export function InvestigationPanel({run}:{run:EvidenceRun}) {
  const runs=useLoad(api.runs,[]);
  const [jobs,setJobs]=useState<InvestigationRecord[]>([]);
  const [controlId,setControlId]=useState('');
  const [factors,setFactors]=useState<InvestigationFactor[]>([...run.scenario.investigation.factors]);
  const [budget,setBudget]=useState(run.scenario.investigation.maxAttempts);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<ApiFailure|null>(null);
  const pending=useRef<InvestigationRequest|null>(null);
  const controls=(runs.data||[]).filter(r=>r.verdict==='passed'&&r.evidence&&r.evidence.buildId===run.evidence?.buildId&&r.evidence.scenarioHash===run.evidence?.scenarioHash&&r.evidence.finishedByAgent);
  useEffect(()=>{
    let stop=false; let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      try {const all=await api.investigations();if(!stop)setJobs(all.filter(j=>j.request.targetRunId===run.id));}
      catch(e){if(!stop)setError(e instanceof ApiFailure?e:new ApiFailure(0,'unknown','Could not load comparisons'));}
      if(!stop)timer=setTimeout(()=>void tick(),2000);
    };
    void tick();return()=>{stop=true;clearTimeout(timer);};
  },[run.id]);
  async function launch(){
    if(busy||!controlId||!factors.length)return;
    setBusy(true);setError(null);
    pending.current??={requestId:newRequestId(),targetRunId:run.id,controlRunId:controlId,factors,maxAttempts:budget};
    try {await api.investigate(pending.current);pending.current=null;setJobs((await api.investigations()).filter(j=>j.request.targetRunId===run.id));}
    catch(e){setError(e instanceof ApiFailure?e:new ApiFailure(0,'unknown','Could not start comparison'));}
    finally{setBusy(false);}
  }
  return <section className="panel"><h2>Investigate context differences</h2>
    <p className="muted">Replay a passing path under each context twice, then change one selected factor at a time. Every trial uses fresh seller state and independent outcome checks.</p>
    <fieldset disabled={busy} style={{border:0,padding:0,minWidth:0}}>
      <label className="field"><span>Passing control</span><select value={controlId} onChange={e=>{setControlId(e.target.value);pending.current=null;}}><option value="">Select a matching passed run</option>{controls.map(r=><option key={r.id} value={r.id}>{r.context.label} · {r.id.slice(0,8)}</option>)}</select></label>
      {!controls.length&&<p className="muted">First run the same scenario successfully on this build. Guidance settings must match; only selected factors may differ.</p>}
      <div className="row">{run.scenario.investigation.factors.map(f=><label key={f}><input type="checkbox" checked={factors.includes(f)} onChange={e=>{setFactors(e.target.checked?[...factors,f]:factors.filter(x=>x!==f));pending.current=null;}}/> {f}</label>)}</div>
      <label className="field"><span>Replay attempt limit</span><input type="number" min={4} max={run.scenario.investigation.maxAttempts} value={budget} onChange={e=>{setBudget(Number(e.target.value));pending.current=null;}}/></label>
      <button type="button" disabled={!controlId||!factors.length||budget<4||budget>run.scenario.investigation.maxAttempts} onClick={launch}>{busy?'Starting comparison…':'Investigate differences'}</button>
    </fieldset>
    <ErrorNote error={error||runs.error}/>
    {jobs.map(job=><section key={job.id} style={{marginTop:'1rem'}}>
      <h3>Comparison {job.id.slice(0,8)} <StatusBadge value={job.status}/></h3>
      {job.error&&<p role="alert">{job.error}</p>}
      {job.result&&<><p><StatusBadge value={job.result.conclusion.replaceAll('_',' ')}/> Isolation: {job.result.isolationStatus}. Attempts: {job.result.attemptsUsed}/{job.result.maxAttempts}.</p>
        <p>{job.result.message}</p><p>Supported contributing conditions: {job.result.likelyTriggers.join(', ')||'None established'}</p>
        {!!job.result.untestedFactors.length&&<p>Untested: {job.result.untestedFactors.join(', ')}</p>}
        <div style={{overflowX:'auto'}}><table><thead><tr><th>Trial</th><th>Changed factor</th><th>Repeat</th><th>Verdict</th><th>Evidence</th></tr></thead><tbody>{job.result.trials.map(t=><tr key={t.run.id}><td>{t.role}</td><td>{t.factor||'Reference context'}</td><td>{t.repeat}</td><td><StatusBadge value={t.run.verdict}/></td><td><Link href={`/runs/${t.run.id}`}>Open run</Link></td></tr>)}</tbody></table></div>
      </>}
    </section>)}
  </section>;
}
