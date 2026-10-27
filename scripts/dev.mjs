import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const children=[];
async function run(args,env=process.env){const child=spawn(process.execPath,args,{stdio:'inherit',env,windowsHide:true});const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});if(code!==0)throw Error('Local build failed with exit '+code);}
await fs.access('.env.local').catch(()=>{throw Error('Run pnpm db:local, pnpm db:migrate, pnpm db:roles and protected bootstrap first; see README.md.');});
await run(['node_modules/typescript/bin/tsc']);
await run(['node_modules/vite/bin/vite.js','build','apps/web','--configLoader','runner']);
const health=async()=>{try{const r=await fetch('http://localhost:3000/health/live');return r.ok;}catch{return false;}};
if(await health())throw Error('The configured local API is already running at http://localhost:3000. Open that address or stop its task-owned process before starting another.');
let db;
try{const pg=await import('pg');const env=await fs.readFile('.env.local','utf8'),url=env.split(/\r?\n/).find(l=>l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);if(!url)throw Error('Configure database runtime URL.');db=new pg.default.Client({connectionString:url,connectionTimeoutMillis:1500});await db.connect();await db.end();}
catch(error){await db?.end().catch(()=>{});children.push(spawn(process.execPath,['tools/ops/local-database.mjs'],{stdio:'inherit',windowsHide:true}));await new Promise(r=>setTimeout(r,3000));}
const localEnv=await fs.readFile('.env.local','utf8'),nativeFixture=/^RUNNER_MODE=trusted_fixture$/m.test(localEnv);const entries=[...(nativeFixture?[['apps/runner/src/main.js','runner']]:[]),['apps/api/src/main.js','api'],['apps/worker/src/main.js','worker']];
for(const [entry,role]of entries)children.push(spawn(process.execPath,[...(role==='worker'?['--max-old-space-size=128']:role==='api'?['--max-old-space-size=128']:[]),'--env-file=.env.local',path.resolve('dist/server',entry)],{stdio:'inherit',env:{...process.env,PROCESS_ROLE:role},windowsHide:true}));
console.log('Private local product: http://localhost:3000. Model access and external staging work require separately configured capabilities.');
const stop=()=>{for(const child of children)child.kill();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const child of children)child.on('exit',code=>{if(code&&code!==0){process.exitCode=code;stop();}});
