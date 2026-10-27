import {revisionCallAllowanceTx} from '../budgets/service.js';
import configDefaults from '../../../../config/defaults.json' with {type:'json'};
import {approvePolicyRetentionTx,assertResourceRetainedTx} from '../retention/policy.js';
import {transaction,type Tx} from '../../../database/src/client.js';
import {command,access,audit,expected} from '../workspaces/service.js';
import {getCaseTx} from '../cases/service.js';
import {newId,hash} from '../canonical.js';
import {demand} from '../errors.js';
import {seal,open,loadKeyring} from '../secrets/keyring.js';
import {encodeCursor,decodeCursor} from '../cases/cursor.js';
import {operationAssessmentTx,type OperationSelection} from '../preflight/service.js';
import {activityFilters,activityScope,activityQuery,type ActivityQuery} from './activity-filter.js';
const defaults={max_automatic_model_calls:configDefaults.ai.maxCalls,max_input_tokens:configDefaults.ai.maxInputTokens,max_output_tokens:configDefaults.ai.maxOutputTokens,max_records_per_snapshot:100000,raw_upload_retention_days:30,canonical_event_retention_days:configDefaults.retention.canonicalEventDays,attachment_retention_days:configDefaults.retention.attachmentDays,report_retention_days:configDefaults.retention.reportDays,audit_retention_days:configDefaults.retention.auditDays};
export async function policyTx(tx:Tx,wid:string){
 await tx.query('INSERT INTO faultline.workspace_policies(workspace_id,value,privacy_value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[wid,defaults,{policy_version:'owner-review-v1',viewer_evidence_mode:'minimized'}]);
 return (await tx.query('SELECT * FROM faultline.workspace_policies WHERE workspace_id=$1',[wid])).rows[0];
}
export async function getPolicy(wid:string,pid:string,privacy=false){return transaction(wid,async tx=>{await access(tx,wid,pid,['owner']);const row=await policyTx(tx,wid);return {value:privacy?row.privacy_value:row.value,revision:privacy?row.privacy_revision:row.revision,installation_ceilings:{...defaults,...Object.fromEntries(Object.keys(defaults).filter(k=>k.endsWith("_days")).map(k=>[k,3650]))},retention:'Referenced evidence must be withdrawn and dependent claims invalidated before sensitive bytes are removed.'};});}
export async function updatePolicy(wid:string,pid:string,key:string,input:Record<string,unknown>,match:string,privacy=false){
 const request=input,{retention_review_token,retention_effective_at,...policyPatch}=input;if(!privacy)input=policyPatch;
 return command(wid,pid,privacy?'privacy.update':'policy.update',key,{input:request,match},async tx=>{
  await access(tx,wid,pid,['owner']);const row=await policyTx(tx,wid);expected(match,privacy?row.privacy_revision:row.revision);demand(Object.keys(input).length>0,'INVALID_INPUT','Choose a policy change.');
  if(!privacy)for(const [field,value]of Object.entries(input)){demand(field in defaults&&Number.isSafeInteger(value),'INVALID_POLICY','Unknown or nonintegral policy field.');const max=field.endsWith('_days')?3650:(defaults as Record<string,number>)[field]!;demand(Number(value)>=((field.includes('model')||field.includes('tokens'))?0:1)&&Number(value)<=max,'INSTALLATION_CEILING','Policy can only tighten configured resource ceilings.');}
  const retention=privacy?null:await approvePolicyRetentionTx(tx,wid,pid,input,row,typeof retention_review_token==='string'?retention_review_token:undefined);
  const value={...(privacy?row.privacy_value:row.value),...input};await tx.query(privacy?'UPDATE faultline.workspace_policies SET privacy_value=$2,privacy_revision=privacy_revision+1 WHERE workspace_id=$1':'UPDATE faultline.workspace_policies SET value=$2,revision=revision+1 WHERE workspace_id=$1',[wid,value]);
  if(privacy&&hash(value)!==hash(row.privacy_value))await tx.query("UPDATE faultline.evidence SET redaction_status='restricted',revision=revision+1 WHERE workspace_id=$1 AND redaction_status='sanitized' AND id IN(SELECT evidence_id FROM faultline.evidence_artifacts WHERE workspace_id=$1 AND kind='reviewed_text_derivative' UNION SELECT (d.value->>'id')::uuid FROM faultline.jobs j CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.result->'derivatives','[]'::jsonb)) d(value) WHERE j.workspace_id=$1 AND j.kind='redaction_apply' AND j.status='succeeded')",[wid]);
  await audit(tx,wid,pid,privacy?'privacy.update':'policy.update',{fields:Object.keys(input),policy_hash:hash(value)});return {value,revision:(privacy?row.privacy_revision:row.revision)+1,...(retention?{retention}: {})};
 });
}
export async function budgets(wid:string,pid:string){return transaction(wid,async tx=>{await access(tx,wid,pid,['owner','analyst']);const rows=(await tx.query('SELECT case_id,revision_id,ceiling,reserved,spent FROM faultline.budgets WHERE workspace_id=$1 ORDER BY case_id,revision_id',[wid])).rows;return {work_units:rows,model_calls:'Agent requests have a separate limit.',model_usage:(await tx.query('SELECT case_id,revision_id,calls_reserved,calls_spent,input_reserved,input_spent,output_reserved,output_spent FROM faultline.model_budgets WHERE workspace_id=$1 ORDER BY case_id,revision_id',[wid])).rows,owner_extensions:(await tx.query('SELECT id,case_id,revision_id,additional_calls,reason,actor_id,created_at FROM faultline.model_budget_extensions WHERE workspace_id=$1 ORDER BY created_at,id',[wid])).rows,maximum_owner_granted_calls:configDefaults.ai.maxOwnerGrantedCalls,token_allowance_increased:false,installation_expensive_jobs:2,workspace_expensive_jobs:1};});}
export async function preflight(wid:string,pid:string,cid:string,selection:OperationSelection={}){return transaction(wid,async tx=>{
 const item=await getCaseTx(tx,wid,pid,cid),role=await access(tx,wid,pid),revision=(await tx.query('SELECT value FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,item.active_revision_id])).rows[0];
 const policy=(await tx.query('SELECT value FROM faultline.workspace_policies WHERE workspace_id=$1',[wid])).rows[0]?.value??defaults;
 const storage=(await tx.query('SELECT ceiling,used_bytes,reserved_bytes FROM faultline.case_storage WHERE workspace_id=$1 AND case_id=$2',[wid,cid])).rows[0];
 const units=role==='viewer'?null:(await tx.query('SELECT ceiling,spent,reserved FROM faultline.budgets WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3',[wid,cid,item.active_revision_id])).rows[0]??null;
 const modelUsage=role==='viewer'?null:(await tx.query('SELECT calls_spent,calls_reserved,input_spent,input_reserved,output_spent,output_reserved FROM faultline.model_budgets WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3',[wid,cid,item.active_revision_id])).rows[0]??null;
 const callAllowance=await revisionCallAllowanceTx(tx,wid,cid,item.active_revision_id,Math.min(configDefaults.ai.maxCalls,policy.max_automatic_model_calls));
 const selected=revision.value.snapshot_id?(await tx.query('SELECT value FROM faultline.snapshots WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,revision.value.snapshot_id])).rows[0]:null;
 const size=(value:unknown)=>{const number=Number(value);demand(value!==null&&value!==undefined&&Number.isSafeInteger(number)&&number>=0,'INVALID_PREFLIGHT_METADATA','Recorded limits or accounting are unavailable.',503);return number;};
 const limits=configDefaults.limits,ai=configDefaults.ai,runner=configDefaults.runner,jobs=configDefaults.jobs;
 const assessment=selection.operation?await operationAssessmentTx(tx,wid,pid,cid,item,revision,role,selection,units,storage):undefined;
 return {...(assessment?{assessment}:{}),case_id:cid,revision_id:item.active_revision_id,manual:true,metric:revision.value.metric_id?'frozen':'required',snapshot:revision.value.snapshot_id?'frozen':'required',active_work:!!(await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND status IN('queued','running','cancel_requested') LIMIT 1",[wid,cid])).rowCount,model:process.env.MODEL_PROVIDER??'none',runner:process.env.RUNNER_MODE??'disabled',
  selected_input:{snapshot_id:revision.value.snapshot_id??null,records:selected?size(selected.value.record_count):null},
  limits:{source:{file_bytes:limits.sourceFileBytes,expanded_bytes:limits.sourceExpandedBytes,records:Math.min(limits.sourceRecords,size(policy.max_records_per_snapshot)),files:limits.sourceFilesPerCapture,json_depth:limits.jsonDepth,csv_field_bytes:limits.csvFieldBytes},metric:{cohorts:limits.maxCohorts,period_days:limits.maxPeriodDays,horizon_seconds:configDefaults.metric.horizonSeconds},storage:{ceiling_bytes:storage?size(storage.ceiling):limits.caseStorageBytes,used_bytes:storage&&role!=='viewer'?size(storage.used_bytes):null,reserved_bytes:storage&&role!=='viewer'?size(storage.reserved_bytes):null,remaining_bytes:storage&&role!=='viewer'?size(storage.ceiling)-size(storage.used_bytes)-size(storage.reserved_bytes):null},model:{...callAllowance,maximum_owner_granted_calls:ai.maxOwnerGrantedCalls,token_allowance_increased:false,input_tokens:Math.min(ai.maxInputTokens,size(policy.max_input_tokens)),output_tokens:Math.min(ai.maxOutputTokens,size(policy.max_output_tokens)),call_timeout_seconds:ai.callTimeoutSeconds},jobs:{source_capture_deadline_seconds:jobs.activeRunDeadlineSeconds,workspace_concurrency:jobs.maxExpensivePerWorkspace,installation_concurrency:jobs.maxPerWorker,cancel_poll_seconds:jobs.cancellationPollSeconds},browser:{enabled:process.env.RUNNER_MODE==='trusted_fixture'&&process.env.NODE_ENV!=='production',task_timeout_seconds:runner.taskTimeoutSeconds,matrix_cells:runner.maxMatrixCells,repeats_per_cell:runner.repeatsPerCell,actions_per_cell:runner.maxActionsPerCell,artifact_bytes:runner.maxArtifactBytes}},
  usage:{work_units:units?{ceiling:size(units.ceiling),spent:size(units.spent),reserved:size(units.reserved),remaining:size(units.ceiling)-size(units.spent)-size(units.reserved)}:null,model:modelUsage?Object.fromEntries(['calls_spent','calls_reserved','input_spent','input_reserved','output_spent','output_reserved'].map(field=>[field,size(modelUsage[field])])):null},
  quality:'Limits are enforced ceilings, not cost or duration predictions. Coverage, current authority and dependency freshness are checked again by each operation; prerequisite availability is not a passing test.'};
});}
export async function activity(wid:string,pid:string,query:ActivityQuery={},ownerAudit=false){
 return transaction(wid,async tx=>{await access(tx,wid,pid,ownerAudit?['owner']:['owner','analyst','viewer']);const filters=activityFilters(query,ownerAudit),limit=filters.limit;
 const scope=activityScope(wid,pid,ownerAudit,filters),cursor=decodeCursor(filters.cursor,scope),selection=activityQuery(wid,pid,ownerAudit,filters,cursor);
 const rows=(await tx.query(selection.text,selection.values)).rows,last=rows[Math.min(rows.length,limit)-1];
 if(ownerAudit)for(const row of rows)try{await assertResourceRetainedTx(tx,wid,'audit',row.id);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='RETENTION_EXPIRED'){row.details={content_expired:true};row.actor_id=null;}else throw error;}
 return {data:rows.slice(0,limit),page:{next_cursor:rows.length>limit&&last?encodeCursor(scope,{created_at:last.created_at,id:last.id}):null}};
 });
}
export async function markRead(wid:string,pid:string,key:string,id:string){return command(wid,pid,'notification.read',key,{id},async tx=>{await access(tx,wid,pid);const row=(await tx.query('UPDATE faultline.notifications SET read_at=COALESCE(read_at,now()) WHERE workspace_id=$1 AND id=$2 AND user_id=$3 RETURNING id,read_at',[wid,id,pid])).rows[0];demand(row,'NOT_FOUND','Notification unavailable.',404);return row;});}
export async function createSecretTx(tx:Tx,wid:string,purpose:string,value:string){
 const id=newId(),ring=await loadKeyring(),ciphertext=seal(value,wid+':'+id+':1',ring);
 await tx.query('INSERT INTO faultline.secrets(id,workspace_id,purpose,key_version,ciphertext) VALUES($1,$2,$3,$4,$5)',[id,wid,purpose,ring.active,ciphertext]);
 await tx.query('INSERT INTO faultline.secret_versions(id,workspace_id,secret_id,version,key_version,ciphertext) VALUES($1,$2,$3,1,$4,$5)',[newId(),wid,id,ring.active,ciphertext]);return {id,revision:1,active_version:1,purpose,revoked:false};
}
export async function readSecretTx(tx:Tx,wid:string,id:string,version?:number){
 const secret=(await tx.query('SELECT id,purpose,active_version,revoked FROM faultline.secrets WHERE workspace_id=$1 AND id=$2',[wid,id])).rows[0];demand(secret&&!secret.revoked,'SECRET_UNAVAILABLE','Credential revoked or absent.',409);
 const v=version??secret.active_version;demand(v===secret.active_version,'SECRET_VERSION_CHANGED','Review a new job after credential rotation.',409);
 const row=(await tx.query('SELECT ciphertext FROM faultline.secret_versions WHERE workspace_id=$1 AND secret_id=$2 AND version=$3',[wid,id,v])).rows[0];demand(row,'SECRET_UNAVAILABLE','Credential version unavailable.',409);return open(row.ciphertext,wid+':'+id+':'+v,await loadKeyring());
}
export async function rotateSecret(wid:string,pid:string,key:string,id:string,value:string,match:string){
 return transaction(wid,async tx=>{await access(tx,wid,pid,['owner']);demand(false,'REPLACEMENT_REVIEW_REQUIRED','Stage a replacement, explicitly probe it, then review its exact binding before activation.',409);});
}
export async function revokeSecret(wid:string,pid:string,key:string,id:string,cancel:boolean,match:string){
 return command(wid,pid,'secret.revoke',key,{id,cancel,match},async tx=>{await access(tx,wid,pid,['owner']);const row=(await tx.query('SELECT revision FROM faultline.secrets WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[wid,id])).rows[0];demand(row,'NOT_FOUND','Credential unavailable.',404);expected(match,row.revision);
 demand(typeof cancel==='boolean','INVALID_INPUT','Choose explicit dependent-work cancellation.');
 const active=(await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND input->>'secret_id'=$2 AND status IN('queued','running','cancel_requested') UNION ALL SELECT id FROM faultline.provider_operations WHERE workspace_id=$1 AND input->>'secret_id'=$2 AND status IN('queued','running','cancel_requested') UNION ALL SELECT id FROM faultline.secret_replacements WHERE workspace_id=$1 AND secret_id=$2::uuid AND status='probing' AND probe_expires_at>now()",[wid,id])).rows;
 demand(cancel||!active.length,'ACTIVE_DEPENDENCIES','Cancel dependent work explicitly before revoking.',409);await tx.query('UPDATE faultline.secrets SET revoked=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[wid,id]);
 if(cancel){await tx.query("UPDATE faultline.jobs SET status='cancel_requested' WHERE workspace_id=$1 AND input->>'secret_id'=$2 AND status IN('queued','running')",[wid,id]);await tx.query("UPDATE faultline.provider_operations SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,updated_at=now() WHERE workspace_id=$1 AND input->>'secret_id'=$2 AND status IN('queued','running')",[wid,id]);}
 await tx.query("UPDATE faultline.secret_replacements SET status='failed',probe_nonce=NULL,probe_binding_hash=NULL,capabilities=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND secret_id=$2 AND status IN('staged','probing','probed')",[wid,id]);
 await audit(tx,wid,pid,'secret.revoke',{secret_id:id,cancelled_job_count:cancel?active.length:0});return {id,revoked:true,revision:row.revision+1};
 });
}
