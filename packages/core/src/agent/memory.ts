import type {Tx} from '../../../database/src/client.js';
import {transaction} from '../../../database/src/client.js';
import {newId,hash,now,canonical} from '../canonical.js';
import {getCaseTx} from '../cases/service.js';
import {demand,DomainError} from '../errors.js';
import {evidenceTx} from '../investigation/service.js';
import {reportMemoryAuthorityTx} from '../reports/service.js';
import {access,audit,command} from '../workspaces/service.js';
import {
  MeterlessInvestigationMemory,
  investigationCapsuleHash,
  type InvestigationCapsule,
  type InvestigationCapsuleContent,
  type MemoryFeedbackKind,
} from '../connectors/meterless/index.js';
export type {MemoryFeedbackKind} from '../connectors/meterless/index.js';

type Row=Record<string,any>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface SaveReportMemoryInput {
  report_id:string;
  reviewed:true;
  cohort_keys?:string[];
  release_refs?:string[];
  falsifiers?:string[];
  control_observations?:string[];
  test_prerequisites?:string[];
  follow_up_outcome?:string|null;
}

export interface MemoryPromptContext {
  retrieval_id:string|null;
  status:'complete'|'empty'|'unavailable';
  catalog_hash:string;
  capsules:Array<Record<string,unknown>>;
  capsule_hashes:Record<string,string>;
  unknowns:string[];
  trace:unknown[];
}

export interface AgentMemoryRecallPlan {
 schema_version:1;
 kind:'meterless_recall';
 revision_id:string;
 query:string;
 query_hash:string;
 catalog_hash:string;
 max_results:5;
}

function boundedList(value:unknown,maxItems:number,maxLength:number,name:string):string[]{
 demand(value===undefined||Array.isArray(value), 'INVALID_MEMORY_INPUT', `${name} must be a list.`,400);
 const result=(value??[]) as unknown[];demand(result.length<=maxItems,'INVALID_MEMORY_INPUT',`${name} is too long.`,400);
 return result.map(item=>{demand(typeof item==='string'&&item.trim().length>0&&item.length<=maxLength,'INVALID_MEMORY_INPUT',`${name} contains invalid text.`,400);return (item as string).trim();});
}
function mergeBounded(primary:string[],derived:string[],maxItems=20):string[]{return [...new Set([...primary,...derived].map(value=>value.trim()).filter(Boolean))].slice(0,maxItems);}

export function assertCurrentReportMemoryAuthority(authority:Row|null|undefined,report:Row):asserts authority is Row{
 demand(Boolean(authority?.fresh),'STALE_REPORT','Review a fresh report with current evidence and test bindings before saving it.',409);
 demand(authority!.report_hash===hash(report.value)&&authority!.binding_hash===hash(report.binding),'STALE_REPORT','Review a fresh report with current evidence and test bindings before saving it.',409);
}

function claimAxes(claim:Row):InvestigationCapsuleContent['claim_axes']{
 return {
  association:claim.association==='observed'?'observed':'unknown',
  mechanism:['reproduced','not_reproduced','inconclusive'].includes(claim.mechanism)?claim.mechanism:'untested',
  correction:claim.correction==='validated'?'validated':claim.correction==='failed'?'not_validated':claim.correction==='inconclusive'?'inconclusive':'not_tested',
  causal_effect:'not_established',
 };
}

function publicCapsule(capsule:InvestigationCapsule){
 return {
  capsule_id:capsule.capsule_id,source_case_id:capsule.source_case_id,published_report_id:capsule.published_report_id,
  accepted_findings:capsule.accepted_findings,rejected_or_unresolved_alternatives:capsule.rejected_or_unresolved_alternatives,
  falsifiers:capsule.falsifiers,control_observations:capsule.control_observations,test_prerequisites:capsule.test_prerequisites,
  affected_flow:capsule.affected_flow,cohort_keys:capsule.cohort_keys,release_refs:capsule.release_refs,claim_axes:capsule.claim_axes,
  limitations:capsule.limitations,follow_up_outcome:capsule.follow_up_outcome,accepted_at:capsule.accepted_at,capsule_hash:capsule.capsule_hash,
 };
}

export function investigationMemoryCatalogHash(capsules:InvestigationCapsule[],authority:unknown[],feedback:unknown[]):string{
 const ordered=(values:unknown[])=>[...values].sort((left,right)=>canonical(left).localeCompare(canonical(right)));
 return hash({capsules:ordered(capsules.map(capsule=>({id:capsule.capsule_id,capsule_hash:capsule.capsule_hash,authority:capsule.authority}))),authority:ordered(authority),feedback:ordered(feedback)});
}

async function currentCapsulesTx(tx:Tx,wid:string,pid:string):Promise<{capsules:InvestigationCapsule[];catalog_hash:string;feedback:Row[]}>{
 const rows=(await tx.query("SELECT * FROM faultline.memory_capsules WHERE workspace_id=$1 AND status='active' ORDER BY accepted_at,id LIMIT 1001",[wid])).rows;
 demand(rows.length<=1000,'METERLESS_CATALOG_SCAN_LIMIT','Withdraw stale investigation memory before using recall.',409);
 const capsules:InvestigationCapsule[]=[],authorityDigests:unknown[]=[];
 for(const row of rows){
  const source=(await tx.query('SELECT active_revision_id FROM faultline.cases WHERE workspace_id=$1 AND id=$2',[wid,row.case_id])).rows[0];
  const revision=source?(await tx.query('SELECT value FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,row.case_id,source.active_revision_id])).rows[0]:null;
  const report=(await tx.query('SELECT value FROM faultline.report_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,row.case_id,row.report_id])).rows[0],reportAuthority=report?await reportMemoryAuthorityTx(tx,wid,pid,row.case_id,row.report_id):null;
  const value=row.value as InvestigationCapsuleContent,currentReportHash=reportAuthority?.report_hash??'0'.repeat(64),evidenceIds=[...new Set(value.accepted_findings.flatMap(finding=>finding.evidence_ids))],evidence=evidenceIds.length?(await tx.query('SELECT id,content_hash,redaction_status FROM faultline.evidence WHERE workspace_id=$1 AND case_id=$2 AND id=ANY($3::uuid[]) ORDER BY id',[wid,row.case_id,evidenceIds])).rows:[],evidenceCurrent=evidence.length===evidenceIds.length&&evidence.every((item:Row)=>item.redaction_status==='sanitized')&&hash([...evidence.map((item:Row)=>item.content_hash)].sort())===hash([...value.evidence_hashes].sort()),withdrawn=row.status!=='active'||!evidenceCurrent||!reportAuthority?.fresh;
  const capsule={...value,capsule_hash:row.capsule_hash,authority:{workspace_id:wid,current_revision_id:String(source?.active_revision_id??'missing'),current_metric_hash:String(revision?.value?.metric_hash??'0'.repeat(64)),current_snapshot_hash:String(revision?.value?.snapshot_hash??'0'.repeat(64)),current_report_hash:currentReportHash,capsule_hash:row.capsule_hash,withdrawn,deleted:!source||!revision||!report}};
  if(!withdrawn)capsules.push(capsule);authorityDigests.push({capsule_id:row.id,current:!withdrawn,evidence:evidence.map((item:Row)=>({id:item.id,content_hash:item.content_hash,redaction_status:item.redaction_status})),report_binding_hash:reportAuthority?.binding_hash??null,report_fresh:reportAuthority?.fresh??false});
 }
 demand(capsules.length<=200,'METERLESS_CATALOG_LIMIT','Withdraw or consolidate current prior investigations before using memory.',409);
 const capsuleIds=capsules.map(capsule=>capsule.capsule_id),feedback=capsuleIds.length?(await tx.query("SELECT DISTINCT ON(capsule_id) capsule_id,id,kind,created_at FROM faultline.memory_feedback WHERE workspace_id=$1 AND capsule_id=ANY($2::uuid[]) ORDER BY capsule_id,created_at DESC,id DESC",[wid,capsuleIds])).rows:[];
 return {capsules,feedback,catalog_hash:investigationMemoryCatalogHash(capsules,authorityDigests,feedback.map((row:Row)=>({capsule_id:row.capsule_id,id:row.id,kind:row.kind,created_at:new Date(row.created_at).toISOString()})))};
}

export async function planAgentMemoryRecallTx(tx:Tx,wid:string,pid:string,cid:string,revisionId:string,queryText:string):Promise<AgentMemoryRecallPlan>{
 const query=String(queryText).slice(0,4000),catalog=await currentCapsulesTx(tx,wid,pid);
 return {schema_version:1,kind:'meterless_recall',revision_id:revisionId,query,query_hash:hash({workspace_id:wid,case_id:cid,revision_id:revisionId,text:query}),catalog_hash:catalog.catalog_hash,max_results:5};
}
export function assertAgentMemoryRecallPlanCurrent(approved:AgentMemoryRecallPlan,current:AgentMemoryRecallPlan):void{
 demand(hash(approved)===hash(current),'STALE_AGENT_MEMORY','The approved prior-investigation query or memory catalog changed. Ask the agent for a new action before running it.',409);
}

function retrievalValue(result:ReturnType<MeterlessInvestigationMemory['query']>){
 return {adapter_version:result.adapter_version,catalog_generation:result.catalog_generation,capsules:result.capsules.map(item=>({capsule:publicCapsule(item.capsule),relevance:item.relevance})),rejected:result.rejected,trace:result.trace,metrics:result.metrics};
}

export async function retrieveAgentMemoryTx(tx:Tx,wid:string,pid:string,cid:string,revisionId:string,queryText:string,approvedPlan?:AgentMemoryRecallPlan):Promise<MemoryPromptContext>{
 const catalog=await currentCapsulesTx(tx,wid,pid),engine=new MeterlessInvestigationMemory({workspace_id:wid,catalog_generation:catalog.catalog_hash});
 const query=String(queryText).slice(0,4000),queryHash=hash({workspace_id:wid,case_id:cid,revision_id:revisionId,text:query});
 if(approvedPlan)assertAgentMemoryRecallPlanCurrent(approvedPlan,{schema_version:1,kind:'meterless_recall',revision_id:revisionId,query,query_hash:queryHash,catalog_hash:catalog.catalog_hash,max_results:5});
 let status:MemoryPromptContext['status']='empty',value:Row,unknowns:string[]=[];
 try{
  engine.rebuild(catalog.capsules);
  for(const row of catalog.feedback){try{engine.feedback(row.capsule_id,row.kind as MemoryFeedbackKind);}catch(error){if(!(error instanceof DomainError))throw error;}}
  const result=engine.query({workspace_id:wid,catalog_generation:catalog.catalog_hash,text:query,max_results:5,current_capsules:catalog.capsules});
  status=result.capsules.length?'complete':'empty';value=retrievalValue(result);
  if(!result.capsules.length)unknowns.push('No current prior investigation matched this case.');
 }catch(error){status='unavailable';unknowns=['Prior investigation retrieval is unavailable for this turn.'];value={adapter_version:'faultline-meterless-v1',catalog_generation:catalog.catalog_hash,capsules:[],rejected:[],trace:[],metrics:null,error_code:error instanceof DomainError?error.code:'METERLESS_UNAVAILABLE'};}
 const id=newId(),resultHash=hash(value);
 await tx.query('INSERT INTO faultline.memory_retrievals(id,workspace_id,case_id,revision_id,query_hash,catalog_hash,result_hash,status,value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,wid,cid,revisionId,queryHash,catalog.catalog_hash,resultHash,status,value]);
 const capsule_hashes=Object.fromEntries((value.capsules??[]).map((item:Row)=>[item.capsule.capsule_id,item.capsule.capsule_hash]));
 return {retrieval_id:id,status,catalog_hash:catalog.catalog_hash,capsules:value.capsules??[],capsule_hashes,unknowns,trace:value.trace??[]};
}

export async function loadAgentMemoryTx(tx:Tx,wid:string,pid:string,cid:string,revisionId:string,retrievalId:string):Promise<MemoryPromptContext>{
 const row=(await tx.query('SELECT * FROM faultline.memory_retrievals WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3 AND id=$4',[wid,cid,revisionId,retrievalId])).rows[0];
 demand(row&&row.result_hash===hash(row.value),'STALE_AGENT_MEMORY','Prior investigation retrieval changed.',409);
 const current=await currentCapsulesTx(tx,wid,pid),catalogCurrent=current.catalog_hash===row.catalog_hash;
 const capsules=catalogCurrent?(row.value.capsules??[]):[],unknowns=catalogCurrent?(row.status==='empty'?['No current prior investigation matched this case.']:row.status==='unavailable'?['Prior investigation retrieval is unavailable for this turn.']:[]):['Prior investigation memory changed after this turn was queued.'];
 return {retrieval_id:row.id,status:catalogCurrent?row.status:'unavailable',catalog_hash:current.catalog_hash,capsules,capsule_hashes:Object.fromEntries(capsules.map((item:Row)=>[item.capsule.capsule_id,item.capsule.capsule_hash])),unknowns,trace:row.value.trace??[]};
}

export async function saveReportMemory(wid:string,pid:string,key:string,cid:string,input:SaveReportMemoryInput){
 demand(uuid.test(input.report_id)&&input.reviewed===true,'INVALID_MEMORY_INPUT','Review a published report before saving it for future investigations.',400);
 const cohortKeys=boundedList(input.cohort_keys,20,200,'cohort_keys'),releaseRefs=boundedList(input.release_refs,20,300,'release_refs'),requestedFalsifiers=boundedList(input.falsifiers,20,2000,'falsifiers'),requestedControls=boundedList(input.control_observations,20,2000,'control_observations'),requestedPrerequisites=boundedList(input.test_prerequisites,20,2000,'test_prerequisites');
 const followUp=input.follow_up_outcome===undefined||input.follow_up_outcome===null?null:String(input.follow_up_outcome).trim();demand(followUp===null||(followUp.length>0&&followUp.length<=2000),'INVALID_MEMORY_INPUT','follow_up_outcome is invalid.',400);
 return command(wid,pid,'memory.capsule.accept',key,{caseId:cid,input},async tx=>{
  const role=await access(tx,wid,pid,['owner','analyst']);demand(role==='owner'||role==='analyst','FORBIDDEN','This role cannot save investigation memory.',403);
  const investigation=await getCaseTx(tx,wid,pid,cid,true),revision=(await tx.query('SELECT * FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,investigation.active_revision_id])).rows[0],report=(await tx.query('SELECT * FROM faultline.report_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,input.report_id])).rows[0];
  demand(revision&&report&&report.value.status==='published'&&report.value.revision_id===revision.id,'STALE_REPORT','Save only a current published report.',409);
  const authority=await reportMemoryAuthorityTx(tx,wid,pid,cid,input.report_id);assertCurrentReportMemoryAuthority(authority,report);
  demand(report.value.metric_hash===revision.value.metric_hash&&report.value.snapshot_hash===revision.value.snapshot_hash,'STALE_REPORT','The report no longer matches the current metric and snapshot.',409);
  const evidenceIds:string[]=[...new Set<string>((report.value.findings??[]).flatMap((finding:Row)=>(finding.evidence_ids??[]) as string[]))],evidence=await evidenceTx(tx,wid,cid,evidenceIds);
  demand(evidence.length===evidenceIds.length&&evidence.every((item:Row)=>item.redaction_status==='sanitized'),'CITATION_RESTRICTED','All saved memory citations must remain reviewed and available.',409);
  const hypotheses=(await tx.query("SELECT value FROM faultline.hypotheses WHERE workspace_id=$1 AND case_id=$2 AND value->>'revision_id'=$3 AND value->>'status'<>'rejected' ORDER BY created_at,id LIMIT 20",[wid,cid,revision.id])).rows.map((row:Row)=>row.value),falsifiers=mergeBounded(requestedFalsifiers,hypotheses.map((item:Row)=>String(item.falsifier??'')).filter(Boolean)),controls=mergeBounded(requestedControls,hypotheses.filter((item:Row)=>Array.isArray(item.contradicting_evidence_ids)&&item.contradicting_evidence_ids.length).map((item:Row)=>`Review contrary evidence for ${String(item.title).slice(0,200)}: ${item.contradicting_evidence_ids.join(', ')}`.slice(0,2000))),prerequisites=mergeBounded(requestedPrerequisites,[...new Set<string>(hypotheses.flatMap((item:Row)=>Array.isArray(item.proposed_test_kinds)?item.proposed_test_kinds:[]))].map(kind=>`Run and review the ${kind.replaceAll('_',' ')} test before reusing this explanation.`));
  const existing=(await tx.query('SELECT id,capsule_hash,status FROM faultline.memory_capsules WHERE workspace_id=$1 AND report_id=$2',[wid,input.report_id])).rows[0];
  if(existing){demand(existing.status==='active','MEMORY_WITHDRAWN','This report memory was withdrawn.',409);return existing;}
  const id=newId(),content:InvestigationCapsuleContent={schema_version:1,status:'accepted',capsule_id:id,workspace_id:wid,source_case_id:cid,published_report_id:input.report_id,revision_id:revision.id,report_hash:authority.report_hash,metric_hash:report.value.metric_hash,snapshot_hash:report.value.snapshot_hash,evidence_hashes:evidence.map((item:Row)=>item.content_hash),affected_flow:String(revision.value.affected_flow??revision.value.question??report.value.title).slice(0,500),cohort_keys:cohortKeys,release_refs:releaseRefs,accepted_findings:(report.value.findings??[]).map((finding:Row)=>({text:String(finding.text),evidence_ids:finding.evidence_ids??[]})),rejected_or_unresolved_alternatives:report.value.alternatives??[],falsifiers,control_observations:controls,test_prerequisites:prerequisites,oracle_version:report.binding?.algorithm_version??null,claim_axes:claimAxes(report.value.claim??{}),limitations:report.value.limitations??[],follow_up_outcome:followUp,created_by:pid,accepted_at:now()},capsuleHash=investigationCapsuleHash(content);
  await tx.query('INSERT INTO faultline.memory_capsules(id,workspace_id,case_id,revision_id,report_id,value,capsule_hash,accepted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,wid,cid,revision.id,input.report_id,content,capsuleHash,pid]);
  await audit(tx,wid,pid,'memory.capsule.accept',{case_id:cid,report_id:input.report_id,capsule_id:id,capsule_hash:capsuleHash,authority:'explicit accepted published report; deterministic claims unchanged'});
  return {id,capsule_hash:capsuleHash,status:'active'};
 },['owner','analyst']);
}

export async function listReportMemory(wid:string,pid:string,cid:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,cid);const rows=(await tx.query('SELECT id,report_id,status,value,capsule_hash,accepted_at,withdrawn_at FROM faultline.memory_capsules WHERE workspace_id=$1 AND case_id=$2 ORDER BY accepted_at DESC,id LIMIT 100',[wid,cid])).rows,current=await currentCapsulesTx(tx,wid,pid),currentIds=new Set(current.capsules.map(item=>item.capsule_id));return rows.map((row:Row)=>({id:row.id,report_id:row.report_id,status:row.status==='active'&&currentIds.has(row.id)?'active':row.status==='withdrawn'?'withdrawn':'stale',capsule_hash:row.capsule_hash,accepted_at:row.accepted_at,withdrawn_at:row.withdrawn_at,value:row.value}));});}

export async function withdrawReportMemory(wid:string,pid:string,key:string,cid:string,capsuleId:string,reason:string,match:string){
 demand(uuid.test(capsuleId)&&/^[a-f0-9]{64}$/.test(match)&&typeof reason==='string'&&reason.trim().length>0&&reason.length<=500,'INVALID_MEMORY_WITHDRAWAL','Choose exact investigation memory and give a short reason.',400);
 return command(wid,pid,'memory.capsule.withdraw',key,{caseId:cid,capsuleId,reason:reason.trim(),match},async tx=>{const role=await access(tx,wid,pid,['owner','analyst']);demand(role==='owner'||role==='analyst','FORBIDDEN','This role cannot withdraw investigation memory.',403);await getCaseTx(tx,wid,pid,cid,true);const row=(await tx.query('SELECT * FROM faultline.memory_capsules WHERE workspace_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE',[wid,cid,capsuleId])).rows[0];demand(row,'NOT_FOUND','Investigation memory unavailable.',404);demand(row.capsule_hash===match,'STALE_INPUTS','Investigation memory changed.',409);if(row.status==='active'){await tx.query("UPDATE faultline.memory_capsules SET status='withdrawn',withdrawn_at=now() WHERE workspace_id=$1 AND case_id=$2 AND id=$3",[wid,cid,capsuleId]);await audit(tx,wid,pid,'memory.capsule.withdraw',{case_id:cid,capsule_id:capsuleId,capsule_hash:row.capsule_hash,reason:reason.trim()});}return {id:capsuleId,status:'withdrawn',capsule_hash:row.capsule_hash};},['owner','analyst']);
}

export async function recordMemoryFeedback(wid:string,pid:string,key:string,cid:string,retrievalId:string,capsuleId:string,kind:MemoryFeedbackKind){
 demand(uuid.test(retrievalId)&&uuid.test(capsuleId)&&['helpful','not_relevant','wrong'].includes(kind),'INVALID_MEMORY_FEEDBACK','Choose a retrieved prior investigation and feedback kind.',400);
 return command(wid,pid,'memory.feedback.create',key,{caseId:cid,retrievalId,capsuleId,kind},async tx=>{
  const role=await access(tx,wid,pid,['owner','analyst']);demand(role==='owner'||role==='analyst','FORBIDDEN','This role cannot rate investigation memory.',403);await getCaseTx(tx,wid,pid,cid,true);
  const retrieval=(await tx.query('SELECT * FROM faultline.memory_retrievals WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,retrievalId])).rows[0];demand(retrieval&&retrieval.result_hash===hash(retrieval.value),'STALE_AGENT_MEMORY','Memory retrieval is unavailable.',409);
  demand((retrieval.value.capsules??[]).some((item:Row)=>item.capsule.capsule_id===capsuleId),'MEMORY_NOT_RETRIEVED','Rate only a prior investigation shown in this retrieval.',409);
  const catalog=await currentCapsulesTx(tx,wid,pid),engine=new MeterlessInvestigationMemory({workspace_id:wid,catalog_generation:catalog.catalog_hash});engine.rebuild(catalog.capsules);const applied=engine.feedback(capsuleId,kind),id=newId();
  await tx.query('INSERT INTO faultline.memory_feedback(id,workspace_id,case_id,capsule_id,retrieval_id,actor_id,kind,engine_trace) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,wid,cid,capsuleId,retrievalId,pid,kind,{adapter_version:applied.adapter_version,trace:applied.trace,metrics:applied.metrics}]);
  await audit(tx,wid,pid,'memory.feedback.create',{case_id:cid,retrieval_id:retrievalId,capsule_id:capsuleId,kind,feedback_id:id});return {id,capsule_id:capsuleId,kind,applied:true};
 },['owner','analyst']);
}
