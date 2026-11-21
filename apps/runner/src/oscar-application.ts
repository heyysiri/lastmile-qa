import {z} from 'zod';
import {ScenarioSchema} from '@lastmile/contracts';
import type {StudyApplication,StudyUser} from '@lastmile/contracts/studies';
const nameInput=z.object({firstName:z.string().trim().min(1).max(150)}).strict();
const quantityInput=z.object({quantity:z.number().int().min(1).max(99)}).strict();
export function createOscarApplication(origin:string):StudyApplication{
 const url=new URL(origin);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid Oscar origin');
 const profiles=['returning-customer','new-customer'].map(fixture=>({
  id:`oscar-profile-${fixture}`,description:`Edit the existing Oscar customer profile first name (1 to 150 characters). Preserve their basket and addresses. Starting fixture: ${fixture}, with ${fixture==='returning-customer'?4:1} mugs in their basket; these are initial conditions, not observed past actions. Keep the current email and last name.`,
  defaultInputs:{firstName:'Alexandra'},preserveStatePaths:['basket.quantity','addressesDigest','orderCount','profile.lastName'],
  scenario:ScenarioSchema.parse({id:`oscar-profile-${fixture}`,revision:1,label:`Edit profile: ${fixture==='returning-customer'?'returning':'new'} customer`,goal:'Change only your first name to the supplied firstName using the account profile form. Keep the existing email and last name, save and confirm the update. Finish on the profile confirmation page.',entryPath:'/en-gb/accounts/profile/edit/',initialStateId:fixture,inputSlots:{firstName:{type:'text',required:true}},contract:{scope:'ui_and_api',assertions:[{id:'profile-confirmation',kind:'visible',locator:{by:'text',value:'Profile updated'}},{id:'first-name',kind:'state_equals',path:'profile.firstName',expected:{input:'firstName'}}]}}),
 }));
 return {id:'oscar-commerce',name:'Oscar Commerce',domain:'Commerce customer journeys',origin:url.origin,description:'Pinned Django Oscar 4.2.1: real catalogue, baskets, checkout, orders, addresses and management dashboard. This integration currently covers profile edits and basket updates only; generated tasks must stay inside these workflows. Account state persists across releases.',workflows:[...profiles,{
  id:'oscar-basket-update',description:'Update the one existing Trail travel mug basket line to quantity, a whole number from 1 to 99. Keep your profile unchanged. Do not check out or remove the item.',defaultInputs:{quantity:4},preserveStatePaths:['profile.firstName','profile.lastName','orderCount'],
  scenario:ScenarioSchema.parse({id:'oscar-basket-update',revision:1,label:'Update existing basket',goal:'Change the quantity of Trail travel mug in your basket to the supplied quantity and click Update. Remain on the basket page.',entryPath:'/en-gb/basket/',initialStateId:'returning-customer',inputSlots:{quantity:{type:'number',required:true}},contract:{scope:'ui_and_api',assertions:[{id:'basket-page',kind:'visible',locator:{by:'role',value:'heading',name:'Items to buy now'}},{id:'basket-quantity',kind:'state_equals',path:'basket.quantity',expected:{input:'quantity'}}]}}),
 }]};
}
export function validateOscarInputs(application:StudyApplication,user:StudyUser){
 if(application.id!=='oscar-commerce')return;
 const schema=user.workflowId==='oscar-basket-update'?quantityInput:nameInput;
 if(!schema.safeParse(user.context.inputs).success)throw new Error('Inputs do not satisfy the Oscar workflow limits');
}
