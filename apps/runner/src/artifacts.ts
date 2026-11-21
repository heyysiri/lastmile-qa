import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const hashValue = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_k,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v)).digest('hex');
const hashBytes = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export type ArtifactEntry = {name:string;bytes:number;sha256:string};
const validName = (name:string) => name!=='trace.zip' && /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name);
export async function writeArtifactManifest(directory:string):Promise<ArtifactEntry[]> {
  const manifest:ArtifactEntry[]=[];
  for(const name of (await readdir(directory)).sort()) {
    if(name==='manifest.json'||!validName(name)) continue;
    const path=join(directory,name), stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()) continue;
    const data=await readFile(path); manifest.push({name,bytes:data.length,sha256:hashBytes(data)});
  }
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
  return manifest;
}
export async function readArtifact(directory:string,name:string,expectedManifestHash?:string):Promise<Buffer> {
  if(!validName(name)) throw new Error('Invalid artifact');
  if((await lstat(directory)).isSymbolicLink()) throw new Error('Invalid artifact directory');
  const manifestPath=join(directory,'manifest.json');
  if((await lstat(manifestPath)).isSymbolicLink()) throw new Error('Invalid manifest');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as ArtifactEntry[];
  if(expectedManifestHash&&hashValue(manifest)!==expectedManifestHash)throw new Error('Manifest integrity check failed');
  const entry=manifest.find(e=>e.name===name);
  if(!entry) throw new Error('Artifact is not listed');
  const path=join(directory,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Invalid artifact');
  const bytes=await readFile(path);
  if(bytes.length!==entry.bytes||hashBytes(bytes)!==entry.sha256) throw new Error('Artifact integrity check failed');
  return bytes;
}
