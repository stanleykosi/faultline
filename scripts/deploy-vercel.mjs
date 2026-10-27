import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareVercelSupabase} from './prepare-vercel-supabase.mjs';
import {hostingTarget} from '../ops/hosting/vercel-supabase/settings.mjs';

export async function resolveVercelCli(env=process.env){
 if(env.FAULTLINE_VERCEL_CLI_PATH)return fs.realpath(env.FAULTLINE_VERCEL_CLI_PATH);
 for(const directory of (env.PATH??'').split(path.delimiter)){
  for(const candidate of [path.join(directory,'node_modules/vercel/dist/vc.js'),path.join(directory,'vercel')]){
   try{const real=await fs.realpath(candidate);if(real.endsWith('vc.js')&&(await fs.stat(real)).isFile())return real;}catch{}
  }
 }
 throw new Error('Install and authenticate the official Vercel CLI, or set FAULTLINE_VERCEL_CLI_PATH to its vc.js entrypoint.');
}
export function deploymentCommands(context,{dry=false}={}){
 const scope=['--scope',hostingTarget.scope];
 return [
  ['link','--yes','--project',hostingTarget.project,...scope],
  ['deploy',...(dry?['--dry','--json']:['--prod','--skip-domain','--yes']),...scope],
 ].map(args=>({args,cwd:context}));
}
async function run(){
 const args=process.argv.slice(2);if(args.some(arg=>arg!=='--dry'))throw new Error('Usage: pnpm deploy:vercel [--dry]');
 const cli=await resolveVercelCli(),context=await prepareVercelSupabase();
 console.log(JSON.stringify({status:'source_context_prepared',fileCount:context.fileCount,project:hostingTarget.project,origin:hostingTarget.origin,build:'remote',liveDomainPromotion:false}));
 for(const command of deploymentCommands(context.destination,{dry:args.includes('--dry')}))await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...command.args],{cwd:command.cwd,env:{...process.env,VERCEL_ENABLE_DAEMONS_BOA:'1'},stdio:'inherit',windowsHide:true});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('VERCEL_CLI_STEP_FAILED_'+code)));
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(error=>{console.error(error.message);process.exitCode=1;});
