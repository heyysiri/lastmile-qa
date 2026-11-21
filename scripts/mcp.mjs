import {fileURLToPath} from 'node:url';
import {config} from 'dotenv';
import {register} from 'tsx/esm/api';

const root=new URL('../',import.meta.url);
config({path:fileURLToPath(new URL('.env',root)),quiet:true});
process.chdir(fileURLToPath(root));
register();
await import(new URL('apps/runner/src/mcp-stdio.ts',root).href);
