import {transaction,type Tx} from '../../../database/src/client.js';
import {getCaseTx} from '../cases/service.js';
import {command,audit,access} from '../workspaces/service.js';
import {newId,hash} from '../canonical.js';
import {demand} from '../errors.js';
export async function enqueue(tx:Tx,wid:string,caseId:string,revisionId:string,kind:string,input:unknown){
 await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid]);
 const activeCase=(await tx.query("SELECT id FROM faultline.cases WHERE workspace_id=$1 AND id=$2 AND lifecycle='open' AND NOT archived AND deletion_requested_at IS NULL",[wid,caseId])).rows[0];demand(activeCase,'CASE_INACTIVE','Reopen or restore this investigation before running work.',409);
 const busy=await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND status IN('queued','running','cancel_requested') UNION ALL SELECT id FROM faultline.provider_operations WHERE workspace_id=$1 AND status IN('queued','running','cancel_requested') LIMIT 1",[wid]);
 demand(!busy.rowCount,'WORKSPACE_BUSY','One expensive run may be active per workspace. Wait or cancel the current run.',429);
 await tx.query('INSERT INTO faultline.budgets(workspace_id,case_id,revision_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[wid,caseId,revisionId]);
 demand((await tx.query('SELECT faultline.admit_run_slot() AS available')).rows[0]?.available,'INSTALLATION_BUSY','Two expensive jobs are already active on this installation.',429);
 await reserve(tx,wid,caseId,revisionId,1);
 const id=newId();
 await tx.query("INSERT INTO faultline.jobs(id,workspace_id,case_id,revision_id,kind,input_hash,input,status,reserved_units) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',1)",[id,wid,caseId,revisionId,kind,hash(input),input]);
 await tx.query('INSERT INTO faultline.job_outbox(id,workspace_id,job_id) VALUES($1,$2,$3)',[newId(),wid,id]);
 await tx.query('INSERT INTO faultline.job_events(workspace_id,case_id,job_id,event) VALUES($1,$2,$3,$4)',[wid,caseId,id,{status:'queued'}]);
 return {job_id:id,status:'queued'};
}
export async function getJob(wid:string,pid:string,caseId:string,id:string){
 return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId);return getWorkspaceJobTx(tx,wid,pid,id);});
}
async function settle(tx:Tx,wid:string,job:{id:string;case_id:string;revision_id:string;reserved_units:number},spent:boolean){
 if(!job.reserved_units)return;
 await tx.query('UPDATE faultline.budgets SET reserved=reserved-$4,spent=spent+$5 WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3',[wid,job.case_id,job.revision_id,job.reserved_units,spent?job.reserved_units:0]);
 await tx.query('UPDATE faultline.jobs SET reserved_units=0 WHERE workspace_id=$1 AND id=$2',[wid,job.id]);
}
export async function cancelJob(wid:string,pid:string,key:string,caseId:string,id:string,reason:string,match:string){
 return command(wid,pid,'job.cancel',key,{caseId,id,reason,match},async tx=>{
  await getCaseTx(tx,wid,pid,caseId,true);const old=(await tx.query('SELECT * FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE',[wid,caseId,id])).rows[0];demand(old,'NOT_FOUND','Job unavailable.',404);
  demand(String(old.attempt)===match,'STALE_INPUTS','Job attempt changed.',409);
  if(['cancelled','succeeded','failed'].includes(old.status))return {id,status:old.status};
  const status=old.status==='running'?'cancel_requested':'cancelled';
  await tx.query('UPDATE faultline.jobs SET status=$2,updated_at=now() WHERE id=$1',[id,status]);
  if(status==='cancelled')await settle(tx,wid,old,false);
  await tx.query('INSERT INTO faultline.job_events(workspace_id,case_id,job_id,event) VALUES($1,$2,$3,$4)',[wid,caseId,id,{status}]);await audit(tx,wid,pid,'job.cancel',{case_id:caseId,job_id:id,reason});return {id,status};
 });
}
export async function claimJob(wid:string,id:string){
 return transaction(wid,async tx=>{
  const job=(await tx.query('SELECT *,lease_until>now() AS live_lease FROM faultline.jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[wid,id])).rows[0];demand(job,'NOT_FOUND','Stored routing does not match a job.',404);
  if(['succeeded','failed','cancelled','waiting_for_input'].includes(job.status))return null;
  if(job.status==='cancel_requested'){
   await settle(tx,wid,job,false);await tx.query("UPDATE faultline.jobs SET status='cancelled',fence=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[id]);
   await tx.query('INSERT INTO faultline.job_events(workspace_id,case_id,job_id,event) VALUES($1,$2,$3,$4)',[wid,job.case_id,id,{status:'cancelled'}]);return null;
  }
  if(job.status==='running'&&job.live_lease)return null;
  demand(hash(job.input)===job.input_hash,'INPUT_HASH_MISMATCH','Stored job input differs.',409);
  const fence=newId();await tx.query("UPDATE faultline.jobs SET status='running',attempt=attempt+1,fence=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1",[id,fence]);
  await tx.query('INSERT INTO faultline.job_events(workspace_id,case_id,job_id,event) VALUES($1,$2,$3,$4)',[wid,job.case_id,id,{status:'running',attempt:job.attempt+1}]);return {...job,fence,attempt:job.attempt+1};
 });
}
export async function renewLease(wid:string,id:string,fence:string){
 return transaction(wid,async tx=>{const r=await tx.query("UPDATE faultline.jobs SET lease_until=now()+interval '60 seconds' WHERE workspace_id=$1 AND id=$2 AND fence=$3 AND status='running' AND lease_until>now() RETURNING id",[wid,id,fence]);return !!r.rowCount;});
}
/** Atomically settle a published domain result with its job in the caller's transaction. */
export async function finishJobTx(tx:Tx,wid:string,id:string,fence:string,status:'succeeded'|'failed'|'waiting_for_input',result:unknown,errorCode:string|null=null){
 const current=(await tx.query('SELECT *,lease_until>now() AS live_lease FROM faultline.jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[wid,id])).rows[0];
 demand(current&&current.fence===fence,'FENCED_ATTEMPT','Attempt is no longer current.',409);
 // A worker may acknowledge an already committed atomic publication. Only the
 // same fence, outcome, complete result and error may replay without settlement.
 if(['succeeded','failed','waiting_for_input'].includes(current.status)){
  demand(current.status===status&&hash(current.result)===hash(result)&&current.error_code===errorCode,'FENCED_ATTEMPT','Completed attempt acknowledgement differs.',409);
  return current.status;
 }
 demand(current.live_lease&&['running','cancel_requested'].includes(current.status),'FENCED_ATTEMPT','Attempt cannot publish.',409);
 const terminal=current.status==='cancel_requested'?'cancelled':status;
 await settle(tx,wid,current,terminal==='succeeded'||terminal==='failed');
 await tx.query('UPDATE faultline.jobs SET status=$2,result=$3,error_code=$4,lease_until=NULL,updated_at=now() WHERE id=$1',[id,terminal,terminal==='cancelled'?null:result,errorCode]);
 await tx.query('INSERT INTO faultline.job_events(workspace_id,case_id,job_id,event) VALUES($1,$2,$3,$4)',[wid,current.case_id,id,{status:terminal}]);return terminal;
}
export async function finishJob(wid:string,id:string,fence:string,status:'succeeded'|'failed'|'waiting_for_input',result:unknown,errorCode:string|null=null){
 return transaction(wid,tx=>finishJobTx(tx,wid,id,fence,status,result,errorCode));
}
export async function reserve(tx:Tx,wid:string,caseId:string,revisionId:string,amount:number){
 demand(Number.isSafeInteger(amount)&&amount>0,'INVALID_BUDGET','Reservation must be a positive integer.');
 const result=await tx.query('UPDATE faultline.budgets SET reserved=reserved+$4 WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3 AND reserved+spent+$4<=ceiling RETURNING reserved,spent,ceiling',[wid,caseId,revisionId,amount]);demand(result.rows[0],'BUDGET_EXHAUSTED','Review the revision budget before continuing.',429);return result.rows[0];
}
async function getWorkspaceJobTx(tx:Tx,wid:string,pid:string,id:string){
 const role=await access(tx,wid,pid);const row=(await tx.query('SELECT id,workspace_id,case_id,revision_id,kind,status,attempt,retry_of,result,error_code,created_at,updated_at FROM faultline.jobs WHERE workspace_id=$1 AND id=$2',[wid,id])).rows[0];demand(row,'NOT_FOUND','Job unavailable.',404);await getCaseTx(tx,wid,pid,row.case_id);return role==='viewer'&&row.kind==='redaction_preview'?{...row,result:null}:row;
}
export async function getWorkspaceJob(wid:string,pid:string,id:string){return transaction(wid,tx=>getWorkspaceJobTx(tx,wid,pid,id));}
export async function jobEvents(wid:string,pid:string,id:string,after:string){
 return transaction(wid,async tx=>{await getWorkspaceJobTx(tx,wid,pid,id);return (await tx.query(`SELECT seq::text,event,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM faultline.job_events WHERE workspace_id=$1 AND job_id=$2 AND seq>$3::bigint ORDER BY seq LIMIT 200`,[wid,id,after])).rows;});
}

export async function restartJob(wid:string,pid:string,key:string,id:string,match:string,mode:'retry'|'resume',prerequisiteIds:string[]=[]){
 return command(wid,pid,'job.'+mode,key,{id,match,prerequisiteIds},async tx=>{
  const old=(await tx.query('SELECT * FROM faultline.jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[wid,id])).rows[0];demand(old,'NOT_FOUND','Job unavailable.',404);
  const investigation=await getCaseTx(tx,wid,pid,old.case_id,true);demand(String(old.attempt)===match,'STALE_INPUTS','Job attempt changed.',409);
  demand(mode==='retry'?old.status==='failed':old.status==='waiting_for_input','INVALID_JOB_STATE','Only failed work can retry; only waiting work can resume.',409);
  demand(old.revision_id===investigation.active_revision_id&&hash(old.input)===old.input_hash,'STALE_INPUTS','Review a new job for changed inputs.',409);
  demand(['import_commit','comparison_compute','analytic_compute','browser_execute','external_browser_execute','followup_due','source_capture','model_proposal','agent_turn','redaction_preview','redaction_apply'].includes(old.kind),'PREREQUISITE_UNAVAILABLE','The requested handler is unavailable.',409);
  demand(!prerequisiteIds.length,'UNKNOWN_PREREQUISITE','Resume preserves the reviewed immutable inputs; arbitrary prerequisite replacements require a new run.',409);
  const next=await enqueue(tx,wid,old.case_id,old.revision_id,old.kind,old.input);
  await tx.query('UPDATE faultline.jobs SET retry_of=$3 WHERE workspace_id=$1 AND id=$2',[wid,next.job_id,id]);
  // A reviewed agent action follows the immutable retry job. Without this
  // rebinding, the action would keep watching the failed attempt forever and
  // the worker could never reflect the successful retry back into the run.
  await tx.query("UPDATE faultline.agent_actions SET target_job_id=$3,status='approved',tool_result=NULL,reflection_turn_id=NULL,last_error_code=NULL,updated_at=now() WHERE workspace_id=$1 AND target_job_id=$2 AND status IN('approved','failed','cancelled')",[wid,id,next.job_id]);
  await audit(tx,wid,pid,'job.'+mode,{case_id:old.case_id,job_id:next.job_id,retry_of:id,original_attempt:old.attempt,original_input_hash:old.input_hash});return {...next,retry_of:id,attempt:0};
 });
}
export async function listJobs(wid:string,pid:string){return transaction(wid,async tx=>{await access(tx,wid,pid);return (await tx.query('SELECT id,case_id,revision_id,kind,status,attempt,retry_of,error_code,created_at,updated_at FROM faultline.jobs WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 200',[wid])).rows;});}
