import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashValue, writeArtifactManifest, readArtifact } from '../apps/runner/src/artifacts';

describe('protected artifact access', () => {
  it('hashes canonical objects and rejects missing/tampered/unlisted files', async () => {
    expect(hashValue({b:2,a:1})).toBe(hashValue({a:1,b:2}));
    const root=await mkdtemp(join(tmpdir(),'lastmile-artifacts-'));
    try {
      await writeFile(join(root,'result.json'),'{"ok":true}');
      const manifest=await writeArtifactManifest(root);
      expect((await readArtifact(root,'result.json')).toString()).toContain('true');
      expect(manifest[0]).toMatchObject({name:'result.json',bytes:11});
      const anchor=hashValue(manifest);
      await writeFile(join(root,'result.json'),'tampered');
      await writeArtifactManifest(root);
      await expect(readArtifact(root,'result.json',anchor)).rejects.toThrow();
      await expect(readArtifact(root,'result.json',anchor)).rejects.toThrow();
      await writeFile(join(root,'other.json'),'{}');
      await expect(readArtifact(root,'other.json')).rejects.toThrow();
      await expect(readArtifact(root,'../outside')).rejects.toThrow();
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('does not include or serve symlinks',async()=>{
    const root=await mkdtemp(join(tmpdir(),'lastmile-artifacts-'));
    try { await writeFile(join(root,'real.txt'),'data'); await symlink(join(root,'real.txt'),join(root,'link.txt'));
      expect(await writeArtifactManifest(root)).toHaveLength(1);
      await expect(readArtifact(root,'link.txt')).rejects.toThrow();
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});

it('never publishes or serves raw browser archives, including legacy manifests',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lastmile-raw-trace-'));
 try{
  await writeFile(join(root,'trace.zip'),'raw credentials');
  const manifest=await writeArtifactManifest(root);
  expect(manifest.some(entry=>entry.name==='trace.zip')).toBe(false);
  await expect(readArtifact(root,'trace.zip')).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
