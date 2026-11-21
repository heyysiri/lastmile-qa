import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplicationContextReader} from '../apps/runner/src/application-context';
import {createApplications} from '../apps/runner/src/applications';
const app=createApplications('http://localhost:3001')[0];
it('hashes explicit code and requirement sources independently of capture time and includes bounded excerpts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'context-'));
 try{
  await writeFile(join(root,'code.ts'),'a'.repeat(4000));await writeFile(join(root,'requirements.md'),'Stock must be preserved');await writeFile(join(root,'.env'),'DO_NOT_READ_SECRET');
  const read=createApplicationContextReader(root,{[app.id]:[{kind:'code',path:'code.ts'},{kind:'requirement',path:'requirements.md'}]});
  const first=await read(app),again=await read(app);
  expect(first.version).toBe(again.version);expect(first.sources).toHaveLength(2);expect(first.sources[0].excerpt.length).toBeLessThanOrEqual(2000);
  expect(JSON.stringify(first)).not.toContain('DO_NOT_READ_SECRET');
  await writeFile(join(root,'code.ts'),'a'.repeat(4000)+' changed beyond excerpt');
  const changed=await read(app);expect(changed.version).not.toBe(first.version);expect(changed.sources[0].excerpt).toBe(first.sources[0].excerpt);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('rejects missing, oversized and escaped sources rather than presenting partial context as complete',async()=>{
 const root=await mkdtemp(join(tmpdir(),'context-'));
 try{
  await writeFile(join(root,'large.ts'),'x'.repeat(128*1024+1));await symlink('/etc/hosts',join(root,'escaped.ts'));
  for(const path of ['missing.ts','large.ts','escaped.ts','../outside.ts'])await expect(createApplicationContextReader(root,{[app.id]:[{kind:'code',path}]})(app)).rejects.toThrow();
  await expect(createApplicationContextReader(root,{})(app)).rejects.toThrow(/sources/i);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('declares preservation intent on the profile workflow, not on an arbitrary user scenario',()=>{
 const profile=app.workflows.find(w=>w.id==='store-setup')!;
 expect(profile.preserveStatePaths).toEqual(['inventory.0.quantity']);
 expect(app.workflows.find(w=>w.id==='inventory-update')!.preserveStatePaths??[]).toEqual([]);
});
it('focuses a large source excerpt on the configured implementation while hashing the complete file',async()=>{
 const root=await mkdtemp(join(tmpdir(),'context-focus-'));
 try{
  await writeFile(join(root,'views.py'),'# imports\n'.repeat(400)+'class ProfileUpdateView:\n    save_profile()\n');
  const read=createApplicationContextReader(root,{[app.id]:[{kind:'code',path:'views.py',focus:'class ProfileUpdateView:'}]});
  const result=await read(app);expect(result.sources[0].excerpt).toContain('save_profile()');
  await expect(createApplicationContextReader(root,{[app.id]:[{kind:'code',path:'views.py',focus:'missing class'}]})(app)).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
