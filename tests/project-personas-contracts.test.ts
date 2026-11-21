import {expect,it} from 'vitest';
import {ProjectPlanSchema,ProjectJourneySchema} from '../packages/contracts/src/projects';
import {desktopContext} from '../packages/contracts/src/examples';
const source={path:'requirements.md',startLine:1,endLine:1,hash:'a'.repeat(64),excerpt:'Save and return to a draft.'};
const journey=(id='journey',testerId='tester')=>({id,testerId,title:'Return to work',goal:'Save your draft and return to it.',entryPath:'/draft',inputs:{title:'Draft'},checks:[{id:'saved',label:'Saved draft',kind:'field',locator:{by:'label',value:'Title'},phase:'after_reload',path:'/draft',expected:'Draft',basis:'requirement',sources:[source]}],sources:[source],reason:'Interrupted work must persist.'});
const plan=(count:number)=>({summary:'Cover distinct work habits',roles:['Editor'],features:[{id:'drafts',title:'Drafts',description:'Saved work',sources:[source]}],testers:Array.from({length:count},(_,i)=>({id:`tester-${i}`,name:`Editor ${i}`,role:'Editor',summary:'Works on drafts',selectionReason:'Different interruption and familiarity needs',context:desktopContext})),journeys:Array.from({length:count},(_,i)=>journey(`journey-${i}`,`tester-${i}`)),gaps:[]});
it('accepts eight selected personas and multiple journeys while bounding team size',()=>{
 const data=plan(8);data.journeys.push(journey('extra','tester-0'));
 expect(ProjectPlanSchema.safeParse(data).success).toBe(true);
 expect(ProjectPlanSchema.safeParse(plan(9)).success).toBe(false);
 while(data.journeys.length<12)data.journeys.push(journey(`extra-${data.journeys.length}`,'tester-0'));
 expect(ProjectPlanSchema.safeParse(data).success).toBe(true);
 data.journeys.push(journey('overflow','tester-0'));expect(ProjectPlanSchema.safeParse(data).success).toBe(false);
});
it('supports a resume check before the actor can recreate lost work',()=>{
 const data={...journey(),stages:[{id:'work',label:'Start draft',goal:'Enter the draft without submitting.',transition:'continue'},{id:'return',label:'Return later',goal:'Continue the saved draft.',transition:'reopen',entryPath:'/draft',pauseMs:100}],checks:[{...journey().checks[0],atStageStart:'return'}]};
 expect(ProjectJourneySchema.safeParse(data).success).toBe(true);
 expect(ProjectJourneySchema.safeParse({...data,checks:[{...data.checks[0],atStageStart:'missing'}]}).success).toBe(false);
 expect(ProjectJourneySchema.safeParse({...data,stages:[data.stages[0],data.stages[0]]}).success).toBe(false);
 expect(ProjectJourneySchema.safeParse({...data,stages:[{...data.stages[0],pauseMs:86_400_000}]}).success).toBe(false);
});
it('keeps legacy single-stage journeys valid and rejects unbounded staged runs',()=>{
 expect(ProjectJourneySchema.safeParse(journey()).success).toBe(true);
 expect(ProjectJourneySchema.safeParse({...journey(),stages:Array.from({length:5},(_,i)=>({id:`stage-${i}`,label:'Stage',goal:'Continue working',transition:'continue'}))}).success).toBe(false);
});
