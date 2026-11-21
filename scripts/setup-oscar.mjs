import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const upstream=resolve(root,'.local-work/p2/oscar-upstream');
const venv=resolve(root,'.local-work/p2/oscar-venv');
const revision='d0a70850abf8e4229d4971aa7e8f4643326ec9f3';
function run(command,args,cwd=root){const result=spawnSync(command,args,{cwd,stdio:'inherit',env:process.env});if(result.status!==0)throw new Error(`${command} failed`);}
if(!existsSync(upstream))run('git',['clone','--depth','1','--branch','4.2.1','https://github.com/django-oscar/django-oscar.git',upstream]);
const actual=spawnSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).stdout?.trim();
if(actual!==revision)throw new Error('Oscar checkout is not the pinned release');
if(!existsSync(resolve(venv,'bin/python')))run('uv',['venv','--python','3.12',venv]);
run('uv',['pip','install','--python',resolve(venv,'bin/python'),'-r','integrations/oscar/requirements.lock','-e',upstream]);
if(!existsSync(resolve(upstream,'node_modules')))run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],upstream);
run('npm',['run','build'],upstream);
mkdirSync(resolve(root,'.data'),{recursive:true});
mkdirSync(resolve(upstream,'.lastmile'),{recursive:true});
copyFileSync(resolve(root,'integrations/oscar/requirements.md'),resolve(upstream,'.lastmile/requirements.md'));
run(resolve(venv,'bin/python'),['integrations/oscar/seed-regression.py']);
const manage=args=>run(resolve(venv,'bin/python'),['integrations/oscar/manage.py',...args]);
manage(['migrate','--run-syncdb','--noinput']);
const marker=resolve(root,'.data/oscar-catalogue-seeded');
if(!existsSync(marker)){
 for(const name of ['books.essential.csv','books.hacking.csv','books.computers-in-fiction.csv'])manage(['oscar_import_catalogue',resolve(upstream,'sandbox/fixtures',name)]);
 manage(['oscar_populate_countries','--initial-only']);
 manage(['oscar_import_catalogue_images',resolve(upstream,'sandbox/fixtures/images.tar.gz')]);
 writeFileSync(marker,revision+'\n');
}
manage(['collectstatic','--noinput']);
console.log('Oscar 4.2.1 is ready. Run pnpm oscar:start in a separate terminal, then LASTMILE_APPLICATION=oscar pnpm start.');
