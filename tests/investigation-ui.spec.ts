import {test,expect} from '@playwright/test';
import {storeScenario,desktopContext} from '../packages/contracts/src/examples';
const base={scenario:storeScenario,context:desktopContext,inputs:{storeName:'Siri Crafts'},status:'completed',createdAt:new Date().toISOString(),manifestHash:'manifest',executionMode:'ai_guided',steps:[],assertions:[],capabilities:[],artifacts:[],evidence:{buildId:'build',scenarioHash:'scenario',policyVersion:'v1',model:'model',modelCalls:3,actions:[],finishedByAgent:true}};
test('failed run offers a passing control and displays real comparison rows',async({page})=>{
 const target={...base,id:'target',verdict:'failed',findings:[{kind:'api_or_outcome_failure',description:'Outcome mismatch',evidencePaths:[]}]};
 const control={...base,id:'control',verdict:'passed',findings:[]};
 let launched=false;
 await page.route('**/api/runner/runs/target',r=>r.fulfill({json:target}));
 await page.route('**/api/runner/runs',r=>r.fulfill({json:[target,control]}));
 await page.route('**/api/runner/investigations',r=>{
  if(r.request().method()==='POST'){launched=true;return r.fulfill({status:202,json:{id:'comparison',status:'queued'}});}
  return r.fulfill({json:launched?[{id:'comparison',status:'completed',request:{targetRunId:'target'},result:{conclusion:'reproducible_failure',isolationStatus:'isolated',likelyTriggers:['viewport'],attemptsUsed:6,maxAttempts:6,untestedFactors:[],message:'Matched comparison complete',trials:[{role:'candidate',factor:'viewport',repeat:1,run:control}]}}]:[]});
 });
 await page.goto('/runs/target');
 await page.getByRole('combobox',{name:'Passing control'}).selectOption('control');
 await page.getByRole('button',{name:'Investigate differences'}).click();
 await expect(page.getByText('reproducible failure',{exact:true})).toBeVisible();
 await expect(page.getByText('Matched comparison complete')).toBeVisible();
});

test('passing journey can be replayed under another saved context',async({page})=>{
 const control={...base,id:'control',verdict:'passed',findings:[]};
 await page.route('**/api/runner/runs/control',r=>r.fulfill({json:control}));
 await page.route('**/api/runner/context-packs',r=>r.fulfill({json:[{...desktopContext,id:'another',label:'Another seller'}]}));
 await page.route('**/api/runner/runs/control/replay',r=>r.fulfill({status:202,json:{id:'replayed',status:'queued'}}));
 await page.goto('/runs/control');
 await page.getByRole('combobox',{name:'Replay context'}).selectOption('another');
 await page.getByRole('button',{name:'Replay this path'}).click();
 await expect(page).toHaveURL(/\/runs\/replayed$/);
});
