import defaults from '../../../../config/defaults.json' with {type:'json'};
import {createHmac,timingSafeEqual} from 'node:crypto';
import {requireDatabase,transaction,type Tx} from '../../../database/src/client.js';
import {access,audit,command,expected} from '../workspaces/service.js';
import {policyTx} from '../controls/service.js';
import {canonical,hash,newId} from '../canonical.js';
import {config} from '../config.js';
import {demand,DomainError} from '../errors.js';

export const retentionFields=['raw_upload_retention_days','canonical_event_retention_days','attachment_retention_days','report_retention_days','audit_retention_days'] as const;
export type RetentionField=typeof retentionFields[number];
export type RetentionKind='raw_import'|'snapshot'|'evidence_artifact'|'report'|'report_export'|'audit';
export type RetentionPatch=Partial<Record<RetentionField,number>>;
type Row=Record<string,any>;
type Reference={resource_kind:RetentionKind;resource_id:string;content_hash:string;revision_id:string|null};
export type RetentionResource={
 resource_kind:RetentionKind;resource_id:string;case_id:string|null;captured_at:string;content_hash:string;
 revision_id:string|null;resource_revision:number|null;object_keys:string[];policy_field:RetentionField;
 binding:Record<string,unknown>;snapshot_ids:string[];evidence_ids:string[];artifact_ids:string[];
 shared_reference_count:number;
};
export type RetentionImpactResource=RetentionResource&{
 age_days:number;previous_expires_at:string;expires_at:string;shortened:boolean;
 caused_by:Reference[];cited_reports:Reference[];report_downloads:Reference[];
};
export type RetentionImpact={resources:RetentionImpactResource[];counts:Record<string,number>;affected_citations:number;physical_cleanup:'pending_separate_review'};
type Review={version:1;purpose:'policy-retention';workspace_id:string;principal_id:string;policy_revision:number;previous_policy_hash:string;policy_hash:string;patch_hash:string;as_of:string;effective_at:string;impact_hash:string;expires_at:string};
const day=86400000,limit=10000;
export const retentionBackupNotice='Logical expiry revokes product access and dependent claims. Private bytes and database content remain pending separately reviewed granular cleanup. Encrypted backups retain content under their independent operator retention policy.';
const instant=(value:string)=>{const time=Date.parse(value);demand(Number.isFinite(time),'INVALID_RETENTION_TIME','A server capture time is required.');return time;};
const iso=(value:number)=>new Date(value).toISOString();
const unique=(values:string[])=>[...new Set(values)].sort();
const reference=(r:RetentionResource):Reference=>({resource_kind:r.resource_kind,resource_id:r.resource_id,content_hash:r.content_hash,revision_id:r.revision_id});
const refKey=(r:{resource_kind:RetentionKind;resource_id:string})=>r.resource_kind+':'+r.resource_id;
export function retentionPatch(input:Record<string,unknown>):RetentionPatch {
 const result:RetentionPatch={};for(const field of retentionFields)if(Object.hasOwn(input,field)){const value=input[field];demand(Number.isSafeInteger(value)&&Number(value)>=1&&Number(value)<=3650,'INVALID_POLICY','Retention periods are integral days between1and3650.');result[field]=Number(value);}return result;
}
function policyInput(input:Record<string,unknown>):Record<string,number>{
 const ceilings={max_automatic_model_calls:defaults.ai.maxCalls,max_input_tokens:defaults.ai.maxInputTokens,max_output_tokens:defaults.ai.maxOutputTokens,max_records_per_snapshot:defaults.limits.sourceRecords},result:Record<string,number>={...retentionPatch(input)};
 for(const [field,value] of Object.entries(input)){if((retentionFields as readonly string[]).includes(field))continue;demand(Object.hasOwn(ceilings,field)&&Number.isSafeInteger(value)&&Number(value)>=(field==='max_records_per_snapshot'?1:0)&&Number(value)<=ceilings[field as keyof typeof ceilings],'INVALID_POLICY','Policy fields must remain inside the finite installation ceilings.');result[field]=Number(value);}demand(Object.keys(result).length>0,'INVALID_INPUT','Choose a finite policy change.');return result;
}
export function retentionEffectiveAt(asOf:string,requested?:string):string {
 const minimum=instant(asOf)+defaults.retention.deletedCaseGraceDays*day;
 if(requested!==undefined)demand(instant(requested)>=minimum,'RETENTION_GRACE_REQUIRED','The effective time may extend, but cannot shorten, the configured review grace.',409);
 return requested===undefined?iso(minimum):iso(instant(requested));
}
/** A deterministic clock fixture may call this helper; production callers use server-created capture timestamps. */
function buildImpact(resources:RetentionResource[],previous:Record<string,number>,patch:RetentionPatch,asOf:string,effectiveAt:string,newReview:boolean):RetentionImpact {
 const clock=instant(asOf),effective=instant(effectiveAt),fields=new Set(Object.keys(patch)),selected=new Map<string,RetentionImpactResource>();
 if(newReview)demand(effective>=clock+defaults.retention.deletedCaseGraceDays*day,'RETENTION_GRACE_REQUIRED','Review grace is required.',409);
 for(const resource of resources){
  demand(Number.isFinite(instant(resource.captured_at))&&instant(resource.captured_at)<=clock,'INVALID_RETENTION_TIME','Retention age must come from a completed server capture, not a future or event timestamp.');
  if(!fields.has(resource.policy_field))continue;
  const days=patch[resource.policy_field]!,prior=previous[resource.policy_field];demand(Number.isSafeInteger(prior)&&Number(prior)>0,'INVALID_POLICY','The current explicit retention policy is required.');
  const expires_at=iso(Math.max(effective,instant(resource.captured_at)+days*day));selected.set(refKey(resource),{...resource,binding:{...resource.binding,retention_direct:true,direct_expires_at:expires_at},age_days:(clock-instant(resource.captured_at))/day,previous_expires_at:iso(instant(resource.captured_at)+prior!*day),expires_at,shortened:days<prior!,caused_by:[],cited_reports:[],report_downloads:[]});
 }
 // Reports and signed downloads lose access when a cited snapshot or attachment expires,
 // even when their own report period is longer. Raw uploads do not substitute for snapshots.
 const reports=resources.filter(r=>r.resource_kind==='report');
 for(const report of reports){
  const causes=[...selected.values()].filter(r=>r.case_id===report.case_id&&(r.resource_kind==='snapshot'&&report.snapshot_ids.includes(r.resource_id)||r.resource_kind==='evidence_artifact'&&(r.evidence_ids.some(id=>report.evidence_ids.includes(id))||report.artifact_ids.includes(r.resource_id))));
  if(!causes.length)continue;
  let target=selected.get(refKey(report));const due=Math.min(...causes.map(r=>instant(r.expires_at)));
  if(!target){const prior=previous.report_retention_days;demand(Number.isSafeInteger(prior)&&Number(prior)>0,'INVALID_POLICY','Explicit report retention is required.');target={...report,binding:{...report.binding,retention_direct:false},age_days:(clock-instant(report.captured_at))/day,previous_expires_at:iso(instant(report.captured_at)+prior!*day),expires_at:iso(due),shortened:true,caused_by:[],cited_reports:[],report_downloads:[]};selected.set(refKey(report),target);}
  else target.expires_at=iso(Math.min(instant(target.expires_at),due));
  target.caused_by=causes.map(reference).sort((a,b)=>refKey(a).localeCompare(refKey(b)));
  for(const cause of causes)cause.cited_reports.push(reference(report));
 }
 for(const download of resources.filter(r=>r.resource_kind==='report_export')){
  const causes=[...selected.values()].filter(r=>r.case_id===download.case_id&&(r.resource_kind==='report'&&download.binding.report_id===r.resource_id||r.resource_kind==='evidence_artifact'&&download.artifact_ids.includes(r.resource_id)));
  if(!causes.length)continue;const due=Math.min(...causes.map(r=>instant(r.expires_at)));let target=selected.get(refKey(download));
  if(!target){target={...download,binding:{...download.binding,retention_direct:false},age_days:(clock-instant(download.captured_at))/day,previous_expires_at:iso(instant(download.captured_at)+previous.report_retention_days!*day),expires_at:iso(due),shortened:true,caused_by:[],cited_reports:[],report_downloads:[]};selected.set(refKey(download),target);}else target.expires_at=iso(Math.min(instant(target.expires_at),due));
  target.caused_by=causes.map(reference).sort((a,b)=>refKey(a).localeCompare(refKey(b)));for(const cause of causes)cause.report_downloads.push(reference(download));
 }
 const result=[...selected.values()].sort((a,b)=>refKey(a).localeCompare(refKey(b))),counts:Record<string,number>={total:result.length,due_at_effective:result.filter(r=>instant(r.expires_at)===effective).length,shared_objects:result.filter(r=>r.shared_reference_count>0).length};
 for(const kind of ['raw_import','snapshot','evidence_artifact','report','report_export','audit'] as const)counts[kind]=result.filter(r=>r.resource_kind===kind).length;
 return {resources:result,counts,affected_citations:result.filter(r=>r.caused_by.length>0).length,physical_cleanup:'pending_separate_review'};
}
export function buildPolicyRetentionImpact(resources:RetentionResource[],previous:Record<string,number>,patch:RetentionPatch,asOf:string,effectiveAt:string):RetentionImpact{return buildImpact(resources,previous,patch,asOf,effectiveAt,true);}
const hmac=(value:unknown,secret=config.authSecret)=>createHmac('sha256',secret).update(canonical(value)).digest('base64url');
export function signPolicyRetentionReview(value:Review,secret=config.authSecret):string{return Buffer.from(canonical(value)).toString('base64url')+'.'+hmac(value,secret);}
export function readPolicyRetentionReview(value:string,nowMs=Date.now(),secret=config.authSecret):Review {
 demand(typeof value==='string'&&value.length<=4096,'RETENTION_REVIEW_REQUIRED','Review the exact policy impact first.',409);const parts=value.split('.');demand(parts.length===2,'RETENTION_REVIEW_REQUIRED','Invalid policy review token.',409);
 let parsed:Review;try{parsed=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));}catch{throw new DomainError('RETENTION_REVIEW_REQUIRED','Invalid policy review token.',409);}
 demand(parsed&&typeof parsed==='object'&&parsed.version===1&&parsed.purpose==='policy-retention','RETENTION_REVIEW_REQUIRED','Invalid policy review scope.',409);
 const wanted=hmac(parsed,secret),supplied=parts[1]!;demand(/^[A-Za-z0-9_-]{43}$/.test(supplied)&&supplied.length===wanted.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(wanted)),'RETENTION_REVIEW_REQUIRED','Policy review signature differs.',409);
 demand(instant(parsed.expires_at)>nowMs&&instant(parsed.as_of)<=nowMs,'RETENTION_REVIEW_EXPIRED','Review the current policy impact again.',409);return parsed;
}
export function assertPolicyRetentionReview(review:Review,current:{workspace_id:string;principal_id:string;policy_revision:number;previous_policy_hash:string;policy_hash:string;patch_hash:string;impact_hash:string}){
 demand(review.workspace_id===current.workspace_id&&review.principal_id===current.principal_id&&review.policy_revision===current.policy_revision&&review.previous_policy_hash===current.previous_policy_hash&&review.policy_hash===current.policy_hash&&review.patch_hash===current.patch_hash&&review.impact_hash===current.impact_hash,'RETENTION_IMPACT_CHANGED','Policy, cited evidence, artifacts or reports changed after preview. Review the exact impact again.',409);
}

async function inventoryTx(tx:Tx,wid:string):Promise<RetentionResource[]> {
 const tables=['imports','snapshots','evidence','evidence_artifacts','verification_artifacts','report_versions','report_exports','integration_capture_artifacts','audit'] as const,rows:Record<string,Row[]>={};
 for(const table of tables){const query=table==='audit'?'SELECT t.* FROM faultline.audit t WHERE t.workspace_id=$1 ORDER BY t.created_at,t.id LIMIT $2':'SELECT t.*,c.active_revision_id AS case_revision_id,c.revision AS case_revision FROM faultline.'+table+' t JOIN faultline.cases c ON c.workspace_id=t.workspace_id AND c.id=t.case_id WHERE t.workspace_id=$1 AND c.deletion_requested_at IS NULL ORDER BY t.created_at,t.id LIMIT $2';rows[table]=(await tx.query(query,[wid,limit+1])).rows;demand(rows[table]!.length<=limit,'RETENTION_IMPACT_LIMIT','This workspace exceeds the bounded complete retention inventory. Use an operator-reviewed narrower inventory; no truncated impact was approved.',409);}
 const references=(await tx.query('SELECT case_id,object_key FROM faultline.object_references WHERE workspace_id=$1 ORDER BY case_id,object_key LIMIT $2',[wid,limit+1])).rows;demand(references.length<=limit,'RETENTION_IMPACT_LIMIT','Object reference inventory exceeds its complete bounded preview.',409);
 const evidence=new Map(rows.evidence!.map(r=>[r.id,r])),all:RetentionResource[]=[];
 const add=(row:Row,kind:RetentionKind,table:string,field:RetentionField,contentHash:string,keys:string[],extra:Record<string,unknown>={},evidenceIds:string[]=[],snapshotIds:string[]=[],artifactIds:string[]=[])=>{
  const binding={table,case_revision_id:row.case_revision_id??null,case_revision:row.case_revision??null,...extra};
  all.push({resource_kind:kind,resource_id:row.id,case_id:row.case_id??null,captured_at:row.created_at,content_hash:contentHash,revision_id:row.value?.revision_id??row.case_revision_id??null,resource_revision:row.revision??null,object_keys:unique(keys.filter(Boolean)),policy_field:field,binding,evidence_ids:unique(evidenceIds),snapshot_ids:unique(snapshotIds),artifact_ids:unique(artifactIds),shared_reference_count:0});
 };
 for(const r of rows.imports!)add(r,'raw_import','imports','raw_upload_retention_days',r.raw_key,[r.raw_key],{source_id:r.source_id,record_kind:r.record_kind,stage:r.stage,raw_bytes:String(r.raw_bytes)});
 for(const r of rows.integration_capture_artifacts!)add(r,'raw_import','integration_capture_artifacts','raw_upload_retention_days',r.sha256,[r.object_key],{capture_id:r.capture_id,kind:r.kind,size_bytes:String(r.size_bytes)});
 for(const r of rows.snapshots!){const related=rows.evidence!.filter(e=>e.value.snapshot_id===r.id);add(r,'snapshot','snapshots','canonical_event_retention_days',r.content_hash,[r.object_key],{source_id:r.source_id,import_id:r.import_id,record_count:r.value.record_count,record_kind:rows.imports!.find(i=>i.id===r.import_id)?.record_kind??'unknown',withdrawn:r.withdrawn},related.map(e=>e.id),[r.id]);}
 for(const r of rows.evidence_artifacts!)add(r,'evidence_artifact','evidence_artifacts','attachment_retention_days',r.sha256,[r.object_key],{evidence_id:r.evidence_id,evidence_revision:evidence.get(r.evidence_id)?.revision??null,evidence_hash:evidence.get(r.evidence_id)?.value.content_hash??null,original_id:r.original_id??null,kind:r.kind,size_bytes:String(r.size_bytes)},[r.evidence_id],[],[r.id]);
 for(const r of rows.verification_artifacts!){const related=rows.evidence!.filter(e=>e.value.source_ref==='verification:'+r.result_id);add(r,'evidence_artifact','verification_artifacts','attachment_retention_days',r.sha256,[r.object_key],{result_id:r.result_id,run_id:r.run_id,size_bytes:String(r.size_bytes)},related.map(e=>e.id),[],[r.id]);}
 for(const r of rows.report_versions!){const ids=unique((r.value.findings??[]).flatMap((f:Row)=>f.evidence_ids??[]));const snapshots=unique([r.binding.snapshot_id,...ids.map(id=>evidence.get(id)?.value.snapshot_id)].filter((v):v is string=>typeof v==='string'));const artifacts=unique(ids.flatMap(id=>(evidence.get(id)?.value.artifact_refs??[]).map((a:Row)=>a.artifact_id)));add(r,'report','report_versions','report_retention_days',hash(r.value),[],{input_manifest_hash:r.value.input_manifest_hash,binding_hash:hash(r.binding),evidence:ids.map(id=>({id,revision:evidence.get(id)?.revision??null,content_hash:evidence.get(id)?.value.content_hash??null,redaction_status:evidence.get(id)?.redaction_status??'missing'}))},ids,snapshots,artifacts);}
 for(const r of rows.report_exports!)add(r,'report_export','report_exports','report_retention_days',r.object_key,[r.object_key],{report_id:r.report_id,manifest_hash:hash(r.manifest),format:r.format},(r.manifest.evidence??[]).map((e:Row)=>e.id),[],(r.manifest.attachments??[]).map((a:Row)=>a.id));
 for(const r of rows.audit!)add(r,'audit','audit','audit_retention_days',hash({operation:r.operation,actor_id:r.actor_id,details:r.details}),[],{operation:r.operation});
 const resourceKeys=new Map<string,Set<string>>(),referenceCases=new Map<string,Set<string>>();for(const r of all)for(const key of r.object_keys){if(!resourceKeys.has(key))resourceKeys.set(key,new Set());resourceKeys.get(key)!.add(refKey(r));}for(const r of references){if(!referenceCases.has(r.object_key))referenceCases.set(r.object_key,new Set());referenceCases.get(r.object_key)!.add(r.case_id);}
 for(const r of all){const otherResources=new Set<string>(),otherCases=new Set<string>();for(const key of r.object_keys){for(const item of resourceKeys.get(key)??[])if(item!==refKey(r))otherResources.add(item);for(const cid of referenceCases.get(key)??[])if(cid!==r.case_id)otherCases.add(cid);}r.shared_reference_count=otherResources.size+otherCases.size;}
 return all;
}
async function previewTx(tx:Tx,wid:string,pid:string,input:Record<string,unknown>,options:{effective_at?:string}={}){
 await access(tx,wid,pid,['owner']);await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid]);const row=await policyTx(tx,wid),request=policyInput(input),patch=retentionPatch(request),as_of=new Date().toISOString(),effective_at=retentionEffectiveAt(as_of,options.effective_at),impact=buildPolicyRetentionImpact(await inventoryTx(tx,wid),row.value,patch,as_of,effective_at),value={...row.value,...request},review_expires_at=iso(instant(as_of)+5*60000);
 const review:Review={version:1,purpose:'policy-retention',workspace_id:wid,principal_id:pid,policy_revision:row.revision,previous_policy_hash:hash(row.value),policy_hash:hash(value),patch_hash:hash(request),as_of,effective_at,impact_hash:hash(impact),expires_at:review_expires_at};
 return {policy_revision:row.revision,previous_policy_hash:review.previous_policy_hash,policy_hash:review.policy_hash,patch,as_of,effective_at,grace_days:defaults.retention.deletedCaseGraceDays,impact,impact_hash:review.impact_hash,review_token:signPolicyRetentionReview(review),review_expires_at,backup_notice:retentionBackupNotice};
}
export async function previewPolicyRetention(wid:string,pid:string,patch:Record<string,unknown>,options:{effective_at?:string}={}){return transaction(wid,tx=>previewTx(tx,wid,pid,patch,options));}
async function registerTx(tx:Tx,wid:string,changeId:string,impact:RetentionImpact){
 for(let start=0;start<impact.resources.length;start+=250){const values=impact.resources.slice(start,start+250).map(r=>({id:newId(),change_id:changeId,case_id:r.case_id,resource_kind:r.resource_kind,resource_id:r.resource_id,binding:{...r.binding,policy_field:r.policy_field,revision_id:r.revision_id,resource_revision:r.resource_revision,evidence_ids:r.evidence_ids,snapshot_ids:r.snapshot_ids,artifact_ids:r.artifact_ids,caused_by:r.caused_by,shared_reference_count:r.shared_reference_count},content_hash:r.content_hash,captured_at:r.captured_at,expires_at:r.expires_at,object_keys:r.object_keys}));await tx.query("INSERT INTO faultline.policy_expirations(id,workspace_id,change_id,case_id,resource_kind,resource_id,binding,content_hash,captured_at,expires_at,object_keys,status) SELECT v.id,$1,v.change_id,v.case_id,v.resource_kind,v.resource_id,v.binding,v.content_hash,v.captured_at,v.expires_at,v.object_keys,'scheduled' FROM jsonb_to_recordset($2::jsonb) AS v(id uuid,change_id uuid,case_id uuid,resource_kind text,resource_id uuid,binding jsonb,content_hash text,captured_at timestamptz,expires_at timestamptz,object_keys jsonb) ON CONFLICT(workspace_id,change_id,resource_kind,resource_id) DO NOTHING",[wid,JSON.stringify(values)]);}
}
/** Root invokes this within its owner policy command, before updating the policy row. */
export async function approvePolicyRetentionTx(tx:Tx,wid:string,pid:string,input:Record<string,unknown>,currentPolicyRow:Row,reviewToken?:string){
 const request=policyInput(input),patch=retentionPatch(request);if(!Object.keys(patch).length)return null;await access(tx,wid,pid,['owner']);demand(reviewToken,'RETENTION_REVIEW_REQUIRED','Preview and explicitly review the exact retention impact.',409);
 const reviewed=readPolicyRetentionReview(reviewToken),inventory=await inventoryTx(tx,wid);demand(!inventory.some(r=>instant(r.captured_at)>instant(reviewed.as_of)),'RETENTION_IMPACT_CHANGED','New captured data changed the workspace after preview. Review the exact impact again.',409);const impact=buildPolicyRetentionImpact(inventory,currentPolicyRow.value,patch,reviewed.as_of,reviewed.effective_at),value={...currentPolicyRow.value,...request};
 assertPolicyRetentionReview(reviewed,{workspace_id:wid,principal_id:pid,policy_revision:currentPolicyRow.revision,previous_policy_hash:hash(currentPolicyRow.value),policy_hash:hash(value),patch_hash:hash(request),impact_hash:hash(impact)});
 // Approval may only extend the reviewed date: every actual approval gets the full grace.
 const approvedAt=new Date().toISOString(),effectiveAt=iso(Math.max(instant(reviewed.effective_at),instant(approvedAt)+defaults.retention.deletedCaseGraceDays*day));
 for(const resource of impact.resources){resource.expires_at=iso(Math.max(instant(resource.expires_at),instant(effectiveAt)));if(resource.binding.retention_direct)resource.binding.direct_expires_at=iso(Math.max(instant(String(resource.binding.direct_expires_at)),instant(effectiveAt)));}
 impact.counts.due_at_effective=impact.resources.filter(r=>r.expires_at===effectiveAt).length;
 const approvedHash=hash(impact),id=newId(),revision=currentPolicyRow.revision+1;await tx.query("INSERT INTO faultline.policy_retention_changes(id,workspace_id,actor_id,base_policy_revision,policy_revision,previous_policy_hash,policy_hash,patch,impact,impact_hash,reviewed_at,effective_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled')",[id,wid,pid,currentPolicyRow.revision,revision,reviewed.previous_policy_hash,reviewed.policy_hash,patch,impact,approvedHash,approvedAt,effectiveAt]);await registerTx(tx,wid,id,impact);
 await audit(tx,wid,pid,'policy.retention.review',{change_id:id,policy_revision:revision,reviewed_impact_hash:reviewed.impact_hash,impact_hash:approvedHash,counts:impact.counts,effective_at:effectiveAt});return {id,status:'scheduled' as const,policy_revision:revision,effective_at:effectiveAt,impact_hash:approvedHash,physical_cleanup:'pending_separate_review' as const};
}
function activeFields(change:Row,changes:Row[],policy:Row):RetentionPatch {
 const result:RetentionPatch={};for(const field of retentionFields)if(Object.hasOwn(change.patch,field)){const latest=changes.find(r=>Object.hasOwn(r.patch,field));if(latest?.id===change.id&&policy.value[field]===change.patch[field])result[field]=change.patch[field];}return result;
}
export function policyRetentionDeadline(entry:Row,entries:Row[],fields:RetentionPatch,visited=new Set<string>()):number|null {
 const key=refKey(entry as {resource_kind:RetentionKind;resource_id:string});demand(!visited.has(key)&&visited.size<=20,'RETENTION_DEPENDENCY_INVALID','Retention dependency bindings must be finite and acyclic.',409);const next=new Set([...visited,key]),deadlines:number[]=[];
 if(entry.binding.retention_direct!==false&&Object.hasOwn(fields,entry.binding.policy_field))deadlines.push(instant(entry.binding.direct_expires_at??entry.expires_at));
 for(const ref of entry.binding.caused_by??[]){const cause=entries.find(e=>e.resource_kind===ref.resource_kind&&e.resource_id===ref.resource_id);demand(cause,'RETENTION_DEPENDENCY_INVALID','The immutable cited expiration binding is missing.',409);const deadline=policyRetentionDeadline(cause,entries,fields,next);if(deadline!==null)deadlines.push(deadline);}
 return deadlines.length?Math.min(...deadlines):null;
}
async function revokedTx(tx:Tx,wid:string,entry:Row){
 if(entry.resource_kind==='snapshot'){await tx.query('UPDATE faultline.snapshots SET withdrawn=true WHERE workspace_id=$1 AND id=$2',[wid,entry.resource_id]);await tx.query("UPDATE faultline.evidence SET redaction_status='withdrawn',revision=revision+1 WHERE workspace_id=$1 AND value->>'snapshot_id'=$2::text AND redaction_status<>'withdrawn'",[wid,entry.resource_id]);}
 if(entry.resource_kind==='evidence_artifact')for(const id of entry.binding.evidence_ids??[])await tx.query("UPDATE faultline.evidence SET redaction_status='withdrawn',revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND redaction_status<>'withdrawn'",[wid,id]);
}
export async function getPolicyRetention(wid:string,pid:string,id:string){return transaction(wid,async tx=>{await access(tx,wid,pid,['owner']);const row=(await tx.query('SELECT * FROM faultline.policy_retention_changes WHERE workspace_id=$1 AND id=$2',[wid,id])).rows[0];demand(row,'NOT_FOUND','Policy retention receipt unavailable.',404);const expirations=(await tx.query('SELECT * FROM faultline.policy_expirations WHERE workspace_id=$1 AND change_id=$2 ORDER BY expires_at,resource_kind,resource_id',[wid,id])).rows;const {fence,lease_until,...safe}=row;return {...safe,expirations,backup_notice:retentionBackupNotice};});}
/** An owner retries logical reconciliation only; this grants no new physical cleanup authority. */
export async function resumePolicyRetention(wid:string,pid:string,key:string,id:string,match:string){return command(wid,pid,'policy.retention.resume',key,{id,match},async tx=>{await access(tx,wid,pid,['owner']);const row=(await tx.query('SELECT * FROM faultline.policy_retention_changes WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[wid,id])).rows[0];demand(row,'NOT_FOUND','Policy retention receipt unavailable.',404);expected(match,row.revision);demand(row.status!=='cancelled'&&row.status!=='completed','RETENTION_NOT_RESUMABLE','This immutable policy receipt cannot be resumed.',409);demand(!row.fence||!row.lease_until||instant(row.lease_until)<Date.now(),'RETENTION_BUSY','A fenced retention check is still active.',409);demand(row.actor_id===pid,'RETENTION_REVIEW_REQUIRED','A different current owner must create a fresh policy review.',409);await tx.query('UPDATE faultline.policy_retention_changes SET lease_until=NULL,fence=NULL,error_code=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[wid,id]);await audit(tx,wid,pid,'policy.retention.resume',{change_id:id,physical_authority:false});return {id,status:row.status,revision:row.revision+1,physical_cleanup:'pending_separate_review'};},['owner']);}
/** Enforce logical expiry even if the scheduler is unavailable; physical presence is not access permission. */
export async function assertResourceRetainedTx(tx:Tx,wid:string,kind:RetentionKind,id:string):Promise<void>{
 const entries=(await tx.query('SELECT e.*,c.status AS change_status,c.patch FROM faultline.policy_expirations e JOIN faultline.policy_retention_changes c ON c.workspace_id=e.workspace_id AND c.id=e.change_id WHERE e.workspace_id=$1 AND e.resource_kind=$2 AND e.resource_id=$3 FOR SHARE OF e',[wid,kind,id])).rows;
 if(entries.some(e=>['expired_pending_cleanup','cleaned','retained_shared','blocked'].includes(e.status)&&e.expired_at))throw new DomainError('RETENTION_EXPIRED','This exact resource has expired. Dependent content is unavailable while physical cleanup remains pending.',409);
 // A later capture may not have been registered while the dispatcher was unavailable.
 // The current reviewed finite policy still applies; a missing scheduler row is not retention permission.
 const policy=(await tx.query('SELECT value FROM faultline.workspace_policies WHERE workspace_id=$1 FOR SHARE',[wid])).rows[0],changes=(await tx.query('SELECT id,patch,status,effective_at FROM faultline.policy_retention_changes WHERE workspace_id=$1 ORDER BY policy_revision DESC,created_at DESC,id DESC LIMIT $2',[wid,limit+1])).rows;demand(changes.length<=limit,'RETENTION_IMPACT_LIMIT','Current policy history exceeds its bounded guard.',409);
 for(const entry of entries){if(entry.status!=='scheduled'||entry.change_status==='cancelled'||instant(entry.expires_at)>Date.now())continue;const change=changes.find(c=>c.id===entry.change_id);if(!change||!policy)continue;const fields=activeFields(change,changes,policy);const siblings=(await tx.query('SELECT resource_kind,resource_id,binding,expires_at FROM faultline.policy_expirations WHERE workspace_id=$1 AND change_id=$2',[wid,entry.change_id])).rows,deadline=policyRetentionDeadline(entry,siblings,fields);if(deadline!==null&&deadline<=Date.now())throw new DomainError('RETENTION_EXPIRED','The reviewed retention date has passed. Access and current claims are revoked; cleanup is pending.',409);}
 if(!policy||!changes.some(c=>c.status!=='cancelled'&&instant(c.effective_at)<=Date.now()))return;
 // Another current field may affect a later citation not yet registered by that field's dispatcher.
 // A future marker from a different policy field cannot substitute for this current check.
 const inventory=await inventoryTx(tx,wid),clock=new Date().toISOString();
 for(const change of changes){if(change.status==='cancelled'||instant(change.effective_at)>Date.now())continue;const fields=activeFields(change,changes,policy);if(!Object.keys(fields).length)continue;const candidate=buildImpact(inventory,policy.value,fields,clock,change.effective_at,false).resources.find(r=>r.resource_kind===kind&&r.resource_id===id);if(candidate&&instant(candidate.expires_at)<=Date.now())throw new DomainError('RETENTION_EXPIRED','This later capture has expired under the current reviewed policy. Scheduler reconciliation and physical cleanup remain pending.',409);}
}
export async function policyRetentionTick(){
 const routes=(await requireDatabase().query('SELECT * FROM faultline.policy_retention_routes()')).rows;
 for(const route of routes)await transaction(route.workspace_id,async tx=>{
  const wid=route.workspace_id,workspace=(await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 AND deletion_requested_at IS NULL FOR UPDATE',[wid])).rows[0];if(!workspace)return;const change=(await tx.query("SELECT * FROM faultline.policy_retention_changes WHERE workspace_id=$1 AND id=$2 AND status IN('scheduled','expiring','pending_cleanup') AND effective_at<=now() AND (lease_until IS NULL OR lease_until<now()) FOR UPDATE",[wid,route.id])).rows[0];if(!change)return;
  const member=(await tx.query('SELECT role FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[wid,change.actor_id])).rows[0],policy=(await tx.query('SELECT value FROM faultline.workspace_policies WHERE workspace_id=$1 FOR SHARE',[wid])).rows[0],changes=(await tx.query('SELECT id,patch FROM faultline.policy_retention_changes WHERE workspace_id=$1 ORDER BY policy_revision DESC,created_at DESC,id DESC LIMIT $2',[wid,limit+1])).rows;demand(changes.length<=limit,'RETENTION_IMPACT_LIMIT','Current policy history exceeds its bounded reconciliation.',409);
  if(member?.role!=='owner'||!policy){await tx.query("UPDATE faultline.policy_retention_changes SET status='pending_cleanup',error_code='RETENTION_REVIEWER_AUTHORIZATION_CHANGED',result=$3,lease_until=now()+interval '60 seconds',updated_at=now() WHERE workspace_id=$1 AND id=$2",[wid,change.id,{removed:0,access_revoked:'only previously expired resources',pending:'A current owner must explicitly review the policy again.'}]);return;}
  const fields=activeFields(change,changes,policy),existing=(await tx.query('SELECT * FROM faultline.policy_expirations WHERE workspace_id=$1 AND change_id=$2 FOR UPDATE',[wid,change.id])).rows;
  for(const entry of existing)if(entry.status==='scheduled'&&policyRetentionDeadline(entry,existing,fields)===null)await tx.query("UPDATE faultline.policy_expirations SET status='cancelled',error_code='POLICY_SUPERSEDED' WHERE workspace_id=$1 AND id=$2",[wid,entry.id]);
  const active=(await tx.query("SELECT (SELECT count(*) FROM faultline.jobs WHERE workspace_id=$1 AND status IN('queued','running','cancel_requested'))+(SELECT count(*) FROM faultline.provider_operations WHERE workspace_id=$1 AND status IN('queued','running','cancel_requested'))+(SELECT count(*) FROM faultline.storage_reservations WHERE workspace_id=$1) AS count",[wid])).rows[0];
  if(Number(active.count)>0){await tx.query("UPDATE faultline.policy_retention_changes SET status='expiring',error_code='ACTIVE_DEPENDENCIES',lease_until=now()+interval '5 seconds',result=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",[wid,change.id,{active_dependencies:Number(active.count),removed:0,pending:'Wait for contained jobs and private object publications; no lease age proves a writer stopped.'}]);return;}
  const fence=newId();await tx.query("UPDATE faultline.policy_retention_changes SET status='expiring',fence=$3,lease_until=now()+interval '60 seconds',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[wid,change.id,fence]);
  const inventory=await inventoryTx(tx,wid),clock=new Date().toISOString();
  // Apply the reviewed finite periods to later captures. Existing binding/key sets never expand.
  if(Object.keys(fields).length)await registerTx(tx,wid,change.id,buildImpact(inventory,policy.value,fields,clock,change.effective_at,false));
  const entries=(await tx.query('SELECT * FROM faultline.policy_expirations WHERE workspace_id=$1 AND change_id=$2 FOR UPDATE',[wid,change.id])).rows;let expired=0,blocked=0;
  for(const entry of entries){const deadline=entry.status==='scheduled'?policyRetentionDeadline(entry,entries,fields):null;if(deadline===null||deadline>Date.now())continue;const resource=inventory.find(r=>r.resource_kind===entry.resource_kind&&r.resource_id===entry.resource_id);
   if(!resource||resource.content_hash!==entry.content_hash||hash(resource.object_keys)!==hash(entry.object_keys)||instant(resource.captured_at)!==instant(entry.captured_at)){await tx.query("UPDATE faultline.policy_expirations SET status='blocked',expired_at=now(),error_code='RETENTION_RESOURCE_BINDING_CHANGED' WHERE workspace_id=$1 AND id=$2",[wid,entry.id]);blocked++;continue;}
   await revokedTx(tx,wid,entry);await tx.query("UPDATE faultline.policy_expirations SET status='expired_pending_cleanup',expired_at=now(),error_code='GRANULAR_CLEANUP_REVIEW_REQUIRED' WHERE workspace_id=$1 AND id=$2",[wid,entry.id]);expired++;
  }
  const counts=(await tx.query('SELECT status,count(*)::int AS count FROM faultline.policy_expirations WHERE workspace_id=$1 AND change_id=$2 GROUP BY status',[wid,change.id])).rows,result=Object.fromEntries(counts.map(r=>[r.status,r.count])),pending=(result.expired_pending_cleanup??0)+(result.blocked??0),status=pending?'pending_cleanup':Object.keys(fields).length?'scheduled':'cancelled';
  await tx.query('UPDATE faultline.policy_retention_changes SET status=$3,result=$4,error_code=$5,fence=NULL,lease_until=now()+interval \'60 seconds\',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND fence=$6',[wid,change.id,status,{...result,access_revoked:pending>0,removed:0,physical_cleanup:'pending_separate_review',operator_resume:'Use the owner resume endpoint to reconcile logical expiry after the recorded blocker is resolved; physical cleanup needs a separately reviewed granular implementation.'},pending?'GRANULAR_CLEANUP_REVIEW_REQUIRED':null,fence]);
  if(expired||blocked)await audit(tx,wid,change.actor_id,'policy.retention.logical_expiry',{change_id:change.id,expired,blocked,removed:0,policy_revision:change.policy_revision});
 }).catch(async error=>{await transaction(route.workspace_id,tx=>tx.query("UPDATE faultline.policy_retention_changes SET status='pending_cleanup',error_code=$3,fence=NULL,lease_until=now()+interval '60 seconds',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status NOT IN('completed','cancelled') AND (lease_until IS NULL OR lease_until<now())",[route.workspace_id,route.id,error instanceof DomainError?error.code:'POLICY_RETENTION_TICK_FAILED'])).catch(()=>{});});
}
