import {it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {OpenAIModel} from '@strands-agents/sdk/models/openai';
import type {ModelStreamEvent} from '@strands-agents/sdk';
import {createJourneyExecutor} from '../apps/runner/src/journey';
import {createPersistentSessionPreparer} from '../apps/runner/src/persistent-session';
import {buildReplay} from '../apps/runner/src/replay';
import {desktopContext,inventoryScenario,storeScenario} from '../packages/contracts/src/examples';
import type {EvidenceRun} from '../packages/contracts/src/runtime';
function* calls(...steps:[string,unknown][]):Generator<ModelStreamEvent>{
 yield {type:'modelMessageStartEvent',role:'assistant'};
 for(const [i,[name,input]] of steps.entries()){
  yield {type:'modelContentBlockStartEvent',start:{type:'toolUseStart',name,toolUseId:`tool-${i}`}};
  yield {type:'modelContentBlockDeltaEvent',delta:{type:'toolUseInputDelta',input:JSON.stringify(input)}};
  yield {type:'modelContentBlockStopEvent'};
 }
 yield {type:'modelMessageStopEvent',stopReason:'toolUse'};
}
it('uses a real persistent seller account, freezes stock preservation and replays into an isolated checkpoint clone',async()=>{
 const origin='http://127.0.0.1:3001',testToken=process.env.TEST_API_TOKEN||'local-development-test';
 const directory=await mkdtemp(join(tmpdir(),'persistent-browser-'));
 const populationId=randomUUID();
 const execute=createJourneyExecutor({origin,testToken,artifactRoot:directory,apiKey:'fake-provider-key',model:'synthetic',prepareSession:createPersistentSessionPreparer({origin,testToken})});
 function run(inventory:boolean):EvidenceRun{
  const scenario=structuredClone(inventory?inventoryScenario:storeScenario);
  const inputs:EvidenceRun['inputs']=inventory?{quantity:250}:{storeName:'Returning browser shop'};
  return {id:randomUUID(),requestId:randomUUID(),scenario,inputs,context:{...desktopContext,inputs},status:'running',verdict:null,createdAt:new Date().toISOString(),manifestHash:'integration',executionMode:'ai_guided',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[],continuity:{populationId,testerId:'returning',mode:'continue',initialStateId:'active-seller',workflowId:scenario.id,history:[],preserveStatePaths:inventory?[]:['inventory.0.quantity']}};
 }
 let inventory=true;
 const stream=vi.spyOn(OpenAIModel.prototype,'stream').mockImplementation(async function*(){
  yield* calls(['fill',{locator:{by:'label',value:inventory?'Stock quantity for Cotton scarf':'Store name'},value:{input:inventory?'quantity':'storeName'}}],['click',{locator:{by:'role',value:'button',name:inventory?'Save inventory':'Save store'}}],['finish',{status:'done'}]);
 });
 try{
  const first=await execute(run(true),()=>{});expect(first.verdict).toBe('passed');
  inventory=false;
  const baseline=await execute(run(false),()=>{});expect(baseline.verdict).toBe('passed');expect(baseline.namespaceId).toBe(first.namespaceId);
  expect(baseline.assertions.find(a=>a.id==='preserve-0')).toMatchObject({status:'passed',actual:250,expected:250});
  const replay=buildReplay(baseline);
  const comparison:EvidenceRun={...structuredClone(baseline),id:randomUUID(),requestId:randomUUID(),status:'running',verdict:null,executionMode:'deterministic',evidence:undefined,steps:[],assertions:[],findings:[],artifacts:[],continuity:{...baseline.continuity!,mode:'checkpoint'}};
  const callsBefore=stream.mock.calls.length;
  const result=await execute(comparison,()=>{},replay);
  expect(result.verdict).toBe('passed');expect(result.evidence?.replayCompatible).toBe(true);expect(result.namespaceId).not.toBe(baseline.namespaceId);expect(result.evidence?.modelCalls).toBe(0);expect(stream.mock.calls.length).toBe(callsBefore);
  const original=await fetch(`${origin}/api/test/state?namespaceId=${baseline.namespaceId}`,{headers:{authorization:`Bearer ${testToken}`}}).then(r=>r.json());
  expect(original.inventory[0].quantity).toBe(250);expect(original.store.name).toBe('Returning browser shop');
 }finally{stream.mockRestore();await rm(directory,{recursive:true,force:true});}
},45000);
