import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { compileInputs, type RunRecord } from '@lastmile/contracts';
import type { EvidenceRun, ReplayPlan } from '@lastmile/contracts/runtime';
import { createBrowserSession, replayPosition, type BrowserSession } from './browser';
import { runAgent } from './agent';
import { verifyOutcome } from './verifier';
import { executeReplay, buildReplay } from './replay';
import { hashValue, writeArtifactManifest } from './artifacts';
import { classifyOutcome } from './outcome';

export type JourneyOptions = { origin:string;artifactRoot:string;testToken:string;apiKey?:string;model:string };
export function createJourneyExecutor(options:JourneyOptions) {
  const origin=new URL(options.origin).origin;
  return async (input:RunRecord,onUpdate:(run:RunRecord)=>void,replay?:ReplayPlan):Promise<EvidenceRun> => {
    const run:EvidenceRun=structuredClone(input);
    const directory=resolve(options.artifactRoot,run.id);
    if(!/^[a-zA-Z0-9_-]+$/.test(run.id)) throw new Error('Invalid run ID');
    await mkdir(directory,{recursive:true});
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),180_000);
    const signal=controller.signal;
    let session:BrowserSession|undefined;
    let complete=false;
    let failure:'environment_failure'|'agent_error'|'replay_mismatch'|undefined;
    let message='';
    async function trusted(path:string,body?:unknown) {
      const response=await fetch(new URL(path,origin),{method:body?'POST':'GET',redirect:'error',headers:{authorization:`Bearer ${options.testToken}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)])});
      if(!response.ok) throw new Error(`Test service returned HTTP ${response.status}`);
      return response.json();
    }
    try {
      run.inputs=compileInputs(run.scenario,run.context);
      if(Object.values(run.inputs).some(v=>typeof v==='object')) throw new Error('File fixtures are not registered');
      const build=await trusted('/api/test/build');
      if(typeof build.buildId!=='string'||!build.buildId) throw new Error('Missing build identity');
      if(run.expectedBuildId&&run.expectedBuildId!==build.buildId) throw new Error('Queued build changed');
      run.evidence={buildId:build.buildId,scenarioHash:hashValue(run.scenario),policyVersion:'browser-v1',model:replay?'none':options.model,actions:[],modelCalls:0,finishedByAgent:false,...(replay?{replayHash:replay.hash,replayCompatible:false}:{})};
      const setup=await trusted('/api/test/sessions',{fixtureId:run.scenario.initialStateId});
      if(typeof setup.namespaceId!=='string'||typeof setup.cookie?.value!=='string'||typeof setup.cookie?.name!=='string') throw new Error('Invalid test session');
      run.namespaceId=setup.namespaceId;
      session=await createBrowserSession({pack:run.context,inputs:run.inputs,origin,cookie:setup.cookie,artifactDirectory:directory,signal,onStep:step=>{
        run.steps.push({...step,screenshot:step.screenshot?`${run.id}/${step.screenshot}`:undefined});
        onUpdate(structuredClone(run));
      }});
      if(replay) {
        const result=await executeReplay(replay,run,action=>session!.execute(action),()=>replayPosition(session!.page));
        complete=result.compatible; run.evidence.replayCompatible=result.compatible;
        if(!complete){failure='replay_mismatch';message=result.message||'Replay actions were incompatible with this context';}
      } else {
        await session.execute({tool:'navigate',path:run.scenario.entryPath});
        const result=await runAgent(session,run,{apiKey:options.apiKey,model:options.model,signal});
        complete=result.finished;run.evidence.modelCalls=result.modelCalls;run.evidence.finishedByAgent=result.finished;
        if(!complete){failure='agent_error';message=result.reason;}
      }
      if(!signal.aborted) run.assertions=await verifyOutcome({page:session.page,contract:run.scenario.contract,inputs:run.inputs,timeoutMs:2000,signal,readState:async()=>{
        const state=await trusted(`/api/test/state?namespaceId=${encodeURIComponent(run.namespaceId!)}`);
        if(state.namespaceId!==run.namespaceId) throw new Error('Readback namespace mismatch');
        await writeFile(join(directory,'readback.json'),JSON.stringify(state,null,2));
        return state;
      }});
      const after=await trusted('/api/test/build');
      if(after.buildId!==run.evidence.buildId) {complete=false;failure='environment_failure';message='The served build changed during the run';}
      run.capabilities=structuredClone(session.capabilities);
      run.evidence.actions=structuredClone(session.actions);
      if(run.context.network.mode==='request_delay'&&!run.capabilities.some(c=>c.factor==='network'&&c.status==='applied')) {
        complete=false;failure='environment_failure';message='Requested network delay was not exercised';
      }
    } catch {
      complete=false; failure=failure||'environment_failure';
      message=signal.aborted?'Journey time budget exhausted':'Journey setup or execution failed; inspect the recorded steps and service configuration';
    } finally {
      if(session) {
        run.capabilities=structuredClone(session.capabilities);
        if(run.evidence)run.evidence.actions=structuredClone(session.actions);
        try{await session.close();}catch{complete=false;failure='environment_failure';message='Browser evidence could not be finalized';}
      }
      clearTimeout(timer);
    }
    run.status='completed';run.finishedAt=new Date().toISOString();
    run.verdict=classifyOutcome(run.assertions,complete);
    if(failure)run.findings.push({kind:failure,description:message,evidencePaths:[]});
    else if(run.verdict==='failed')run.findings.push({kind:'api_or_outcome_failure',description:'Independent outcome checks did not match the configured task requirements.',evidencePaths:[`${run.id}/assertions.json`]});
    else if(run.verdict==='inconclusive')run.findings.push({kind:'environment_failure',description:'One or more independent checks could not be evaluated.',evidencePaths:[]});
    if(replay) await writeFile(join(directory,'replay.json'),JSON.stringify(replay,null,2));
    else if(run.verdict==='passed') await writeFile(join(directory,'replay.json'),JSON.stringify(buildReplay(run),null,2));
    await writeFile(join(directory,'assertions.json'),JSON.stringify(run.assertions,null,2));
    await writeFile(join(directory,'run.json'),JSON.stringify(run,null,2));
    const manifest=await writeArtifactManifest(directory);
    run.artifactManifestHash=hashValue(manifest);
    run.artifacts=manifest.map(a=>`${run.id}/${a.name}`);
    return run;
  };
}
