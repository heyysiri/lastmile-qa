import {it,expect} from 'vitest';
import {openRunStore} from '../apps/runner/src/store';
import type {EvidenceRun} from '../packages/contracts/src/runtime';
it('persists execution evidence and keeps terminal trial records immutable',()=>{
 const store=openRunStore(':memory:');
 try{
  const run=store.enqueue({requestId:'evidence',scenarioId:'store-setup',scenarioRevision:1,contextPackId:'desktop-seller',contextRevision:1},'http://localhost:3001');
  const active=store.claimNext()!;
  const evidence={buildId:'hash',scenarioHash:'schema',policyVersion:'v1',model:'model',actions:[],modelCalls:2,finishedByAgent:true};
  store.updateRun({...active,status:'completed',verdict:'passed',evidence} as EvidenceRun);
  expect((store.getRun(run.id) as EvidenceRun).evidence).toEqual(evidence);
 }finally{store.close();}
});
it('stores idempotent queued investigations and recovers interrupted work',()=>{
 const store=openRunStore(':memory:');
 try{
  const request={requestId:'investigate',targetRunId:'target',controlRunId:'control',factors:['network' as const],maxAttempts:6};
  const record=store.enqueueInvestigation(request);
  expect(store.enqueueInvestigation(request).id).toBe(record.id);
  expect(()=>store.enqueueInvestigation({...request,maxAttempts:8})).toThrow();
  expect(store.claimInvestigation()?.status).toBe('running');
  store.recoverInterrupted();
  expect(store.getInvestigation(record.id)?.status).toBe('interrupted');
 }finally{store.close();}
});

it('queues a replay with frozen source and context and deduplicates retries',()=>{
 const store=openRunStore(':memory:');
 try {
  const source=store.enqueue({requestId:'source',scenarioId:'store-setup',scenarioRevision:1,contextPackId:'desktop-seller',contextRevision:1},'http://localhost:3001') as EvidenceRun;
  store.claimNext();store.updateRun({...source,status:'completed',verdict:'passed'});
  const context=store.contextPacks.get('mobile-seller',1)!;
  const plan={version:1 as const,hash:'replay-hash',sourceRunIds:[source.id],scenarioHash:'scenario',buildId:'build',actions:[]};
  const replay=store.enqueueReplay('replay-request',source,context,plan);
  expect(replay).toMatchObject({executionMode:'deterministic',context,replay:plan,status:'queued',steps:[]});
  expect(store.enqueueReplay('replay-request',source,context,plan).id).toBe(replay.id);
  expect(()=>store.enqueueReplay('replay-request',source,{...context,revision:2},plan)).toThrow();
 }finally{store.close();}
});
