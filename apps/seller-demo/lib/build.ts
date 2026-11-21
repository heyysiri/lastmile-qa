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
