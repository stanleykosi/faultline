import {assertResourceRetainedTx} from '../retention/policy.js';
import {transaction,type Tx} from '../../../database/src/client.js';
import {validateContract} from '../../../contracts/src/validate.js';
import type {FaultlineEvidence,FaultlineAnalyticPlan} from '../../../contracts/src/generated.js';
import {getCaseTx} from '../cases/service.js';
import {command,audit,expected,access} from '../workspaces/service.js';
import {newId,hash,now} from '../canonical.js';
import {demand} from '../errors.js';
import {enqueue,finishJobTx} from '../jobs/service.js';
import {eventRows,snapshotTx} from '../captures/service.js';
import {createManualHypothesis,reviseHypothesis,evaluateAnalyticPlan,type ManualHypothesisFields,type InvestigationBinding} from './index.js';
import {analyticEvidenceIds} from './analytic.js';
export async function bindingTx(tx:Tx,wid:string,pid:string,caseId:string,write=false){
 const investigation=await getCaseTx(tx,wid,pid,caseId,write);
 const revision=(await tx.query('SELECT * FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,investigation.active_revision_id])).rows[0];
 demand(revision.value.metric_id&&revision.value.snapshot_id,'INPUTS_REQUIRED','Freeze a metric and snapshot before analytic tests or reports.',409);
 const snapshot=await snapshotTx(tx,wid,caseId,revision.value.snapshot_id);
 const metric=(await tx.query('SELECT * FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,revision.value.metric_id])).rows[0];
 demand(metric?.state==='frozen'&&metric.metric_hash===revision.value.metric_hash&&snapshot.content_hash===revision.value.snapshot_hash,'STALE_INPUTS','Frozen input binding differs.',409);
 const binding:InvestigationBinding={workspace_id:wid,case_id:caseId,revision_id:revision.id,metric_hash:metric.metric_hash,snapshot_hash:snapshot.content_hash};
 const comparison=(await tx.query("SELECT c.* FROM faultline.comparisons c WHERE c.workspace_id=$1 AND c.case_id=$2 AND c.revision_id=$3 AND c.metric_hash=$4 AND c.snapshot_hash=$5 AND EXISTS(SELECT 1 FROM faultline.jobs j WHERE j.workspace_id=c.workspace_id AND j.case_id=c.case_id AND j.id=c.job_id AND j.status='succeeded') ORDER BY c.created_at DESC LIMIT 1",[wid,caseId,revision.id,binding.metric_hash,binding.snapshot_hash])).rows[0];
 return {investigation,revision,snapshot,metric,binding,comparison};
}
export async function evidenceTx(tx:Tx,wid:string,caseId:string,ids?:string[],sanitizedOnly=false):Promise<FaultlineEvidence[]>{
 if(ids)demand(ids.every(id=>/^[a-f0-9-]{36}$/i.test(id)),'EVIDENCE_UNAVAILABLE','Citation unavailable.',404);
 const rows=(await tx.query("SELECT value,redaction_status FROM faultline.evidence WHERE workspace_id=$1 AND case_id=$2 AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])) ORDER BY created_at,id LIMIT 201",[wid,caseId,ids??null])).rows;
 demand(rows.length<=200,'EVIDENCE_LIMIT','Select a bounded evidence subset.');
 if(ids)demand(new Set(rows.map(r=>r.value.id)).size===new Set(ids).size,'EVIDENCE_UNAVAILABLE','Citation unavailable.',404);
 for(const row of rows)try{if(row.value.snapshot_id)await assertResourceRetainedTx(tx,wid,'snapshot',row.value.snapshot_id);for(const ref of row.value.artifact_refs??[])await assertResourceRetainedTx(tx,wid,'evidence_artifact',ref.artifact_id);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='RETENTION_EXPIRED'){if(ids)throw error;row.redaction_status='withdrawn';row.value={...row.value,text:'Evidence expired under the reviewed retention policy.',artifact_refs:[]};}else throw error;}
 for(const snapshotId of new Set(rows.filter(r=>r.redaction_status!=='withdrawn'&&(!sanitizedOnly||r.redaction_status==='sanitized')).map(r=>r.value.snapshot_id).filter(Boolean)))await snapshotTx(tx,wid,caseId,snapshotId);
 return rows.map(r=>({...r.value,redaction_status:r.redaction_status})).filter(r=>!sanitizedOnly||r.redaction_status==='sanitized');
}
export async function currentSanitizedEvidenceIdsTx(tx:Tx,wid:string,caseId:string,revisionId:string,selectedSnapshotIds:string[],limit=101):Promise<string[]>{
 demand(Number.isSafeInteger(limit)&&limit>0&&limit<=201,'EVIDENCE_LIMIT','Select a bounded evidence subset.');
 const rows=(await tx.query("SELECT e.id FROM faultline.evidence e WHERE e.workspace_id=$1 AND e.case_id=$2 AND e.redaction_status='sanitized' AND ((e.value->>'source_kind'='federated_query' AND e.value->>'revision_id'=$4::text AND NOT EXISTS(SELECT 1 FROM faultline.evidence newer WHERE newer.workspace_id=e.workspace_id AND newer.case_id=e.case_id AND newer.redaction_status='sanitized' AND newer.value->>'supersedes_id'=e.id::text) AND EXISTS(WITH RECURSIVE lineage(id,parent_id,depth) AS (SELECT e.id,e.value->>'supersedes_id',0 UNION ALL SELECT parent.id,parent.value->>'supersedes_id',lineage.depth+1 FROM lineage JOIN faultline.evidence parent ON parent.workspace_id=e.workspace_id AND parent.case_id=e.case_id AND parent.id::text=lineage.parent_id WHERE lineage.depth<20) SELECT 1 FROM lineage JOIN faultline.integration_captures c ON c.workspace_id=e.workspace_id AND c.case_id=e.case_id AND c.revision_id=$4::uuid AND c.status='complete' AND c.value->'evidence_ids' ? lineage.id::text)) OR (e.value->>'source_kind'<>'federated_query' AND (e.value->>'snapshot_id' IS NULL OR e.value->>'snapshot_id'=ANY($3::text[])))) ORDER BY e.created_at,e.id LIMIT $5",[wid,caseId,selectedSnapshotIds,revisionId,limit])).rows;
 return rows.map((row:{id:string})=>String(row.id));
}
export async function listEvidence(wid:string,pid:string,caseId:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId);const role=await access(tx,wid,pid);const values=await evidenceTx(tx,wid,caseId,undefined,role==='viewer');const revisions=(await tx.query('SELECT id,revision FROM faultline.evidence WHERE workspace_id=$1 AND case_id=$2',[wid,caseId])).rows;const annotations=(await tx.query('SELECT evidence_id,related_evidence_ids,kind,reason,actor_id,created_at FROM faultline.evidence_annotations WHERE workspace_id=$1 AND case_id=$2 ORDER BY created_at,id',[wid,caseId])).rows;const visibleIds=new Set(values.filter(v=>v.redaction_status==='sanitized').map(v=>v.id));return values.map(value=>({...value,resource_revision:revisions.find(r=>r.id===value.id)?.revision??1,annotations:annotations.filter(a=>a.evidence_id===value.id).map(a=>role==='viewer'?{kind:a.kind,related_evidence_ids:a.related_evidence_ids.filter((id:string)=>visibleIds.has(id))}:a)}));});}
export async function note(wid:string,pid:string,key:string,caseId:string,input:{text:string;related_evidence_ids:string[]}){
 return command(wid,pid,'evidence.note',key,{caseId,input},async tx=>{
  const investigation=await getCaseTx(tx,wid,pid,caseId,true);await evidenceTx(tx,wid,caseId,input.related_evidence_ids);
  const id=newId(),value=validateContract<FaultlineEvidence>('evidence',{schema_version:1,id,workspace_id:wid,case_id:caseId,revision_id:investigation.active_revision_id,snapshot_id:null,source_kind:'human_note',source_ref:'User note '+pid,content_hash:hash({text:input.text,related_evidence_ids:input.related_evidence_ids}),event_time:{kind:'unknown',raw_description:'Occurrence time not supplied'},captured_at:now(),text:input.text,redaction_status:'restricted',evidence_status:'user_attested',supersedes_id:null,artifact_refs:[]});
  await tx.query('INSERT INTO faultline.evidence(id,workspace_id,case_id,value,redaction_status) VALUES($1,$2,$3,$4,$5)',[id,wid,caseId,value,'restricted']);await tx.query('INSERT INTO faultline.evidence_annotations(id,workspace_id,case_id,evidence_id,related_evidence_ids,kind,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId(),wid,caseId,id,input.related_evidence_ids,'note_links','User-authored note with explicit related records.',pid]);await audit(tx,wid,pid,'evidence.note',{case_id:caseId,evidence_id:id});return {...value,revision:1};
 });
}
export async function redact(wid:string,pid:string,key:string,caseId:string,id:string,text:string,match:string){
 return command(wid,pid,'evidence.redact',key,{caseId,id,text,match},async tx=>{
  await getCaseTx(tx,wid,pid,caseId,true);await access(tx,wid,pid,['owner']);const old=(await tx.query('SELECT * FROM faultline.evidence WHERE workspace_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE',[wid,caseId,id])).rows[0];demand(old&&old.redaction_status!=='withdrawn','NOT_FOUND','Evidence unavailable.',404);expected(match,old.revision);
  const replacementId=newId(),value=validateContract<FaultlineEvidence>('evidence',{...old.value,id:replacementId,content_hash:hash({text,original_hash:old.value.content_hash}),text,captured_at:now(),redaction_status:'sanitized',supersedes_id:id,artifact_refs:[]});
  await tx.query('INSERT INTO faultline.evidence(id,workspace_id,case_id,value,redaction_status) VALUES($1,$2,$3,$4,$5)',[replacementId,wid,caseId,value,'sanitized']);
  await audit(tx,wid,pid,'evidence.redact',{case_id:caseId,evidence_id:id,replacement_id:replacementId});return {...value,revision:1};
 },['owner']);
}
export async function withdraw(wid:string,pid:string,key:string,caseId:string,id:string,reason:string,match:string){
 return command(wid,pid,'evidence.withdraw',key,{caseId,id,reason,match},async tx=>{
  await getCaseTx(tx,wid,pid,caseId,true);const old=(await tx.query('SELECT revision FROM faultline.evidence WHERE workspace_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE',[wid,caseId,id])).rows[0];demand(old,'NOT_FOUND','Evidence unavailable.',404);expected(match,old.revision);
  await tx.query("UPDATE faultline.evidence SET redaction_status='withdrawn',revision=revision+1 WHERE workspace_id=$1 AND id=$2",[wid,id]);
  await audit(tx,wid,pid,'evidence.withdraw',{case_id:caseId,evidence_id:id,reason});return {id,redaction_status:'withdrawn',revision:old.revision+1};
 });
}
export async function hypotheses(wid:string,pid:string,caseId:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId);const role=await access(tx,wid,pid),rows=(await tx.query('SELECT value,revision FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 ORDER BY created_at,id',[wid,caseId])).rows,visible=[];for(const row of rows){if(role==='viewer'){const ids=[...row.value.supporting_evidence_ids,...row.value.contradicting_evidence_ids],e=await evidenceTx(tx,wid,caseId,ids);if(e.some(x=>x.redaction_status!=='sanitized'))continue;}visible.push({...row.value,resource_revision:row.revision});}return visible;});}
export async function createHypothesis(wid:string,pid:string,key:string,caseId:string,input:ManualHypothesisFields,match?:string){
 return command(wid,pid,'hypothesis.create',key,{caseId,input,...(match!==undefined?{match}:{})},async tx=>{
  const bound=await bindingTx(tx,wid,pid,caseId,true);if(match!==undefined)expected(match,bound.investigation.revision);const {binding}=bound,references=await evidenceTx(tx,wid,caseId,[...(input.supporting_evidence_ids??[]),...(input.contradicting_evidence_ids??[])]),id=newId(),value=createManualHypothesis(id,binding,input,references);
  await tx.query('INSERT INTO faultline.hypotheses(id,workspace_id,case_id,value) VALUES($1,$2,$3,$4)',[id,wid,caseId,value]);await audit(tx,wid,pid,'hypothesis.create',{case_id:caseId,hypothesis_id:id});return {...value,resource_revision:1};
 });
}
export async function editHypothesis(wid:string,pid:string,key:string,caseId:string,id:string,input:Record<string,unknown>,match:string){
 return command(wid,pid,'hypothesis.edit',key,{caseId,id,input,match},async tx=>{
  const {binding}=await bindingTx(tx,wid,pid,caseId,true),old=(await tx.query('SELECT * FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE',[wid,caseId,id])).rows[0];demand(old,'NOT_FOUND','Hypothesis unavailable.',404);expected(match,old.revision);
  const {status_reason,...fields}=input;demand(!fields.status||fields.status==='needs_evidence'||typeof status_reason==='string','STATUS_REASON','Accepting/rejecting a hypothesis requires a reason.');
  const candidate={...old.value,...fields},references=[...new Set<string>([...candidate.supporting_evidence_ids,...candidate.contradicting_evidence_ids])];const value=reviseHypothesis(old.value,fields,binding,await evidenceTx(tx,wid,caseId,references));
  await tx.query('UPDATE faultline.hypotheses SET value=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[wid,id,value]);await audit(tx,wid,pid,'hypothesis.edit',{case_id:caseId,hypothesis_id:id,status_reason});return {...value,resource_revision:old.revision+1};
 });
}
export async function getAnalyticPlan(wid:string,pid:string,caseId:string,id:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId);const row=(await tx.query('SELECT id,value,plan_hash FROM faultline.analytic_plans WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,id])).rows[0];demand(row,'NOT_FOUND','Plan unavailable.',404);if(await access(tx,wid,pid)==='viewer'){const hypothesis=(await tx.query('SELECT value FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,row.value.hypothesis_id])).rows[0];demand(hypothesis,'NOT_FOUND','Plan unavailable.',404);const references=await evidenceTx(tx,wid,caseId,analyticEvidenceIds(row.value,hypothesis.value));demand(references.every(e=>e.redaction_status==='sanitized'),'NOT_FOUND','Plan unavailable.',404);}return row;});}
export async function createAnalytic(wid:string,pid:string,key:string,caseId:string,proposed:FaultlineAnalyticPlan){
 validateContract('analytic-plan',proposed);
 return command(wid,pid,'analytic.create',key,{caseId,proposed},async tx=>{
  const {binding}=await bindingTx(tx,wid,pid,caseId,true);for(const k of Object.keys(binding) as (keyof InvestigationBinding)[])demand(proposed[k]===binding[k],'STALE_INPUTS','Analytic inputs are not the current frozen binding.',409);
  const hypothesis=(await tx.query('SELECT value FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,proposed.hypothesis_id])).rows[0];demand(hypothesis&&hypothesis.value.revision_id===binding.revision_id,'STALE_HYPOTHESIS_REVISION','Review a current hypothesis.',409);await evidenceTx(tx,wid,caseId,proposed.evidence_ids);
  const id=newId(),value={...proposed,id},plan_hash=hash(value);await tx.query('INSERT INTO faultline.analytic_plans(id,workspace_id,case_id,revision_id,value,plan_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,wid,caseId,binding.revision_id,value,plan_hash]);return {id,value,plan_hash};
 });
}
export async function queueAnalytic(wid:string,pid:string,key:string,caseId:string,id:string,planHash:string){
 return command(wid,pid,'analytic.run',key,{caseId,id,planHash},async tx=>{
  const bound=await bindingTx(tx,wid,pid,caseId,true),plan=(await tx.query('SELECT * FROM faultline.analytic_plans WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,id])).rows[0];demand(plan?.plan_hash===planHash&&plan.revision_id===bound.binding.revision_id&&bound.comparison,'STALE_INPUTS','Run requires current plan and a completed comparison.',409);
  const h=(await tx.query('SELECT value FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,plan.value.hypothesis_id])).rows[0];demand(h?.value.revision_id===bound.binding.revision_id&&h.value.proposed_test_kinds.includes(plan.value.kind),'STALE_HYPOTHESIS_REVISION','Review a current hypothesis proposing this analytic kind.',409);const cited=await evidenceTx(tx,wid,caseId,analyticEvidenceIds(plan.value,h.value));demand(cited.every(e=>e.redaction_status!=='withdrawn'),'EVIDENCE_UNAVAILABLE','Analytic citations are unavailable or withdrawn.',409);return enqueue(tx,wid,caseId,plan.revision_id,'analytic_compute',{actor_id:pid,plan_id:id,plan_hash:planHash,hypothesis_hash:hash(h.value),comparison_id:bound.comparison.id});
 });
}
export async function analyticHandler(job:{id:string;workspace_id:string;case_id:string;revision_id:string;fence:string;input:any}){
 const {workspace_id:wid,case_id:caseId,input}=job;
 return transaction(wid,async tx=>{
  const bound=await bindingTx(tx,wid,input.actor_id,caseId,true);demand(bound.binding.revision_id===job.revision_id,'STALE_INPUTS','Case revision changed.',409);
  const plan=(await tx.query('SELECT * FROM faultline.analytic_plans WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,input.plan_id])).rows[0],hypothesis=(await tx.query('SELECT value FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,plan.value.hypothesis_id])).rows[0];
  demand(plan.plan_hash===input.plan_hash&&hash(hypothesis.value)===input.hypothesis_hash,'STALE_INPUTS','Plan/hypothesis changed.',409);
  const comparison=(await tx.query('SELECT value FROM faultline.comparisons WHERE workspace_id=$1 AND case_id=$2 AND id=$3 AND revision_id=$4',[wid,caseId,input.comparison_id,job.revision_id])).rows[0];demand(comparison,'STALE_INPUTS','Comparison unavailable.',409);
  const value=evaluateAnalyticPlan({hypothesis:hypothesis.value,plan:plan.value,metric_result:comparison.value,events:await eventRows(tx,wid,caseId,bound.snapshot.id),evidence:await evidenceTx(tx,wid,caseId,analyticEvidenceIds(plan.value,hypothesis.value)),binding:bound.binding,metric_definition:bound.metric.value});
  demand((await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND id=$2 AND fence=$3 AND status='running' AND lease_until>now() FOR UPDATE",[wid,job.id,job.fence])).rowCount,'FENCED_ATTEMPT','Attempt may not publish.',409);
  const complete=async(result:{analytic_result_id:string})=>{demand(await finishJobTx(tx,wid,job.id,job.fence,'succeeded',result) ==='succeeded','FENCED_ATTEMPT','Analytic publication could not settle its active attempt.',409);return result;};
  const old=(await tx.query('SELECT id FROM faultline.analytic_results WHERE job_id=$1',[job.id])).rows[0];if(old)return complete({analytic_result_id:old.id});
  const id=newId();await tx.query('INSERT INTO faultline.analytic_results(id,workspace_id,case_id,revision_id,plan_id,value,job_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,wid,caseId,job.revision_id,plan.id,value,job.id]);return complete({analytic_result_id:id});
 });
}
export async function analyticFreshTx(tx:Tx,wid:string,caseId:string,row:any,currentRevision?:string){
 if(!(await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND id=$3 AND status='succeeded'",[wid,caseId,row.job_id])).rowCount)return false;
 const value=row.value,plan=(await tx.query('SELECT plan_hash FROM faultline.analytic_plans WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,row.plan_id])).rows[0],hypothesis=(await tx.query('SELECT value FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,value.hypothesis_id])).rows[0];
 if((currentRevision&&row.revision_id!==currentRevision)||!plan||plan.plan_hash!==value.plan_hash||!hypothesis||hash(hypothesis.value)!==value.hypothesis_hash)return false;
 const source=(await tx.query("SELECT s.id,s.withdrawn,s.content_hash FROM faultline.snapshots s JOIN faultline.case_revisions r ON r.workspace_id=s.workspace_id AND r.case_id=s.case_id AND r.value->>'snapshot_id'=s.id::text WHERE r.workspace_id=$1 AND r.case_id=$2 AND r.id=$3",[wid,caseId,row.revision_id])).rows[0];if(!source||source.withdrawn||source.content_hash!==value.snapshot_hash)return false;
 await snapshotTx(tx,wid,caseId,source.id);
 const ids=Object.keys(value.evidence_hashes),evidence=await evidenceTx(tx,wid,caseId,ids);
 return evidence.every(e=>e.redaction_status!=='withdrawn'&&hash(e)===value.evidence_hashes[e.id]);
}
export async function analyticResult(wid:string,pid:string,caseId:string,id:string){return transaction(wid,async tx=>{const investigation=await getCaseTx(tx,wid,pid,caseId),row=(await tx.query('SELECT * FROM faultline.analytic_results WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,id])).rows[0];demand(row,'NOT_FOUND','Result unavailable.',404);if(await access(tx,wid,pid)==='viewer'){const referenced=await evidenceTx(tx,wid,caseId,Object.keys(row.value.evidence_hashes));demand(referenced.every(e=>e.redaction_status==='sanitized'),'NOT_FOUND','Result unavailable.',404);}return {...row,value:{...row.value,freshness:await analyticFreshTx(tx,wid,caseId,row,investigation.active_revision_id)?'fresh':'stale'}};});}
