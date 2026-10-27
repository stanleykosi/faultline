import {transaction,type Tx} from '../../../database/src/client.js';
import type {FaultlineEvidence} from '../../../contracts/src/generated.js';
import {validateContract} from '../../../contracts/src/validate.js';
import {getCaseTx} from '../cases/service.js';
import {evidenceTx} from '../investigation/service.js';
import {access,audit,command,expected} from '../workspaces/service.js';
import {policyTx} from '../controls/service.js';
import {loadKeyring} from '../secrets/keyring.js';
import {enqueue,finishJobTx} from '../jobs/service.js';
import {hash,newId,now} from '../canonical.js';
import {demand} from '../errors.js';
import {REDACTION_POLICY_VERSION,redactApprovedText} from './redaction.js';

type Binding={policy_version:string;policy_hash:string;privacy_revision:number;key_version:string};
type EvidenceBinding={id:string;revision:number;content_hash:string;value_hash:string};
type RedactionJob={id:string;workspace_id:string;case_id:string;revision_id:string;fence:string;input:any};
async function approvedPolicy(tx:Tx,wid:string,version:string){
 const policy=await policyTx(tx,wid);
 demand(version===REDACTION_POLICY_VERSION&&policy.privacy_value.policy_version===version,'REDACTION_POLICY_UNSUPPORTED','An owner must select the supported finite contact-secrets-v1 privacy policy.',409);
 return {policy_version:version,policy_hash:hash(policy.privacy_value),privacy_revision:policy.privacy_revision};
}
async function retainedKey(tx:Tx,wid:string,cid:string,pin=false){
 const ring=await loadKeyring();
 if(pin)await tx.query('INSERT INTO faultline.case_redaction_keys(workspace_id,case_id,key_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[wid,cid,ring.active]);
 const row=(await tx.query('SELECT key_version FROM faultline.case_redaction_keys WHERE workspace_id=$1 AND case_id=$2',[wid,cid])).rows[0];
 const key=Buffer.from(ring.keys[row?.key_version]??'','base64');demand(key.length===32,'REDACTION_KEY_UNAVAILABLE','Retain the pinned investigation privacy key.',503);
 return {key,key_version:row.key_version as string};
}
async function evidenceBindings(tx:Tx,wid:string,cid:string,ids:string[]){
 demand(ids.length>0&&ids.length<=100&&new Set(ids).size===ids.length,'INVALID_REDACTION_SELECTION','Select1..100 distinct evidence records.');
 const records=await evidenceTx(tx,wid,cid,ids);
 demand(records.every(row=>row.redaction_status!=='withdrawn'&&row.text.length<=8000),'EVIDENCE_UNAVAILABLE','Select available bounded evidence excerpts.',409);
 const revisions=(await tx.query('SELECT id,revision FROM faultline.evidence WHERE workspace_id=$1 AND case_id=$2 AND id=ANY($3::uuid[]) ORDER BY id',[wid,cid,ids])).rows;
 return {records,bindings:revisions.map(row=>{const value=records.find(item=>item.id===row.id)!;return {id:row.id,revision:row.revision,content_hash:value.content_hash,value_hash:hash(value)} as EvidenceBinding;})};
}
async function currentInputs(tx:Tx,job:RedactionJob,binding:Binding,inputs:EvidenceBinding[]){
 await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[job.workspace_id]);
 const cid=job.case_id,wid=job.workspace_id,item=await getCaseTx(tx,wid,job.input.actor_id,cid,true);
 demand(item.active_revision_id===job.revision_id,'STALE_INPUTS','Investigation changed after redaction review.',409);
 const policy=await approvedPolicy(tx,wid,binding.policy_version),key=await retainedKey(tx,wid,cid);
 demand(hash({...policy,key_version:key.key_version})===hash(binding),'STALE_INPUTS','Privacy policy or retained key binding changed.',409);
 const current=await evidenceBindings(tx,wid,cid,inputs.map(x=>x.id));
 demand(hash(current.bindings)===hash(inputs),'STALE_INPUTS','Evidence changed after redaction review.',409);
 const lease=(await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND id=$3 AND fence=$4 AND status='running' AND lease_until>now() FOR UPDATE",[wid,cid,job.id,job.fence])).rowCount;
 demand(lease,'CANCELLED_OR_FENCED','The redaction attempt cannot publish.',409);
 return {...current,key};
}
export async function queueRedactionPreview(wid:string,pid:string,key:string,cid:string,input:{evidence_ids:string[];policy_version:string}){
 return command(wid,pid,'redaction.preview',key,{cid,input},async tx=>{
  const item=await getCaseTx(tx,wid,pid,cid,true),policy=await approvedPolicy(tx,wid,input.policy_version),retained=await retainedKey(tx,wid,cid,true),selected=await evidenceBindings(tx,wid,cid,input.evidence_ids);
  return enqueue(tx,wid,cid,item.active_revision_id,'redaction_preview',{actor_id:pid,binding:{...policy,key_version:retained.key_version},evidence: selected.bindings});
 });
}
export async function redactionPreviewHandler(job:RedactionJob){
 return transaction(job.workspace_id,async tx=>{
  const current=await currentInputs(tx,job,job.input.binding,job.input.evidence),id=newId();
  const rows=current.bindings.map(input=>{const original=current.records.find(row=>row.id===input.id)!;return {...input,redaction:redactApprovedText({text:original.text,workspace_id:job.workspace_id,case_id:job.case_id,policy_version:job.input.binding.policy_version,key:current.key.key})};});
  const value={binding:job.input.binding,evidence:current.bindings,rows,review_status:'preview_only',limitations:['Review the exact minimized text. Only the selected finite policy is applied; other sensitive text can remain. Original files and attachments are not sanitized by this operation.']},content_hash=hash(value);
  await tx.query('INSERT INTO faultline.redaction_previews(id,workspace_id,case_id,revision_id,job_id,value,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,job.workspace_id,job.case_id,job.revision_id,job.id,value,content_hash]);
  const result={preview_id:id,preview_hash:content_hash,revision_id:job.revision_id,...value};
  await finishJobTx(tx,job.workspace_id,job.id,job.fence,'succeeded',result);return result;
 });
}
export async function queueRedactionApply(wid:string,pid:string,key:string,cid:string,input:{preview_id:string;reason:string},match:string){
 return command(wid,pid,'redaction.apply',key,{cid,input,match},async tx=>{
  const item=await getCaseTx(tx,wid,pid,cid,true);expected(match,item.revision);demand(input.reason.trim().length>0,'INVALID_REASON','Explain why this minimized excerpt is approved.');
  const preview=(await tx.query("SELECT p.* FROM faultline.redaction_previews p JOIN faultline.jobs j ON j.workspace_id=p.workspace_id AND j.case_id=p.case_id AND j.id=p.job_id AND j.status='succeeded' WHERE p.workspace_id=$1 AND p.case_id=$2 AND p.id=$3",[wid,cid,input.preview_id])).rows[0];
  demand(preview&&preview.revision_id===item.active_revision_id&&hash(preview.value)===preview.content_hash,'STALE_INPUTS','Review a current complete immutable redaction preview.',409);
  const policy=await approvedPolicy(tx,wid,preview.value.binding.policy_version),retained=await retainedKey(tx,wid,cid),selected=await evidenceBindings(tx,wid,cid,preview.value.evidence.map((x:EvidenceBinding)=>x.id));
  demand(hash({...policy,key_version:retained.key_version})===hash(preview.value.binding)&&hash(selected.bindings)===hash(preview.value.evidence),'STALE_INPUTS','Privacy policy or evidence changed after preview.',409);
  demand(!(await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND kind='redaction_apply' AND input->>'preview_id'=$3 AND status='succeeded'",[wid,cid,preview.id])).rowCount,'PREVIEW_ALREADY_APPLIED','This preview has already been applied.',409);
  return enqueue(tx,wid,cid,item.active_revision_id,'redaction_apply',{actor_id:pid,preview_id:preview.id,preview_hash:preview.content_hash,binding:preview.value.binding,evidence:preview.value.evidence,reason:input.reason});
 });
}
export async function redactionApplyHandler(job:RedactionJob){
 return transaction(job.workspace_id,async tx=>{
  const wid=job.workspace_id,cid=job.case_id,current=await currentInputs(tx,job,job.input.binding,job.input.evidence);
  const preview=(await tx.query('SELECT * FROM faultline.redaction_previews WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,job.input.preview_id])).rows[0];
  demand(preview&&preview.content_hash===job.input.preview_hash&&hash(preview.value)===preview.content_hash,'STALE_INPUTS','Immutable redaction preview differs.',409);
  const derivatives=[];
  for(const row of preview.value.rows){
   const original=current.records.find(item=>item.id===row.id)!;const recomputed=redactApprovedText({text:original.text,workspace_id:wid,case_id:cid,policy_version:job.input.binding.policy_version,key:current.key.key});demand(hash(recomputed)===hash(row.redaction),'STALE_INPUTS','The reviewed deterministic redaction differs.',409);
   const id=newId(),value=validateContract<FaultlineEvidence>('evidence',{...original,id,revision_id:job.revision_id,text:recomputed.text,content_hash:hash({original_hash:original.content_hash,redaction:recomputed,key_version:current.key.key_version}),captured_at:now(),redaction_status:'sanitized',supersedes_id:original.id,artifact_refs:[]});
   await tx.query('INSERT INTO faultline.evidence(id,workspace_id,case_id,value,redaction_status) VALUES($1,$2,$3,$4,$5)',[id,wid,cid,value,'sanitized']);
   await tx.query("UPDATE faultline.evidence SET redaction_status='withdrawn',revision=revision+1 WHERE workspace_id=$1 AND case_id=$2 AND id=$3",[wid,cid,original.id]);
   await tx.query('INSERT INTO faultline.evidence_annotations(id,workspace_id,case_id,evidence_id,related_evidence_ids,kind,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId(),wid,cid,id,[original.id],'privacy_derivative',job.input.reason,job.input.actor_id]);derivatives.push({id,supersedes_id:original.id,content_hash:value.content_hash});
  }
  await audit(tx,wid,job.input.actor_id,'redaction.apply',{case_id:cid,preview_id:preview.id,preview_hash:preview.content_hash,policy_version:job.input.binding.policy_version,replacement_ids:derivatives.map(x=>x.id)});
  const result={preview_id:preview.id,derivatives,policy_version:job.input.binding.policy_version,pseudonym_scope:'workspace_case'};await finishJobTx(tx,wid,job.id,job.fence,'succeeded',result);return result;
 });
}
