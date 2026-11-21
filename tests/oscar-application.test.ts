import {expect,it} from 'vitest';
import {createOscarApplication,validateOscarInputs} from '../apps/runner/src/oscar-application';
import {desktopContext} from '../packages/contracts/src/examples';
import {compileStudyUser} from '../packages/contracts/src/studies';
it('registers upstream profile and basket workflows with independent preserved state',()=>{
 const app=createOscarApplication('http://127.0.0.1:8000');
 expect(app.workflows).toHaveLength(3);
 for(const workflow of app.workflows){
  const user={id:'user',name:'Alex',summary:'Customer',coverageReason:'Retained basket',assumptions:[],workflowId:workflow.id,goal:workflow.scenario.goal,context:{...desktopContext,inputs:workflow.defaultInputs}};
  expect(()=>compileStudyUser(user,app)).not.toThrow();expect(()=>validateOscarInputs(app,user)).not.toThrow();
 }
 expect(app.workflows[0].preserveStatePaths).toContain('basket.quantity');
 for(const workflow of app.workflows)expect(workflow.preserveStatePaths).toContain('profile.lastName');
 expect(app.workflows[0].scenario.entryPath).toBe('/en-gb/accounts/profile/edit/');
});
it('rejects unsupported input values without accepting arbitrary application mutations',()=>{
 const app=createOscarApplication('http://127.0.0.1:8000');
 const user={id:'user',name:'Alex',summary:'Customer',coverageReason:'Basket',assumptions:[],workflowId:'oscar-basket-update',goal:'Update quantity',context:{...desktopContext,inputs:{quantity:0}}};
 expect(()=>validateOscarInputs(app,user)).toThrow();
});
