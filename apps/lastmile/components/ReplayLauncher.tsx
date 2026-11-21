'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {EvidenceRun} from '@lastmile/contracts/runtime';
import {api,ApiFailure,useLoad} from '../lib/api';
import {newRequestId} from '../lib/editor';
import {ErrorNote} from './ui';

export function ReplayLauncher({run}:{run:EvidenceRun}){
 const contexts=useLoad(api.contexts,[]),router=useRouter();
 const [contextId,setContextId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<ApiFailure|null>(null);
 const pending=useRef<{requestId:string;contextPackId:string;contextRevision:number}|null>(null);
 async function replay(){
  const context=contexts.data?.find(c=>c.id===contextId);if(!context||busy)return;
  pending.current??={requestId:newRequestId(),contextPackId:context.id,contextRevision:context.revision};setBusy(true);setError(null);
  try{const result=await api.replay(run.id,pending.current);router.push(`/runs/${result.id}`);}
  catch(e){setError(e instanceof ApiFailure?e:new ApiFailure(0,'unknown','Could not start replay'));setBusy(false);}
 }
 return <section className="panel"><h2>Replay under another context</h2>
  <p className="muted">Use this observed path with fresh seller state and no model calls. Incompatible controls or navigation produce an inconclusive replay, not a product defect.</p>
  <label className="field"><span>Replay context</span><select disabled={busy} value={contextId} onChange={e=>{setContextId(e.target.value);pending.current=null;}}><option value="">Select a saved context</option>{contexts.data?.map(c=><option key={c.id} value={c.id}>{c.label} (rev {c.revision})</option>)}</select></label>
  <ErrorNote error={error||contexts.error}/><button type="button" disabled={busy||!contextId} onClick={replay}>{busy?'Starting replay…':'Replay this path'}</button>
 </section>;
}
