import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {createPrivateWorkspace} from '../apps/runner/src/private-workspace';

it('never inherits operator GitHub credentials and blocks shared local execution surfaces',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'private-workspace-'));
 const token='private-runner-token-32-characters-long';
 const app=createPrivateWorkspace({directory,apiToken:token});
 const headers={authorization:`Bearer ${token}`};
 try{
  expect((await app.inject({url:'/api/settings/github',headers})).json()).toEqual({configured:false,source:'none'});
  for(const url of ['/api/projects','/api/runs','/api/studies/generate']){
   const response=await app.inject({url,method:'POST',headers,payload:{repositoryPath:'/tmp'}});
   expect(response.statusCode).toBe(403);
  }
  expect((await app.inject({url:'/api/projects',headers})).json()).toEqual([]);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

it('rejects a Clerk identity sent to a legacy runner rather than exposing shared data',async()=>{
 const {createServer}=await import('../apps/runner/src/server');
 const directory=mkdtempSync(join(tmpdir(),'legacy-identity-'));const app=createServer({databasePath:join(directory,'qa.sqlite'),apiToken:'test-runner'});
 try{
  const response=await app.inject({url:'/api/projects',headers:{authorization:'Bearer test-runner','x-lastmile-user-id':'user_alice'}});
  expect(response.statusCode).toBe(409);expect(response.json().code).toBe('workspace_mode_mismatch');
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
