import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostedBuildContext} from './package-hosted-context.mjs';

export async function createRunnerBuildContext({sourceRoot=process.cwd(),destination}={}){
 if(typeof destination!=='string'||!destination)throw new Error('RUNNER_CONTEXT_DESTINATION_REQUIRED');
 const result=await createHostedBuildContext({sourceRoot,destination});
 const sourceConfig=path.join(destination,'ops','staging','railway-runner.json.example');
 const rootConfig=path.join(destination,'railway.json');
 await fs.copyFile(sourceConfig,rootConfig,fs.constants.COPYFILE_EXCL);
 const config=JSON.parse(await fs.readFile(rootConfig,'utf8'));
 if(config?.build?.dockerfilePath!=='ops/images/Runner.Dockerfile'||config?.deploy?.startCommand!=='node --max-old-space-size=128 dist/server/apps/runner/src/external-main.js'||config?.deploy?.healthcheckPath!=='/health/ready')throw new Error('RUNNER_CONTEXT_CONFIG_INVALID');
 return {destination:result.destination,files:[...result.files,'railway.json'].sort((a,b)=>a.localeCompare(b))};
}

async function main(){
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-runner-context-'));
 const destination=path.join(parent,'context'),result=await createRunnerBuildContext({sourceRoot:process.cwd(),destination});
 console.log(JSON.stringify({status:'clean_runner_context_created',destination:result.destination,file_count:result.files.length,allowlist_version:1}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'RUNNER_CONTEXT_FAILED');process.exitCode=1;});
