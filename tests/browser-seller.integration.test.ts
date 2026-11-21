import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserSession} from '../apps/runner/src/browser';
import {desktopContext} from '../packages/contracts/src/examples';

it('restricted browser allows the real seller UI to hydrate and persist a save',async()=>{
 const origin='http://127.0.0.1:3001';
 const response=await fetch(`${origin}/api/test/sessions`,{method:'POST',headers:{authorization:`Bearer ${process.env.TEST_API_TOKEN||'local-development-test'}`,'content-type':'application/json'},body:JSON.stringify({fixtureId:'fresh-seller'})});
 expect(response.ok).toBe(true);
 const setup=await response.json();
 const directory=await mkdtemp(join(tmpdir(),'seller-browser-'));
 const session=await createBrowserSession({pack:desktopContext,inputs:{storeName:'Browser Crafts'},origin,cookie:setup.cookie,artifactDirectory:directory,signal:AbortSignal.timeout(20000),onStep:()=>{}});
 try{
  await session.execute({tool:'navigate',path:'/onboarding'});
  await session.execute({tool:'fill',locator:{by:'label',value:'Store name'},value:{input:'storeName'}});
  await session.execute({tool:'click',locator:{by:'role',value:'button',name:'Save store'}});
  await session.page.getByText('Store saved',{exact:true}).waitFor({timeout:3000});
  const state=await fetch(`${origin}/api/test/state?namespaceId=${setup.namespaceId}`,{headers:{authorization:`Bearer ${process.env.TEST_API_TOKEN||'local-development-test'}`}});
  expect((await state.json()).store.name).toBe('Browser Crafts');
 }finally{await session.close();await rm(directory,{recursive:true,force:true});}
});
