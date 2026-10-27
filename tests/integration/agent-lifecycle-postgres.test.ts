import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {hash} from '../../packages/core/src/canonical.js';
import {DomainError} from '../../packages/core/src/errors.js';
import {MODEL_ADAPTER_VERSION,modelSchemaHash} from '../../packages/core/src/models/gateway.js';
import {approveAgentAction,createAgentTurn,reflectAgentActionJob} from '../../packages/core/src/agent/service.js';
import {saveReportMemory} from '../../packages/core/src/agent/memory.js';
import {cancelJob,restartJob} from '../../packages/core/src/jobs/service.js';

const connectionString=process.env.MIGRATION_DATABASE_URL;
const integration=connectionString?test:test.skip;

function code(expected:string){return (error:unknown)=>error instanceof DomainError&&error.code===expected;}

integration('agent service enforces review, permissions, terminal reflection and exact cancel/retry rebinding',async()=>{
 const previousLocalOrigins=process.env.MODEL_LOCAL_ORIGINS;
 process.env.MODEL_LOCAL_ORIGINS=JSON.stringify(['http://127.0.0.1:11434']);
 const admin=new pg.Pool({connectionString,max:1});
 const wid=randomUUID(),cid=randomUUID(),rid=randomUUID(),profileId=randomUUID(),sessionId=randomUUID(),turnId=randomUUID();
 const completedActionId=randomUUID(),completedJobId=randomUUID(),retryActionId=randomUUID(),failedJobId=randomUUID();
 const viewerActionId=randomUUID(),oldReportId=randomUUID(),oldRid=randomUUID();
 let ownerId='',viewerId='';
 const profileHash=hash({provider:'ollama',base_url:'http://127.0.0.1:11434',model_name:'generated-agent-fixture'});
 const probeBindingHash=hash({profile_hash:profileHash,secret_id:null,secret_version:null,adapter_version:MODEL_ADAPTER_VERSION,schema_hash:modelSchemaHash});
 const toolInput={schema_version:1,template_id:'change_timeline',release_id:'generated-release',page_limit:10,row_limit:20};
 const bindingA='a'.repeat(64),bindingB='b'.repeat(64),bindingC='c'.repeat(64);
 try{
  const client=await admin.connect();
  try{
   const identities=(await client.query('SELECT id FROM auth."user" ORDER BY "createdAt",id LIMIT 2')).rows;
   assert.equal(identities.length,2,'Two existing local synthetic identities are required for the permission acceptance.');
   ownerId=identities[0].id;viewerId=identities[1].id;
   await client.query('BEGIN');
   await client.query('SET CONSTRAINTS ALL DEFERRED');
   await client.query('INSERT INTO faultline.workspaces(id,name) VALUES($1,$2)',[wid,'Generated agent lifecycle acceptance']);
   for(const [actor,role] of [[ownerId,'owner'],[viewerId,'viewer']] as const)await client.query('INSERT INTO faultline.memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',[wid,actor,role]);
   await client.query('INSERT INTO faultline.cases(id,workspace_id,title,question,active_revision_id) VALUES($1,$2,$3,$4,$5)',[cid,wid,'Generated agent lifecycle','Can reviewed tools resume safely?',rid]);
   await client.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,value,content_hash) VALUES($1,$2,$3,$4,$5)',[rid,wid,cid,{title:'Generated agent lifecycle',question:'Can reviewed tools resume safely?'},'1'.repeat(64)]);
   await client.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,value,content_hash) VALUES($1,$2,$3,$4,$5)',[oldRid,wid,cid,{title:'Superseded generated revision'},'2'.repeat(64)]);
   await client.query("INSERT INTO faultline.model_profiles(id,workspace_id,name,provider,base_url,model_name,profile_hash,capabilities,probe_binding_hash,created_by) VALUES($1,$2,'Generated local model','ollama','http://127.0.0.1:11434','generated-agent-fixture',$3,$4,$5,$6)",[profileId,wid,profileHash,{status:'available'},probeBindingHash,ownerId]);
   await client.query("INSERT INTO faultline.agent_sessions(id,workspace_id,case_id,profile_id,objective,status,created_by) VALUES($1,$2,$3,$4,'Investigate the generated regression.','active',$5)",[sessionId,wid,cid,profileId,ownerId]);
   await client.query("INSERT INTO faultline.agent_turns(id,workspace_id,case_id,session_id,revision_id,actor_id,user_message,status) VALUES($1,$2,$3,$4,$5,$6,'Review bounded next actions.','succeeded')",[turnId,wid,cid,sessionId,rid,ownerId]);
   await client.query("INSERT INTO faultline.jobs(id,workspace_id,case_id,revision_id,kind,input_hash,input,status,result) VALUES($1,$2,$3,$4,'source_capture',$5,$6,'succeeded',$7)",[completedJobId,wid,cid,rid,hash(toolInput),toolInput,{capture_id:randomUUID(),status:'complete'}]);
   await client.query("INSERT INTO faultline.jobs(id,workspace_id,case_id,revision_id,kind,input_hash,input,status,attempt,error_code) VALUES($1,$2,$3,$4,'source_capture',$5,$6,'failed',1,'GENERATED_FAILURE')",[failedJobId,wid,cid,rid,hash(toolInput),toolInput]);
   await client.query("INSERT INTO faultline.agent_actions(id,workspace_id,case_id,session_id,turn_id,kind,title,reason,requires_approval,status,target_job_id,binding_hash,approved_by,approved_at,parameters) VALUES($1,$2,$3,$4,$5,'gather_related_evidence','Gather related evidence','Generated reviewed tool completion',true,'approved',$6,$7,$8,now(),'{}')",[completedActionId,wid,cid,sessionId,turnId,completedJobId,bindingA,ownerId]);
   await client.query("INSERT INTO faultline.agent_actions(id,workspace_id,case_id,session_id,turn_id,kind,title,reason,requires_approval,status,target_job_id,binding_hash,approved_by,approved_at,parameters,last_error_code) VALUES($1,$2,$3,$4,$5,'gather_related_evidence','Retry related evidence','Generated retry path',true,'failed',$6,$7,$8,now(),'{}','GENERATED_FAILURE')",[retryActionId,wid,cid,sessionId,turnId,failedJobId,bindingB,ownerId]);
   await client.query("INSERT INTO faultline.agent_actions(id,workspace_id,case_id,session_id,turn_id,kind,title,reason,requires_approval,status,binding_hash,parameters) VALUES($1,$2,$3,$4,$5,'open_evidence','Review evidence','Generated viewer denial',true,'suggested',$6,'{}')",[viewerActionId,wid,cid,sessionId,turnId,bindingC]);
   await client.query('INSERT INTO faultline.report_versions(id,workspace_id,case_id,value,binding) VALUES($1,$2,$3,$4,$5)',[oldReportId,wid,cid,{status:'published',revision_id:oldRid,title:'Superseded generated report'},{}]);
   await client.query('SET CONSTRAINTS ALL IMMEDIATE');
   await client.query('COMMIT');
  }finally{client.release();}

  await assert.rejects(approveAgentAction(wid,viewerId,'viewer-denial-'+randomUUID(),cid,viewerActionId,bindingC),code('FORBIDDEN'));
  await assert.rejects(saveReportMemory(wid,ownerId,'stale-report-'+randomUUID(),cid,{report_id:oldReportId,reviewed:true}),code('STALE_REPORT'));

  const directTurn=await createAgentTurn(wid,ownerId,'direct-turn-'+randomUUID(),cid,sessionId,{message:'Generated direct turn before tool reflection.',profile_id:profileId,revision_id:rid});
  await cancelJob(wid,ownerId,'direct-turn-cancel-'+randomUUID(),cid,directTurn.job_id,'Generated direct turn cleanup','0');

  assert.deepEqual(await reflectAgentActionJob(wid,completedJobId),{processed:1});
  let completed=(await admin.query('SELECT status,reflection_turn_id,tool_result,last_error_code FROM faultline.agent_actions WHERE workspace_id=$1 AND id=$2',[wid,completedActionId])).rows[0];
  assert.equal(completed.status,'completed',JSON.stringify(completed));
  assert.ok(completed.reflection_turn_id);assert.equal(completed.tool_result.status,'succeeded');
  let reflectionJob=(await admin.query('SELECT job_id,message_kind FROM faultline.agent_turns WHERE workspace_id=$1 AND id=$2',[wid,completed.reflection_turn_id])).rows[0];
  assert.equal(reflectionJob.message_kind,'tool');assert.ok(reflectionJob.job_id);
  await admin.query("UPDATE faultline.jobs SET status='failed',reserved_units=0,error_code='GENERATED_STOP',lease_until=NULL WHERE workspace_id=$1 AND id=$2",[wid,reflectionJob.job_id]);
  await admin.query('UPDATE faultline.budgets SET reserved=0 WHERE workspace_id=$1 AND case_id=$2',[wid,cid]);

  const restarted=await restartJob(wid,ownerId,'restart-'+randomUUID(),failedJobId,'1','retry');
  assert.equal(restarted.retry_of,failedJobId);
  let rebound=(await admin.query('SELECT status,target_job_id,last_error_code FROM faultline.agent_actions WHERE workspace_id=$1 AND id=$2',[wid,retryActionId])).rows[0];
  assert.equal(rebound.status,'approved');assert.equal(rebound.target_job_id,restarted.job_id);assert.equal(rebound.last_error_code,null);
  assert.deepEqual(await cancelJob(wid,ownerId,'cancel-'+randomUUID(),cid,restarted.job_id,'Generated cancellation','0'),{id:restarted.job_id,status:'cancelled'});
  assert.deepEqual(await reflectAgentActionJob(wid,restarted.job_id),{processed:1});
  rebound=(await admin.query('SELECT status,target_job_id,reflection_turn_id,tool_result FROM faultline.agent_actions WHERE workspace_id=$1 AND id=$2',[wid,retryActionId])).rows[0];
  assert.equal(rebound.status,'cancelled');assert.equal(rebound.tool_result.status,'cancelled');assert.ok(rebound.reflection_turn_id);
  reflectionJob=(await admin.query('SELECT job_id,message_kind FROM faultline.agent_turns WHERE workspace_id=$1 AND id=$2',[wid,rebound.reflection_turn_id])).rows[0];
  assert.equal(reflectionJob.message_kind,'tool');
  await admin.query("UPDATE faultline.jobs SET status='failed',reserved_units=0,error_code='GENERATED_STOP',lease_until=NULL WHERE workspace_id=$1 AND id=$2",[wid,reflectionJob.job_id]);
  await admin.query('UPDATE faultline.budgets SET reserved=0 WHERE workspace_id=$1 AND case_id=$2',[wid,cid]);

  const retried=await approveAgentAction(wid,ownerId,'action-retry-'+randomUUID(),cid,retryActionId,bindingB);
  assert.equal(retried.status,'approved');assert.notEqual(retried.target_job_id,restarted.job_id);assert.equal(retried.reflection_turn_id,null);
  assert.ok(retried.target_job_id);
  const retriedJobId=retried.target_job_id;
  const exact=(await admin.query('SELECT retry_of,input,input_hash,status FROM faultline.jobs WHERE workspace_id=$1 AND id=$2',[wid,retriedJobId])).rows[0];
  assert.equal(exact.retry_of,restarted.job_id);assert.deepEqual(exact.input,toolInput);assert.equal(exact.input_hash,hash(toolInput));assert.equal(exact.status,'queued');
  await cancelJob(wid,ownerId,'final-cancel-'+randomUUID(),cid,retriedJobId,'Generated cleanup','0');
 }finally{
  try{
   await admin.query("UPDATE faultline.jobs SET status='cancelled',reserved_units=0,lease_until=NULL WHERE workspace_id=$1 AND status IN('queued','running','cancel_requested')",[wid]);
   await admin.query('UPDATE faultline.budgets SET reserved=0 WHERE workspace_id=$1',[wid]);
   await admin.query('UPDATE faultline.workspaces SET deletion_requested_at=now() WHERE id=$1',[wid]);
   const cleanup=await admin.connect();try{await cleanup.query('BEGIN');await cleanup.query("SELECT set_config('faultline.workspace_id',$1,true)",[wid]);await cleanup.query('SELECT faultline.purge_workspace_data()');await cleanup.query('COMMIT');}finally{cleanup.release();}
  }catch{/* Keep the original assertion failure; generated workspace IDs are printed by the test runner on inspection. */}
  await admin.end();
  if(previousLocalOrigins===undefined)delete process.env.MODEL_LOCAL_ORIGINS;else process.env.MODEL_LOCAL_ORIGINS=previousLocalOrigins;
 }
});
