import type {Tx} from '../../../database/src/client.js';
import {analyticFreshTx,evidenceTx} from '../investigation/service.js';
import {verificationFreshTx} from '../experiments/service.js';
import {getCurrentFollowupTx} from '../collaboration/service.js';
import {hash} from '../canonical.js';

type Row=Record<string,any>;
export interface InvestigationNarrativeContext {
 revision_id:string;source_text_trust:'untrusted_data';causal_effect:'not_established';
 hypotheses:Row[];analytic_results:Row[];controlled_verification:Row[];followup:Row|null;omitted:boolean;
}
export const NARRATIVE_CONTEXT_MAX_BYTES=10000;
const ids=(value:unknown):string[]=>Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'):[];
const allAllowed=(references:string[],allowed:Set<string>)=>references.every(id=>allowed.has(id));
const prose=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):'';

/** Only explicit fields enter the prompt. Prose remains quoted untrusted data, never instructions. */
export function projectInvestigationNarrativeContext(revisionId:string,allowedEvidenceIds:string[],input:{hypotheses?:Row[];analytic?:Row[];verification?:Row[];followup?:Row|null;pending?:Row|null}):InvestigationNarrativeContext {
 const context:InvestigationNarrativeContext={revision_id:revisionId,source_text_trust:'untrusted_data',causal_effect:'not_established',hypotheses:[],analytic_results:[],controlled_verification:[],followup:null,omitted:false},allowed=new Set(allowedEvidenceIds);
 const fits=()=>Buffer.byteLength(JSON.stringify(context))<=NARRATIVE_CONTEXT_MAX_BYTES;
 const append=(target:Row[],item:Row)=>{target.push(item);if(!fits()){target.pop();context.omitted=true;}};
 for(const row of (input.hypotheses??[]).slice(0,20)){
  const h=row.value??{},supporting=ids(h.supporting_evidence_ids),contradicting=ids(h.contradicting_evidence_ids);
  if(h.revision_id!==revisionId||!allAllowed([...supporting,...contradicting],allowed))continue;
  append(context.hypotheses,{id:h.id,title:prose(h.title,160),statement:prose(h.statement,700),falsifier:prose(h.falsifier,500),status:h.status,supporting_evidence_ids:supporting.slice(0,50),contradicting_evidence_ids:contradicting.slice(0,50)});
 }
 for(const row of (input.analytic??[]).slice(0,20)){
  const v=row.value??{},references=Object.keys(v.evidence_hashes??{});
  if(!row.context_fresh||row.revision_id!==revisionId||!allAllowed(references,allowed))continue;
  append(context.analytic_results,{id:row.id,hypothesis_id:v.hypothesis_id,kind:v.kind,outcome:v.outcome,freshness:'fresh',result_hash:v.result_hash,plan_hash:v.plan_hash,metric_hash:v.metric_hash,snapshot_hash:v.snapshot_hash,evidence_ids:references,causal_effect:'not_established'});
 }
 for(const row of (input.verification??[]).slice(0,20)){
  const v=row.value??{},references=Object.keys(row.evidence_hashes??{});
  if(!row.context_fresh||row.revision_id!==revisionId||v.mode!=='trusted_fixture'||!allAllowed(references,allowed)||!allowed.has(row.summary_evidence_id))continue;
  append(context.controlled_verification,{id:row.id,hypothesis_id:v.hypothesis_id,outcome:v.outcome,mechanism:v.mechanism,correction:v.correction,freshness:'fresh',mode:v.mode,production_claim_eligible:false,result_hash:row.result_hash,plan_hash:v.plan_hash,evidence_ids:[...references,row.summary_evidence_id],causal_effect:'not_established'});
 }
 const f=input.followup;
 if(f?.context_fresh&&f.revision_id===revisionId&&f.state==='compared'&&f.summary_evidence?.redaction_status==='sanitized'&&allowed.has(f.summary_evidence.id)&&(!f.value?.rollout_evidence_id||allowed.has(f.value.rollout_evidence_id))&&f.result?.mode==='observational'&&f.result?.causal_effect==='not_established'){
  const r=f.result,v=r.value??{};
  context.followup={id:f.id,state:'compared',freshness:'fresh',mode:'observational',causal_effect:'not_established',evidence_ids:[f.summary_evidence.id],result_hash:hash(r),quality:v.quality,basis:v.basis,baseline:v.baseline?{eligible:v.baseline.eligible,converted:v.baseline.converted,rate:v.baseline.rate}:null,comparison:v.comparison?{eligible:v.comparison.eligible,converted:v.comparison.converted,rate:v.comparison.rate}:null,delta_pp:v.delta_pp??null};
 }else if(input.pending?.context_fresh&&input.pending.revision_id===revisionId&&['scheduled','waiting_for_data','blocked'].includes(input.pending.state)){
  context.followup={id:input.pending.id,state:input.pending.state,freshness:'fresh',mode:'observational',causal_effect:'not_established',outcome:'not_run'};
 }
 if(!fits()){context.followup=null;context.omitted=true;}
 return context;
}

/** Caller supplies the exact evidence allowlist used by its immutable prompt binding. */
export async function investigationNarrativeContextTx(tx:Tx,wid:string,cid:string,revisionId:string,allowedEvidenceIds:string[]):Promise<InvestigationNarrativeContext>{
 const current=(await tx.query('SELECT active_revision_id,deletion_requested_at FROM faultline.cases WHERE workspace_id=$1 AND id=$2',[wid,cid])).rows[0];
 if(!current||current.deletion_requested_at||current.active_revision_id!==revisionId)return projectInvestigationNarrativeContext(revisionId,[],{});
 const evidence=await evidenceTx(tx,wid,cid,[...new Set(allowedEvidenceIds)].slice(0,100),true),allowed=evidence.map(e=>e.id);
 const hypotheses=(await tx.query("SELECT value FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND value->>'revision_id'=$3 ORDER BY created_at DESC,id DESC LIMIT 20",[wid,cid,revisionId])).rows;
 const analytic=(await tx.query('SELECT * FROM faultline.analytic_results WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3 ORDER BY created_at DESC,id DESC LIMIT 20',[wid,cid,revisionId])).rows;
 const verification=(await tx.query("SELECT r.*,p.evidence_hashes FROM faultline.verification_results r JOIN faultline.browser_plans p ON p.workspace_id=r.workspace_id AND p.case_id=r.case_id AND p.id=r.plan_id WHERE r.workspace_id=$1 AND r.case_id=$2 AND r.revision_id=$3 AND r.value->>'mode'='trusted_fixture' ORDER BY r.created_at DESC,r.id DESC LIMIT 20",[wid,cid,revisionId])).rows;
 for(const row of analytic)try{row.context_fresh=await analyticFreshTx(tx,wid,cid,row,revisionId);}catch{row.context_fresh=false;}
 for(const row of verification)try{row.context_fresh=await verificationFreshTx(tx,wid,cid,row,revisionId);const summary=(await tx.query("SELECT value FROM faultline.evidence WHERE workspace_id=$1 AND case_id=$2 AND value->>'source_ref'=$3 AND redaction_status='sanitized' ORDER BY created_at DESC,id DESC LIMIT 1",[wid,cid,'verification:'+row.id])).rows[0];if(summary?.value?.revision_id===revisionId)row.summary_evidence_id=summary.value.id;}catch{row.context_fresh=false;}
 const followup=await getCurrentFollowupTx(tx,wid,cid,revisionId);
 const pending=(await tx.query("SELECT f.id,f.state,f.revision_id FROM faultline.followups f JOIN faultline.snapshots s ON s.workspace_id=f.workspace_id AND s.case_id=f.case_id AND s.id::text=f.value->>'original_snapshot_id' JOIN faultline.metric_versions m ON m.workspace_id=f.workspace_id AND m.case_id=f.case_id AND m.id::text=f.value->>'metric_id' WHERE f.workspace_id=$1 AND f.case_id=$2 AND f.revision_id=$3 AND f.state IN ('scheduled','waiting_for_data','blocked') AND NOT s.withdrawn AND s.content_hash=f.value->>'original_snapshot_hash' AND m.state='frozen' AND m.metric_hash=f.value->>'metric_hash' ORDER BY f.created_at DESC,f.id DESC LIMIT 1",[wid,cid,revisionId])).rows[0];
 return projectInvestigationNarrativeContext(revisionId,allowed,{hypotheses,analytic,verification,followup:followup?{...followup,context_fresh:true}:null,pending:pending?{...pending,context_fresh:true}:null});
}
