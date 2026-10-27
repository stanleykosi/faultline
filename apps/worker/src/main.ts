import {executionErrorCode} from './execution-error.js';
import {redactionPreviewHandler,redactionApplyHandler} from '../../../packages/core/src/privacy/service.js';
import {cleanExpiredDirectUploads} from '../../../packages/core/src/captures/direct-uploads.js';
import {policyRetentionTick} from '../../../packages/core/src/retention/policy.js';
import {sourceCaptureHandler} from '../../../packages/core/src/integrations/service.js';
import {providerOperationHandler} from '../../../packages/core/src/integrations/operations.js';
import {modelProposalHandler} from '../../../packages/core/src/models/service.js';
import {agentTurnHandler,reflectAgentActionJob} from '../../../packages/core/src/agent/service.js';
import {retentionTick} from '../../../packages/core/src/retention/service.js';
import {verificationHandler} from '../../../packages/core/src/experiments/index.js';
import {externalBrowserHandler} from '../../../packages/core/src/experiments/external-service.js';
import {dispatchDueFollowups,followupDueHandler} from '../../../packages/core/src/collaboration/service.js';
import {analyticHandler} from '../../../packages/core/src/investigation/service.js';
import {commitHandler,comparisonHandler} from '../../../packages/core/src/captures/service.js';
import {mixAdjustmentHandler} from '../../../packages/core/src/captures/mix-adjustment.js';
import {DomainError} from '../../../packages/core/src/errors.js';
import {PgBoss} from 'pg-boss';
import pg from 'pg';
import {config} from '../../../packages/core/src/config.js';
import {requireDatabase,verifyRuntimeRole,verifyWorkerRole} from '../../../packages/database/src/client.js';
import {verifyRuntimeSchema} from '../../../packages/database/src/runtime-schema.js';
import {claimJob,finishJob,renewLease} from '../../../packages/core/src/jobs/service.js';
import {deterministicJobOutcome} from '../../../packages/core/src/jobs/outcome.js';
import {createPgBossOptions,createPgBossSendOptions} from './pg-boss-options.js';
if(!config.queueDatabaseUrl||!config.databaseUrl||!process.env.DISPATCHER_DATABASE_URL){
 console.log('Faultline worker blocked: configure runtime, queue and restricted dispatcher PostgreSQL pools. No work executed.');process.exitCode=0;
}else{
 let verified=false;for(let attempt=0;attempt<5;attempt++){try{await verifyRuntimeRole();await verifyRuntimeSchema(requireDatabase());verified=true;break;}catch(error){if(error instanceof DomainError||attempt===4)throw error;const code=(error as {code?:string}).code,message=error instanceof Error?error.message:'';if(!['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P03','08006','53300'].includes(code??'')&&!message.includes('connection timeout'))throw error;console.log('Worker dependency unavailable during bounded startup retry; no jobs executed.');await new Promise(resolve=>setTimeout(resolve,Math.min(4000,1000*(attempt+1))));}}if(!verified)throw new Error('Worker startup dependency unavailable');
 const dispatcher=new pg.Pool({connectionString:process.env.DISPATCHER_DATABASE_URL,max:2,connectionTimeoutMillis:3000});
 const queueCheck=new pg.Pool({connectionString:config.queueDatabaseUrl,max:1,connectionTimeoutMillis:3000});
 try{await verifyWorkerRole(queueCheck,'queue');await verifyWorkerRole(dispatcher,'dispatcher');}finally{await queueCheck.end();}
 const boss=new PgBoss(createPgBossOptions(config.queueDatabaseUrl,config.pgBossInstanceName));
 boss.on('error',()=>console.error('Queue unavailable; inspect redacted diagnostics.'));
 await boss.start();

 await boss.work<{outbox_id:string;workspace_id:string;job_id:string}>('faultline',{pollingIntervalSeconds:process.env.FAULTLINE_HOSTING_PROFILE==='vercel-supabase'?2:0.5,batchSize:1},async jobs=>{
  for(const delivered of jobs){
   const route=(await dispatcher.query('SELECT workspace_id,job_id FROM faultline.job_outbox WHERE id=$1',[delivered.data.outbox_id])).rows[0];
   if(!route||route.workspace_id!==delivered.data.workspace_id||route.job_id!==delivered.data.job_id)throw new Error('Stored routing mismatch');
   const job=await claimJob(route.workspace_id,route.job_id);if(!job)continue;
   const handlers:{[kind:string]:(job:any)=>Promise<unknown>}={redaction_preview:redactionPreviewHandler,redaction_apply:redactionApplyHandler,import_commit:commitHandler,comparison_compute:comparisonHandler,mix_adjustment:mixAdjustmentHandler,analytic_compute:analyticHandler,followup_due:followupDueHandler,browser_execute:verificationHandler,external_browser_execute:externalBrowserHandler,source_capture:sourceCaptureHandler,model_proposal:modelProposalHandler,agent_turn:agentTurnHandler};
   const handler=handlers[job.kind];
   if(!handler){await finishJob(route.workspace_id,route.job_id,job.fence,'waiting_for_input',{reason:'handler_unavailable',prerequisite:job.kind},'HANDLER_UNAVAILABLE');continue;}
   const heartbeat=setInterval(()=>{void renewLease(route.workspace_id,job.id,job.fence).catch(()=>false);},15000);
   try{const result=await handler(job),outcome=deterministicJobOutcome(job,result);await finishJob(route.workspace_id,route.job_id,job.fence,outcome.status,result,outcome.errorCode);}
   catch(error){await finishJob(route.workspace_id,route.job_id,job.fence,'failed',null,executionErrorCode(error));}
   finally{clearInterval(heartbeat);}
  }
 });
 let ticking=false,providerRunning=false,tickPromise:Promise<void>|null=null,providerPromise:Promise<void>|null=null,stopPromise:Promise<void>|null=null,uploadCleanup:Promise<void>|null=null;
 const tick=async()=>{
  if(ticking)return tickPromise??undefined;ticking=true;
  tickPromise=(async()=>{try{
   await requireDatabase().query('SELECT faultline.recover_expired_jobs()');
   await dispatchDueFollowups();
   await retentionTick();
   await policyRetentionTick();
   if(process.env.OBJECT_STORE==='supabase'&&!uploadCleanup&&!stopPromise){
    uploadCleanup=(async()=>{const route=(await dispatcher.query('SELECT * FROM faultline.expired_direct_upload_routes() LIMIT 1')).rows[0];if(route)await cleanExpiredDirectUploads(route.workspace_id);})().catch(()=>console.error('Temporary upload cleanup unavailable; quota reservation retained for retry.')).finally(()=>{uploadCleanup=null;});
   }
   for(const route of (await dispatcher.query('SELECT * FROM faultline.agent_reflection_routes()')).rows){
    try{await reflectAgentActionJob(route.workspace_id,route.job_id);}catch{console.error('Agent reflection unavailable; durable action retained.');}
   }
   if(!providerRunning){const operation=(await requireDatabase().query('SELECT * FROM faultline.provider_operation_routes()')).rows[0];if(operation){providerRunning=true;providerPromise=providerOperationHandler(operation).catch(()=>console.error('Provider operation unavailable; inspect redacted operation status.')).finally(()=>{providerRunning=false;providerPromise=null;});}}
   await requireDatabase().query("INSERT INTO faultline.worker_heartbeats(id,version,checked_at) VALUES('worker','0.1.0',now()) ON CONFLICT(id) DO UPDATE SET version=excluded.version,checked_at=excluded.checked_at");
   const tx=await dispatcher.connect();let rows;
   try{await tx.query('BEGIN');rows=(await tx.query("SELECT id,workspace_id,job_id FROM faultline.job_outbox WHERE dispatched_at IS NULL AND (dispatch_lease IS NULL OR dispatch_lease<now()) ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED")).rows;for(const row of rows)await tx.query("UPDATE faultline.job_outbox SET dispatch_lease=now()+interval '30 seconds' WHERE id=$1",[row.id]);await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
   for(const row of rows){const sent=await boss.send('faultline',{outbox_id:row.id,workspace_id:row.workspace_id,job_id:row.job_id},createPgBossSendOptions(row.id));if(sent||await boss.getJobById('faultline',row.id))await dispatcher.query('UPDATE faultline.job_outbox SET dispatched_at=now(),dispatch_lease=NULL WHERE id=$1',[row.id]);}
  }catch{console.error('Worker dependency unavailable; durable queued work retained.');}})();
  try{await tickPromise;}finally{tickPromise=null;ticking=false;}
 };
 await tick();const timer=setInterval(()=>void tick(),process.env.FAULTLINE_HOSTING_PROFILE==='vercel-supabase'?5000:1000);
 const stop=()=>{
  if(stopPromise)return stopPromise;
  stopPromise=(async()=>{
   clearInterval(timer);let failed=false;
   for(const close of [()=>tickPromise,()=>providerPromise,()=>uploadCleanup,()=>boss.stop(),()=>dispatcher.end(),()=>requireDatabase().end()]){
    try{const value=close();if(value)await value;}catch{failed=true;}
   }
   if(failed)process.exitCode=1;
  })();
  return stopPromise;
 };
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void stop();});
 console.log('Faultline worker active; migrations run only through operator commands.');
}

