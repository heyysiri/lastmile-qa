import {afterEach,describe,it,expect,vi} from 'vitest';
import {createPersistentSessionPreparer} from '../apps/runner/src/persistent-session';
import {desktopContext,storeScenario} from '../packages/contracts/src/examples';
import type {EvidenceRun} from '../packages/contracts/src/runtime';
function run():EvidenceRun{return {id:'run-1',requestId:'request',scenario:structuredClone(storeScenario),context:structuredClone(desktopContext),inputs:{storeName:'Tea'},status:'running',verdict:null,createdAt:'now',manifestHash:'hash',executionMode:'ai_guided',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[],continuity:{populationId:'population',testerId:'tester',initialStateId:'seller-fresh',workflowId:'store-setup',mode:'continue',history:[],preserveStatePaths:['inventory.0.quantity']}};}
const cookie={name:'session',value:'private-cookie',path:'/'};
const setup={namespaceId:'account-1',cookie};
const checkpoint={id:'checkpoint-1',digest:'digest-1',state:{namespaceId:'account-1',inventory:[{quantity:250}]}};
afterEach(()=>vi.unstubAllGlobals());
describe('persistent session trust boundary',()=>{
 it('reopens a stable account, snapshots before acting and freezes preservation checks',async()=>{
  const fetcher=vi.fn(async(url:URL,_init?:RequestInit)=>Response.json(url.pathname.endsWith('/session')?setup:checkpoint));vi.stubGlobal('fetch',fetcher);
  const input=run();const prepared=await createPersistentSessionPreparer({origin:'http://localhost:3001',testToken:'private-token'})(input,AbortSignal.timeout(1000));
  expect(prepared).toEqual(setup);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({accountKey:'population:tester',fixtureId:'seller-fresh'});
  expect(input.continuity?.startCheckpoint).toEqual({id:'checkpoint-1',digest:'digest-1'});
  expect(input.scenario.contract.assertions).toContainEqual({id:'preserve-0',kind:'state_equals',path:'inventory.0.quantity',expected:{literal:250}});
  expect(JSON.stringify(input)).not.toMatch(/private-cookie|private-token/);
 });
 it('clones only the frozen checkpoint and rejects a changed digest',async()=>{
  const fetcher=vi.fn(async(_url:URL,_init?:RequestInit)=>Response.json({...setup,digest:'digest-1'}));vi.stubGlobal('fetch',fetcher);
  const input=run();input.continuity!.mode='checkpoint';input.continuity!.startCheckpoint={id:'checkpoint-1',digest:'digest-1'};
  const original=structuredClone(input);
  const prepare=createPersistentSessionPreparer({origin:'http://localhost:3001',testToken:'private-token'});
  await prepare(input,AbortSignal.timeout(1000));
  expect(fetcher).toHaveBeenCalledTimes(1);expect(String(fetcher.mock.calls[0][0])).toContain('/checkpoints/checkpoint-1/clone');expect(input).toEqual(original);
  fetcher.mockResolvedValue(Response.json({...setup,digest:'different'}));
  await expect(prepare(input,AbortSignal.timeout(1000))).rejects.toThrow(/checkpoint/i);
 });
 it.each([{...checkpoint,state:{namespaceId:'wrong',inventory:[{quantity:250}]}},{...checkpoint,state:{namespaceId:'account-1',inventory:[]}}])('rejects missing or mismatched trusted state',async(value)=>{
  vi.stubGlobal('fetch',vi.fn(async(url:URL,_init?:RequestInit)=>Response.json(url.pathname.endsWith('/session')?setup:value)));
  await expect(createPersistentSessionPreparer({origin:'http://localhost:3001',testToken:'token'})(run(),AbortSignal.timeout(1000))).rejects.toThrow();
 });
 it('does not follow service redirects or omit authentication and cancellation',async()=>{
  const fetcher=vi.fn(async(_url:URL,_init?:RequestInit)=>new Response('',{status:403}));vi.stubGlobal('fetch',fetcher);
  await expect(createPersistentSessionPreparer({origin:'http://localhost:3001',testToken:'private-token'})(run(),AbortSignal.timeout(1000))).rejects.toThrow(/403/);
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{authorization:'Bearer private-token'},signal:expect.any(AbortSignal)});
 });
});
