import {expect,it} from 'vitest';
import {desktopContext,storeScenario} from '../packages/contracts/src/examples';
import {StudyDraftSchema,compileStudyUser,validateStudyDraft} from '../packages/contracts/src/studies';
const app={id:'demo',name:'Demo',domain:'Marketplace',origin:'http://127.0.0.1:3001',description:'Demo app',workflows:[{id:'setup',description:'Set up a store',scenario:storeScenario,defaultInputs:{storeName:'Siri'}}]};
const user={id:'one',name:'Siri',summary:'First time seller',coverageReason:'First attempt',assumptions:['Experience is assumed'],workflowId:'setup',goal:'Save my store profile',context:desktopContext};
const draft={title:'Study',summary:'A generated study',assumptions:[],users:[user]};
it('compiles generated goals and inputs against the registered outcome contract',()=>{
 const parsed=validateStudyDraft(draft,app,1);const compiled=compileStudyUser(parsed.users[0],app);
 expect(compiled.scenario.goal).toBe(user.goal);expect(compiled.scenario.contract).toEqual(storeScenario.contract);
 expect(compiled.inputs.storeName).toBe('Siri Crafts');
});
it('rejects unsupported workflows, missing inputs, wrong counts and duplicate effective users',()=>{
 expect(()=>validateStudyDraft({...draft,users:[{...user,workflowId:'invented'}]},app,1)).toThrow();
 expect(()=>validateStudyDraft({...draft,users:[{...user,context:{...desktopContext,inputs:{}}}]},app,1)).toThrow();
 expect(()=>validateStudyDraft(draft,app,3)).toThrow();
 expect(()=>validateStudyDraft({...draft,users:[user,{...user,id:'two',name:'Other'}]},app,2)).toThrow();
});
it('bounds generated payload and forbids additional executable instructions',()=>{
 expect(StudyDraftSchema.safeParse({...draft,script:'shell'}).success).toBe(false);
 expect(StudyDraftSchema.safeParse({...draft,users:[]}).success).toBe(false);
});
