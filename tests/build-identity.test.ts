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

it('rejects a production bundle whose source or requirement files changed after compilation',async()=>{
 const {mkdir}=await import('node:fs/promises');
 const {releaseSourceId,servedBuildId}=await import('../apps/seller-demo/lib/build');
 const root=await mkdtemp(join(tmpdir(),'served-build-'));
 try{
  for(const directory of ['app','components','lib','.next'])await mkdir(join(root,directory));
  await writeFile(join(root,'app/page.ts'),'compiled source');await writeFile(join(root,'requirements.md'),'Keep stock');
  await writeFile(join(root,'.next/BUILD_ID'),'compiled-release-A');
  const sourceId=await releaseSourceId(root);
  await writeFile(join(root,'.next/lastmile-source.json'),JSON.stringify({sourceId,buildId:'compiled-release-A'}));
  const first=await servedBuildId(root,'healthy',true);
  expect(await servedBuildId(root,'defect',true)).not.toBe(first);
  await writeFile(join(root,'requirements.md'),'Changed contract');
  await expect(servedBuildId(root,'healthy',true)).rejects.toThrow(/rebuild/i);
  await writeFile(join(root,'requirements.md'),'Keep stock');await writeFile(join(root,'app/page.ts'),'uncompiled source B');
  await expect(servedBuildId(root,'healthy',true)).rejects.toThrow(/rebuild/i);
  await expect(servedBuildId(root,'healthy',false)).resolves.toBeTypeOf('string');
 }finally{await rm(root,{recursive:true,force:true});}
});
