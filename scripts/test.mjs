import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadEnvFile} from 'node:process';

const args=process.argv.slice(2).filter(arg=>arg!=='--');
const selectors=args.filter(arg=>arg.startsWith('--suite='));
if(selectors.length>1)throw Error('Choose one test suite.');
const suite=selectors[0]?.slice(8)??(args.includes('--integration')?'db':'unit');
const allowed=new Set(['unit','db','browser','hosting','signup','supabase','recovery']);
if(!allowed.has(suite)||args.some(arg=>arg!=='--integration'&&arg!=='--list'&&!arg.startsWith('--suite=')))throw Error('Use --suite=unit|db|browser|hosting|signup|supabase|recovery and optionally --list.');
const files=[];
const specialDb=new Map([
 ['tests/integration/public-signup-postgres.test.ts','signup'],
 ['tests/integration/vercel-supabase-install.test.ts','supabase'],
 ['tests/integration/vercel-supabase-upload.test.ts','supabase'],
 ['tests/integration/publication-recovery-postgres.test.ts','recovery'],
]);
function category(file){
 if(specialDb.has(file))return specialDb.get(file);
 if(file.startsWith('tests/integration/'))return 'db';
 if(file.includes('.browser.test.')||file.startsWith('tests/acceptance/'))return 'browser';
 if(file.startsWith('tests/hosting/')||file==='scripts/deployment.test.mjs'||file==='scripts/initialize-vercel-runtime.test.mjs')return 'hosting';
 return 'unit';
}
async function walk(directory){
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  if(['node_modules','dist','.runtime','artifacts'].includes(entry.name))continue;
  const file=path.posix.join(directory,entry.name);
  if(entry.isDirectory())await walk(file);
  else if(/\.test\.(?:ts|tsx|mjs)$/.test(entry.name)&&category(file)===suite)files.push(file);
 }
}
for(const root of ['apps','packages','tools','scripts','ops','tests'])await walk(root);
files.sort();
if(!files.length)throw Error('No tests found for '+suite+'.');
console.log(`${suite}: ${files.length} test files`);
if(args.includes('--list')){console.log(files.join('\n'));process.exit(0);}

const databaseSuite=['db','signup','supabase','recovery'].includes(suite);
if(databaseSuite){
 for(const file of ['.env.local','.env.ops'])try{loadEnvFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(suite!=='supabase'){
  const required=['MIGRATION_DATABASE_URL','DATABASE_URL','AUTH_DATABASE_URL','QUEUE_DATABASE_URL','DISPATCHER_DATABASE_URL'];
  if(required.some(key=>!process.env[key]))throw Error('Configure every restricted connection for an isolated local PostgreSQL installation in .env.local and .env.ops before integration tests.');
  let connections;try{connections=required.map(key=>new URL(process.env[key]));}catch{throw Error('Integration database configuration is invalid.');}
  const identity=url=>`${url.port||'5432'}${url.pathname}`;
  if(connections.some(url=>!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.search||url.hash||identity(url)!==identity(connections[0])))throw Error('All integration connections must address the same isolated loopback PostgreSQL installation without connection overrides.');
 }
 if(suite==='signup')process.env.PUBLIC_SIGNUP_ENABLED='true';
 if(suite==='recovery'&&!['prepare','retry','verify'].includes(process.env.PUBLICATION_RECOVERY_PHASE))throw Error('Set PUBLICATION_RECOVERY_PHASE explicitly for the manual recovery rehearsal.');
 await fs.mkdir('reports/application/consolidated',{recursive:true});
}

const hostKeys=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','LANG','LC_ALL','TZ','CI','FORCE_COLOR','TERM','USERNAME','USER']);
let isolatedRoot;
if(!databaseSuite){await fs.mkdir('.runtime',{recursive:true});isolatedRoot=await fs.mkdtemp(path.resolve('.runtime/test-'));}
for(const web of [false,true]){
 const selected=files.filter(file=>file.startsWith('apps/web/')===web);
 if(!selected.length)continue;
 const env=databaseSuite?{...process.env}:Object.fromEntries(Object.entries(process.env).filter(([key])=>hostKeys.has(key.toUpperCase())));
 Object.assign(env,{NODE_ENV:'test'});
 if(!databaseSuite)Object.assign(env,{OBJECT_STORE:'filesystem',OBJECT_STORE_PATH:path.join(isolatedRoot,'objects'),SECRET_KEYRING_PATH:path.join(isolatedRoot,'keyring.json'),REPORT_SIGNING_KEY_PATH:path.join(isolatedRoot,'report-private.pem'),RUNNER_MODE:'disabled',MODEL_PROVIDER:'none',ALLOW_FIXTURE_ADAPTERS:'false',RETENTION_PHYSICAL_PURGE_ENABLED:'false',PUBLIC_SIGNUP_ENABLED:'false',AUTH_DATABASE_SCHEMA:'auth'});
 if(web)env.TSX_TSCONFIG_PATH=path.resolve('apps/web/tsconfig.json');
 const child=spawn(process.execPath,['--import','tsx','--test',`--test-concurrency=${databaseSuite?1:2}`,...selected],{stdio:'inherit',env,windowsHide:true});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 if(code!==0){process.exitCode=code??1;break;}
}
