import {readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import type {StudyApplication} from '@lastmile/contracts/studies';
import type {ApplicationContext,ApplicationContextSource} from '@lastmile/contracts/populations';
import {hashValue} from './artifacts';
type Source=Pick<ApplicationContextSource,'kind'|'path'>;
/** Repository sources are configured by the application adapter, never by page content or the actor. */
export function createApplicationContextReader(root:string,sourcesByApplication:Record<string,Source[]>){
 return async(application:StudyApplication):Promise<ApplicationContext>=>{
  const configured=sourcesByApplication[application.id];
  if(!configured?.length)throw new Error('No application context sources configured');
  const directory=await realpath(root);
  const sources=await Promise.all(configured.map(async source=>{
   if(isAbsolute(source.path))throw new Error('Context source must be relative');
   const path=await realpath(resolve(directory,source.path));
   const within=relative(directory,path);
   if(!within||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new Error('Context source escaped repository');
   const info=await stat(path);
   if(!info.isFile()||info.size>128*1024)throw new Error('Context source exceeds readable limit');
   const content=await readFile(path,'utf8');
   if(Buffer.byteLength(content)>128*1024)throw new Error('Context source exceeds readable limit');
   return {...source,digest:hashValue(content),excerpt:content.slice(0,2000)};
  }));
  return {applicationId:application.id,version:hashValue(sources.map(({kind,path,digest})=>({kind,path,digest}))),capturedAt:new Date().toISOString(),sources};
 };
}
