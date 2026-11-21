import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function sourceBuildId(directories:string[],variant:string):Promise<string> {
  const hash=createHash('sha256').update(variant);
  async function visit(dir:string,relative='') {
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=join(relative,entry.name),path=join(dir,entry.name);
      if(entry.isDirectory()) await visit(path,name);
      else if(entry.isFile()&&/\.(tsx?|css|mjs)$/.test(entry.name)) hash.update(name).update(await readFile(path));
    }
  }
  for(const dir of directories) await visit(dir);
  return hash.digest('hex');
}

/** The selected requirements are part of the release identity, alongside implementation. */
export async function releaseSourceId(root:string):Promise<string>{
  const source=await sourceBuildId(['app','components','lib'].map(dir=>join(/* turbopackIgnore: true */ root,dir)),'');
  return createHash('sha256').update(source).update(await readFile(join(/* turbopackIgnore: true */ root,'requirements.md'))).digest('hex');
}

export async function servedBuildId(root:string,variant:string,production:boolean):Promise<string>{
  const sourceId=await releaseSourceId(root);
  if(!production)return createHash('sha256').update(sourceId).update(variant).digest('hex');
  const stamp=JSON.parse(await readFile(join(/* turbopackIgnore: true */ root,'.next/lastmile-source.json'),'utf8'));
  const buildId=(await readFile(join(/* turbopackIgnore: true */ root,'.next/BUILD_ID'),'utf8')).trim();
  if(stamp.sourceId!==sourceId||stamp.buildId!==buildId)throw new Error('Source differs from the compiled application; rebuild before testing');
  return createHash('sha256').update(buildId).update(sourceId).update(variant).digest('hex');
}
