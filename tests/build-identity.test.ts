import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceBuildId} from '../apps/seller-demo/lib/build';
it('binds source bytes and explicit demo defect to the served build identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lastmile-build-'));
 try {
  await writeFile(join(dir,'page.ts'),'one');
  const one=await sourceBuildId([dir],'');
  await writeFile(join(dir,'page.ts'),'two');
  expect(await sourceBuildId([dir],'')).not.toBe(one);
  expect(await sourceBuildId([dir],'short-save-timeout')).not.toBe(await sourceBuildId([dir],''));
 }finally {await rm(dir,{recursive:true,force:true});}
});
