import {config} from 'dotenv';
import {desktopContext,storeScenario} from '../packages/contracts/src/examples';
config({quiet:true});
const base=`http://127.0.0.1:${process.env.RUNNER_PORT||4000}/api`;
const headers={authorization:`Bearer ${process.env.RUNNER_API_TOKEN||'local-development-runner'}`,'content-type':'application/json'};
const scenario={...storeScenario,id:'network-onboarding',label:'Store setup under delayed requests',investigation:{factors:['network'],maxAttempts:6}};
const normal={...desktopContext,id:'network-control',label:'Seller · normal requests'};
const delayed={...normal,id:'network-delayed',label:'Seller · delayed requests',network:{mode:'request_delay',delayMs:1500,pathPrefix:'/api/store'}};
for(const [path,items] of [['scenarios',[scenario]],['context-packs',[normal,delayed]]] as const){
 const response=await fetch(`${base}/${path}`,{headers});if(!response.ok)throw new Error(`Cannot load ${path}`);
 const existing=await response.json() as {id:string}[];
 for(const item of items){if(existing.some(x=>x.id===item.id)){console.log(`Already exists: ${item.id}`);continue;}
 const created=await fetch(`${base}/${path}`,{method:'POST',headers,body:JSON.stringify(item)});if(!created.ok)throw new Error(`Cannot create ${item.id}: HTTP ${created.status}`);console.log(`Created: ${item.id}`);}
}
