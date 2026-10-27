import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareHostedPrivateRuntime} from './hosted-private-runtime.mjs';
import {superviseHosted} from './hosted-supervisor.mjs';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

async function main(){
 try{
  await prepareHostedPrivateRuntime();
  const [{apiReadinessUrl},{config}]=await Promise.all([
   import('../dist/server/packages/core/src/api-bind.js'),
   import('../dist/server/packages/core/src/config.js'),
  ]);
  const result=await superviseHosted({
   children:[
    {role:'api',entry:path.join(appRoot,'dist/server/apps/api/src/main.js'),cwd:appRoot},
    {role:'worker',entry:path.join(appRoot,'dist/server/apps/worker/src/main.js'),cwd:appRoot},
   ],
   readinessUrl:apiReadinessUrl(config.apiBindHost,config.port),
  });
  if(result.reason!=='SHUTDOWN_SIGNAL')console.error('Faultline hosted supervisor stopped: '+result.reason);
  process.exitCode=result.exitCode;
 }catch(error){
  const reason=error?.code?.startsWith?.('HOSTED_')?error.code:'HOSTED_STARTUP_FAILED';
  console.error(reason);process.exitCode=1;
 }
}

await main();
