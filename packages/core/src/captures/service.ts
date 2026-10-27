import {verifySnapshotBytes} from './snapshot-integrity.js';
import {sniffSourceNamespace,bufferedJsonNamespace} from './import-stream.js';
import {finishJobTx} from '../jobs/service.js';
import{computePostgresComparison}from'../metrics/postgres.js';
import{snapshotRecordDigest}from'./snapshot-digest.js';
import {assertResourceRetainedTx} from '../retention/policy.js';
import {sourceCaptureGuardTx} from '../integrations/service.js';
import {pseudonymizeTx} from '../privacy/identity.js';
import {policyTx} from '../controls/service.js';
import {transaction,type Tx} from '../../../database/src/client.js';
import type {FaultlineCoverage,FaultlineCoverageDeclaration,FaultlineCanonicalEvent,FaultlineSnapshot,FaultlineMetric} from '../../../contracts/src/generated.js';
import {validateContract} from '../../../contracts/src/validate.js';
import {getCaseTx} from '../cases/service.js';
import {access,command,audit,expected} from '../workspaces/service.js';
import {enqueue} from '../jobs/service.js';
import {storeBounded} from '../storage/capacity.js';
import {objects} from '../storage/objects.js';
import {newId,hash,now,canonical,canonicalArrayBytes} from '../canonical.js';
import {demand} from '../errors.js';
import {normalizeAnalytics,normalizeCsvStream,normalizeJsonlStream,normalizeEvidenceRecords,normalizeEvidenceStream,requireFinalizableImport,type AnalyticsMapping,type ImportFormat,type FieldPath} from '../imports/parser.js';
import type {FaultlineEvidence} from '../../../contracts/src/generated.js';
import {metadataMicros} from '../imports/time.js';
import {computeComparison,computeMixShift,comparisonEvidenceSummary,validateMetric,assessCoverage,previewComparison} from '../metrics/comparison.js';
import {requireVisibleImport,requireDiscardableImport} from './discard-policy.js';
type MappingInput={kind:string;record_type?:string;schema_version?:number;record_id_path?:FieldPath;text_path?:FieldPath;description_path?:FieldPath;published_at_path?:FieldPath;commit_path?:FieldPath;event_id_path?:FieldPath;session_id_path?:FieldPath;event_time_path?:FieldPath;event_name_path?:FieldPath;device_path?:FieldPath;excluded_path?:FieldPath;release_id_path?:FieldPath;device_map?:{source_value:string;cohort:string}[]};
export async function createImport(wid:string,pid:string,key:string,caseId:string,fields:{kind:string;source_id?:string;format:string;name:string;raw_key:string;raw_bytes:number}){
 return command(wid,pid,'import.create',key,{caseId,...fields},async tx=>{
  await getCaseTx(tx,wid,pid,caseId,true);let sourceId=fields.source_id;
  if(sourceId){demand((await tx.query('SELECT id FROM faultline.sources WHERE workspace_id=$1 AND id=$2',[wid,sourceId])).rowCount,'NOT_FOUND','Source unavailable.',404);}
  else{sourceId=newId();await tx.query('INSERT INTO faultline.sources(id,workspace_id,kind,name) VALUES($1,$2,$3,$4)',[sourceId,wid,'file',fields.name.slice(0,200)]);}
  const id=newId(),row=(await tx.query("INSERT INTO faultline.imports(id,workspace_id,case_id,source_id,record_kind,format,stage,raw_key,raw_bytes) VALUES($1,$2,$3,$4,$5,$6,'staged',$7,$8) RETURNING *",[id,wid,caseId,sourceId,fields.kind,fields.format,fields.raw_key,fields.raw_bytes])).rows[0];
  await audit(tx,wid,pid,'import.stage',{case_id:caseId,import_id:id,raw_hash:fields.raw_key});return row;
 },['owner','analyst'],async(tx,result)=>{await getCaseTx(tx,wid,pid,caseId,true);await importTx(tx,wid,caseId,result.id);});
}
export async function importTx(tx:Tx,wid:string,caseId:string,id:string,lock=false){const row=(await tx.query('SELECT * FROM faultline.imports WHERE workspace_id=$1 AND case_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[wid,caseId,id])).rows[0];requireVisibleImport(row);await assertResourceRetainedTx(tx,wid,'raw_import',id);return row;}
export async function getImport(wid:string,pid:string,caseId:string,id:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId,true);const row=await importTx(tx,wid,caseId,id);if(row.mapping_id)row.mapping=(await tx.query('SELECT id,value,mapping_hash FROM faultline.mappings WHERE workspace_id=$1 AND import_id=$2 AND id=$3',[wid,id,row.mapping_id])).rows[0];return {...row,...(row.summary??{}),can_finalize:!row.snapshot_id&&!['queued','accepted'].includes(row.stage)&&row.summary?.can_finalize===true};});}
export async function discardImport(wid:string,pid:string,key:string,caseId:string,importId:string,match:string){
 return command(wid,pid,'import.discard',key,{caseId,importId,match},async tx=>{
  // Existing import commands review the current parent case resource revision.
  const reviewedCase=await getCaseTx(tx,wid,pid,caseId,true);expected(match,reviewedCase.revision);
  const record=await importTx(tx,wid,caseId,importId,true);
  const snapshot=!!(await tx.query('SELECT id FROM faultline.snapshots WHERE workspace_id=$1 AND case_id=$2 AND import_id=$3 LIMIT 1',[wid,caseId,importId])).rowCount;
  const activeJob=!!(await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND status IN('queued','running','waiting_for_input','cancel_requested') AND (id=$3::uuid OR input->>'import_id'=$4::text) LIMIT 1",[wid,caseId,record.job_id,importId])).rowCount;
  requireDiscardableImport(record,{snapshot,activeJob});
  await tx.query("UPDATE faultline.imports SET stage='discarded' WHERE workspace_id=$1 AND case_id=$2 AND id=$3",[wid,caseId,importId]);
  await audit(tx,wid,pid,'import.discard',{case_id:caseId,import_id:importId,raw_hash:record.raw_key,previous_stage:record.stage,logical_discard_only:true});
  return null;
 },['owner','analyst']);
}
export async function saveMapping(wid:string,pid:string,key:string,caseId:string,importId:string,value:MappingInput,match:string){
 return command(wid,pid,'import.mapping',key,{caseId,importId,value,match},async tx=>{
  const reviewedCase=await getCaseTx(tx,wid,pid,caseId,true);expected(match,reviewedCase.revision);const record=await importTx(tx,wid,caseId,importId,true);
  demand(!record.snapshot_id&&!['queued','accepted'].includes(record.stage),'IMPORT_IMMUTABLE','Queued or accepted imports require a new capture revision.',409);
  demand(value.kind==='canonical'?value.record_type===record.record_kind:value.kind===record.record_kind,'MAPPING_KIND','Mapping and record kind differ.');
  const id=newId(),mappingHash=hash({value,source_id:record.source_id});
  await tx.query('INSERT INTO faultline.mappings(id,workspace_id,case_id,import_id,value,mapping_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,wid,caseId,importId,value,mappingHash]);
  await tx.query("UPDATE faultline.imports SET mapping_id=$2,summary=NULL,normalized_key=NULL,stage='mapped' WHERE id=$1",[importId,id]);return {id,version:1,record_kind:record.record_kind,value,mapping_hash:mappingHash};
 },['owner','analyst'],async tx=>{await getCaseTx(tx,wid,pid,caseId,true);await importTx(tx,wid,caseId,importId);});
}
function analyticMapping(input:MappingInput,namespace:string|null):AnalyticsMapping{
 return {record_kind:'analytics',schema_version:1,...(namespace?{source_namespace:namespace}:{}),
 ...(input.kind==='canonical'?{}:{event_id:input.event_id_path,session_id:input.session_id_path,occurred_at:input.event_time_path,event_name:input.event_name_path,device:input.device_path,...(input.excluded_path?{excluded:input.excluded_path}:{excluded_default:false}),release_id:input.release_id_path,device_values:Object.fromEntries((input.device_map??[]).map(x=>[x.source_value,x.cohort]))})};
}
async function normalizeStored(wid:string,pid:string,caseId:string,importId:string,mappingId:string){
 const state=await transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId,true);const record=await importTx(tx,wid,caseId,importId);await sourceCaptureGuardTx(tx,wid,caseId,importId);const mapping=(await tx.query('SELECT * FROM faultline.mappings WHERE workspace_id=$1 AND case_id=$2 AND import_id=$3 AND id=$4',[wid,caseId,importId,mappingId])).rows[0];demand(mapping,'NOT_FOUND','Mapping unavailable.',404);const source=(await tx.query('SELECT * FROM faultline.sources WHERE workspace_id=$1 AND id=$2',[wid,record.source_id])).rows[0];return {record,mapping,source,policy:await policyTx(tx,wid)};});
 demand(!state.record.snapshot_id&&!['queued','accepted'].includes(state.record.stage),'IMPORT_IMMUTABLE','Queued or accepted imports cannot be previewed again.',409);
 const format=state.record.format;demand(['csv','json','jsonl','gzip_jsonl'].includes(format),'UNSUPPORTED_FORMAT','Use the supported bounded import formats.');
 const input=()=>objects.readStream(wid,state.record.raw_key),streamed=format!=='json';let bytes:Buffer|undefined;
 if(!streamed){const chunks:Buffer[]=[];for await(const chunk of input())chunks.push(chunk);bytes=Buffer.concat(chunks);chunks.length=0;}
 const namespace=state.source.namespace??(streamed?await sniffSourceNamespace(input(),format as 'csv'|'jsonl'|'gzip_jsonl'):bufferedJsonNamespace(bytes!));
 const limits={records:state.policy.value.max_records_per_snapshot};let result;
 if(state.record.record_kind==='analytics'){
  const mapping=analyticMapping(state.mapping.value,namespace);
  result=format==='csv'?await normalizeCsvStream(input(),state.record.source_id,mapping,{limits}):streamed?await normalizeJsonlStream(input(),state.record.source_id,mapping,{gzip:format==='gzip_jsonl',limits}):normalizeAnalytics(bytes!,'json',state.record.source_id,mapping,limits);
 }else{
  demand(['support','release'].includes(state.record.record_kind),'UNSUPPORTED_KIND','Structured evidence artifacts require their separate reviewed upload flow.');
  const mapping=state.mapping.value.kind==='canonical'?undefined:{record_kind:state.record.record_kind,schema_version:1 as const,id:state.mapping.value.record_id_path,text:state.mapping.value.text_path??state.mapping.value.description_path,...(state.mapping.value.event_time_path??state.mapping.value.published_at_path?{event_time:state.mapping.value.event_time_path??state.mapping.value.published_at_path}:{}),...(state.mapping.value.device_path?{device:state.mapping.value.device_path}:{}),...(state.record.record_kind==='release'&&state.mapping.value.commit_path?{provenance:state.mapping.value.commit_path}:{})};
  result=streamed?await normalizeEvidenceStream(input(),format==='csv'?'csv':'jsonl',state.record.record_kind,namespace??state.record.source_id,now(),mapping,{gzip:format==='gzip_jsonl',limits}):normalizeEvidenceRecords(bytes!,'json',state.record.record_kind,namespace??state.record.source_id,now(),mapping,limits);
 }
 return {...state,result,namespace};
}
export async function previewImport(wid:string,pid:string,key:string,caseId:string,importId:string,mappingId:string){
 const state=await normalizeStored(wid,pid,caseId,importId,mappingId);
 const parsedEvents='events' in state.result?state.result.events:null;const identity=parsedEvents?await transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId,true);return pseudonymizeTx(tx,wid,state.record.source_id,parsedEvents,true);}):null;
 const records=identity?identity.records:('events' in state.result?state.result.events:state.result.records);
 const normalizedBytes=canonicalArrayBytes(records),normalized=await storeBounded(wid,pid,caseId,Math.max(1,normalizedBytes.length),()=>objects.put(wid,normalizedBytes));
 return command(wid,pid,'import.preview',key,{caseId,importId,mappingId,raw_hash:state.record.raw_key},async tx=>{
  await getCaseTx(tx,wid,pid,caseId,true);const current=await importTx(tx,wid,caseId,importId,true);demand(!current.snapshot_id&&!['queued','accepted'].includes(current.stage),'IMPORT_IMMUTABLE','Import was queued or accepted during review.',409);
  demand(current.mapping_id===mappingId,'STALE_INPUTS','Mapping changed.',409);
  if(state.namespace&&state.result.canFinalize){const source=(await tx.query('SELECT namespace FROM faultline.sources WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[wid,current.source_id])).rows[0];demand(!source.namespace||source.namespace===state.namespace,'SOURCE_MISMATCH','Logical source namespace differs.');if(!source.namespace)await tx.query('UPDATE faultline.sources SET namespace=$3 WHERE workspace_id=$1 AND id=$2',[wid,current.source_id,state.namespace]);}
  const summary={identity_policy:identity?.policy??null,counts:state.result.counts,issues:state.result.issues,can_finalize:state.result.canFinalize,hashes:{...state.result.hashes,normalized:normalized.key},preview_rows:records.slice(0,10),declared_source_namespace:state.namespace,logical_source_id:state.record.source_id};
  await tx.query("UPDATE faultline.imports SET summary=$2,normalized_key=$3,stage=$4 WHERE id=$1",[importId,summary,normalized.key,state.result.canFinalize?'review_ready':'blocked']);
  return {id:importId,source_id:current.source_id,record_kind:current.record_kind,stage:state.result.canFinalize?'review_ready':'blocked',mapping_id:mappingId,...summary};
 });
}
export async function queueCommit(wid:string,pid:string,key:string,caseId:string,importId:string,input:{mapping_id:string;coverage_declaration:FaultlineCoverageDeclaration;accepted_issue_ids:string[]},match:string){
 validateContract('coverage-declaration',input.coverage_declaration);
 return command(wid,pid,'import.commit',key,{caseId,importId,...input,match},async tx=>{
  const investigation=await getCaseTx(tx,wid,pid,caseId,true),record=await importTx(tx,wid,caseId,importId,true);
  expected(match,investigation.revision);await sourceCaptureGuardTx(tx,wid,caseId,importId);
  demand(record.mapping_id===input.mapping_id&&record.stage==='review_ready'&&record.summary?.can_finalize,'IMPORT_BLOCKED','Review a valid mapping and resolve hard issues before accepting.');
  demand(record.summary.counts.input<=(await policyTx(tx,wid)).value.max_records_per_snapshot,'RECORD_LIMIT','Preview exceeds the current workspace record ceiling.',413);
  demand(input.accepted_issue_ids.length===0,'UNKNOWN_ISSUE','No rejected/conflicting row can be waived. Resolve hard issues in the mapping.');
  demand(!input.coverage_declaration.reference_evidence_ids.length,'UNKNOWN_CITATION','Coverage references require accepted evidence IDs.');
  const job=await enqueue(tx,wid,caseId,investigation.active_revision_id,'import_commit',{actor_id:pid,import_id:importId,mapping_id:input.mapping_id,coverage_declaration:input.coverage_declaration,normalized_key:record.normalized_key,raw_key:record.raw_key});
  await tx.query("UPDATE faultline.imports SET stage='queued',job_id=$2 WHERE id=$1",[importId,job.job_id]);return job;
 });
}
function derivedCoverage(declaration:FaultlineCoverageDeclaration):FaultlineCoverage{
 const intervals=[...declaration.event_time_intervals].sort((a,b)=>a.start.localeCompare(b.start));
 for(const item of intervals)demand(metadataMicros(item.start)<metadataMicros(item.end),'INVALID_COVERAGE','Coverage intervals must be positive.');
 return validateContract<FaultlineCoverage>('coverage',{extraction_status:'complete',basis:declaration.basis,covered_start:intervals[0]?.start??null,covered_end:intervals.map(x=>x.end).sort().at(-1)??null,event_watermark:declaration.declared_event_watermark,attestation:declaration.statement,event_time_intervals:intervals,assumptions:declaration.basis==='lateness_assumption'?['Operator assumes '+declaration.late_arrival_hours+' hours maximum lateness; not provider guaranteed.']:[]});
}
export async function commitHandler(job:{id:string;workspace_id:string;case_id:string;revision_id:string;fence:string;input:any}){
 const {workspace_id:wid,case_id:caseId,input}=job;
 await transaction(wid,tx=>importTx(tx,wid,caseId,input.import_id));
 const records=JSON.parse((await objects.read(wid,input.normalized_key)).toString('utf8')) as FaultlineCanonicalEvent[];
 return transaction(wid,async tx=>{
  const investigation=await getCaseTx(tx,wid,input.actor_id,caseId,true);demand(investigation.active_revision_id===job.revision_id,'STALE_INPUTS','Investigation changed before publication.',409);
  const leased=(await tx.query("SELECT id FROM faultline.jobs WHERE id=$1 AND workspace_id=$2 AND fence=$3 AND status='running' AND lease_until>now() FOR UPDATE",[job.id,wid,job.fence])).rows[0];demand(leased,'CANCELLED_OR_FENCED','The job cannot publish.',409);
  const record=await importTx(tx,wid,caseId,input.import_id);await sourceCaptureGuardTx(tx,wid,caseId,input.import_id);demand(record.mapping_id===input.mapping_id&&record.normalized_key===input.normalized_key,'STALE_INPUTS','Import inputs changed.',409);
  if(record.snapshot_id){const result={snapshot_id:record.snapshot_id};await finishJobTx(tx,wid,job.id,job.fence,'succeeded',result);return result;}
  demand(records.length<=(await policyTx(tx,wid)).value.max_records_per_snapshot,'RECORD_LIMIT','Snapshot exceeds the current workspace record ceiling.',413);
  const id=newId(),coverage=derivedCoverage(input.coverage_declaration),digest=snapshotRecordDigest({source_id:record.source_id,records,coverage,mapping_hash:record.summary.hashes.mapping,raw_hash:record.raw_key});
  const snapshot=validateContract<FaultlineSnapshot>('snapshot',{schema_version:1,id,workspace_id:wid,case_id:caseId,revision_id:job.revision_id,source_id:record.source_id,adapter_version:'file-import-v1',created_at:now(),content_hash:digest.content_hash,files:[{path:'canonical/'+input.normalized_key+'.json',sha256:input.normalized_key,size_bytes:digest.canonical_bytes,media_type:'application/json'}],coverage,record_count:records.length,source_mode:'file',evidence_ids:[]});
  await tx.query('INSERT INTO faultline.snapshots(id,workspace_id,case_id,source_id,import_id,value,object_key,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,wid,caseId,record.source_id,record.id,snapshot,input.normalized_key,snapshot.content_hash]);
  if(record.record_kind==='analytics')for(const event of records)validateContract('canonical-event',event);
  if(record.record_kind==='analytics')for(let offset=0;offset<records.length;offset+=1000)await tx.query('INSERT INTO faultline.canonical_events(workspace_id,case_id,snapshot_id,source_id,event_id,session_id,event_name,occurred_at,device,excluded,release_id) SELECT $1,$2,$3,$4,e.event_id,e.session_id,e.event_name,e.occurred_at::timestamptz,e.device,e.excluded,e.release_id FROM jsonb_to_recordset($5::jsonb) AS e(event_id text,session_id text,event_name text,occurred_at text,device text,excluded boolean,release_id text)',[wid,caseId,id,record.source_id,JSON.stringify(records.slice(offset,offset+1000))]);
  if(record.record_kind!=='analytics')for(const item of records as any[]){
   const evidenceId=newId(),evidence=validateContract<FaultlineEvidence>('evidence',{schema_version:1,id:evidenceId,workspace_id:wid,case_id:caseId,revision_id:job.revision_id,snapshot_id:id,source_kind:record.record_kind,source_ref:'import:'+record.id+':'+item.id,content_hash:hash(item),event_time:item.event_time,captured_at:item.captured_at??now(),text:item.text,redaction_status:'restricted',evidence_status:'user_attested',supersedes_id:null,artifact_refs:[]});
   await tx.query('INSERT INTO faultline.evidence(id,workspace_id,case_id,value,redaction_status) VALUES($1,$2,$3,$4,$5)',[evidenceId,wid,caseId,evidence,'restricted']);
  }
  await tx.query("UPDATE faultline.imports SET stage='accepted',snapshot_id=$2 WHERE id=$1",[record.id,id]);await audit(tx,wid,input.actor_id,'snapshot.accept',{case_id:caseId,snapshot_id:id,content_hash:snapshot.content_hash});const published={snapshot_id:id,content_hash:snapshot.content_hash};await finishJobTx(tx,wid,job.id,job.fence,'succeeded',published);return published;
 });
}
export async function listSnapshots(wid:string,pid:string,caseId:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId);const rows=(await tx.query('SELECT s.id,s.value,s.withdrawn,i.record_kind FROM faultline.snapshots s JOIN faultline.imports i ON i.workspace_id=s.workspace_id AND i.case_id=s.case_id AND i.id=s.import_id WHERE s.workspace_id=$1 AND s.case_id=$2 ORDER BY s.created_at,s.id',[wid,caseId])).rows;const output=[];for(const r of rows){let expired=false;try{await assertResourceRetainedTx(tx,wid,'snapshot',r.id);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='RETENTION_EXPIRED')expired=true;else throw error;}output.push({...r.value,withdrawn:r.withdrawn||expired,retention_expired:expired,record_kind:r.record_kind});}return output;});}
export async function snapshotTx(tx:Tx,wid:string,caseId:string,id:string){const row=(await tx.query("SELECT s.*,i.raw_key AS accepted_raw_hash,i.summary->'hashes'->>'mapping' AS accepted_mapping_hash FROM faultline.snapshots s JOIN faultline.imports i ON i.workspace_id=s.workspace_id AND i.case_id=s.case_id AND i.id=s.import_id AND i.snapshot_id=s.id AND i.stage='accepted' WHERE s.workspace_id=$1 AND s.case_id=$2 AND s.id=$3",[wid,caseId,id])).rows[0];demand(row&&!row.withdrawn,'SNAPSHOT_UNAVAILABLE','Snapshot unavailable or withdrawn.',409);await assertResourceRetainedTx(tx,wid,'snapshot',id);validateContract('snapshot',row.value);demand(row.value.id===row.id&&row.value.workspace_id===wid&&row.value.case_id===caseId&&row.value.source_id===row.source_id&&row.value.content_hash===row.content_hash,'ARTIFACT_CORRUPT','Snapshot row and immutable manifest differ.',409);await verifySnapshotBytes(wid,row.value,row.object_key,objects,{source_id:row.source_id,coverage:row.value.coverage,mapping_hash:row.accepted_mapping_hash,raw_hash:row.accepted_raw_hash,content_hash:row.content_hash});return row;}
export async function selectSnapshots(wid:string,pid:string,key:string,caseId:string,input:{snapshot_ids:string[];reason:string},match:string){
 return command(wid,pid,'snapshot.select',key,{caseId,input,match},async tx=>{
  const item=await getCaseTx(tx,wid,pid,caseId,true);expected(match,item.revision);
  demand(input.snapshot_ids.length<=100&&new Set(input.snapshot_ids).size===input.snapshot_ids.length,'INVALID_SELECTION','Select at most100 distinct snapshots.');demand(input.reason.trim().length>0,'INVALID_SELECTION','Explain this snapshot selection.');
  const selected=[];for(const id of [...input.snapshot_ids].sort()){const row=await snapshotTx(tx,wid,caseId,id);selected.push({id:row.id,content_hash:row.content_hash,source_id:row.source_id});}
  const value={title:item.title,question:item.question,affected_flow:item.affected_flow,selected_snapshots:selected,snapshot_bundle_hash:hash(selected),selection_reason:input.reason},revisionId=newId();
  await tx.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,parent_id,value,content_hash) VALUES($1,$2,$3,$4,$5,$6)',[revisionId,wid,caseId,item.active_revision_id,value,hash(value)]);
  await tx.query('UPDATE faultline.cases SET active_revision_id=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[wid,caseId,revisionId]);
  await audit(tx,wid,pid,'snapshot.select',{case_id:caseId,revision_id:revisionId,parent_id:item.active_revision_id,snapshot_bundle_hash:value.snapshot_bundle_hash,snapshot_ids:selected.map(x=>x.id)});
  return {revision_id:revisionId,parent_id:item.active_revision_id,revision:item.revision+1,...value,metric_status:'requires_freeze'};
 });
}
export async function snapshotQuality(wid:string,pid:string,caseId:string,id:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId);return (await snapshotTx(tx,wid,caseId,id)).value.coverage;});}
export async function createMetric(wid:string,pid:string,key:string,caseId:string,value:FaultlineMetric){
 validateMetric(value);
 return command(wid,pid,'metric.create',key,{caseId,value},async tx=>{await getCaseTx(tx,wid,pid,caseId,true);demand((await tx.query('SELECT id FROM faultline.sources WHERE workspace_id=$1 AND id=$2',[wid,value.source_id])).rowCount,'NOT_FOUND','Metric source unavailable.',404);const id=newId(),metric_hash=hash(value);await tx.query("INSERT INTO faultline.metric_versions(id,workspace_id,case_id,value,metric_hash,state) VALUES($1,$2,$3,$4,$5,'draft')",[id,wid,caseId,value,metric_hash]);return {id,value,metric_hash,state:'draft'};});
}
export async function listMetrics(wid:string,pid:string,caseId:string){return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId);return (await tx.query('SELECT * FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 ORDER BY created_at,id',[wid,caseId])).rows;});}
export async function freezeMetric(wid:string,pid:string,key:string,caseId:string,metricId:string,input:{snapshot_id:string;metric_hash:string;acknowledged_assumptions:string[]},match:string){
 return command(wid,pid,'metric.freeze',key,{caseId,metricId,input,match},async tx=>{
  const investigation=await getCaseTx(tx,wid,pid,caseId,true);expected(match,investigation.revision);
  const metric=(await tx.query('SELECT * FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE',[wid,caseId,metricId])).rows[0];demand(metric&&metric.state==='draft'&&metric.metric_hash===input.metric_hash,'STALE_INPUTS','Metric draft/hash changed.',409);
  const snapshot=await snapshotTx(tx,wid,caseId,input.snapshot_id);const origin=(await tx.query('SELECT record_kind FROM faultline.imports WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,snapshot.import_id])).rows[0];demand(origin.record_kind==='analytics','WRONG_RECORD_KIND','Metrics require an analytics snapshot.');demand(metric.value.source_id===snapshot.source_id,'SOURCE_MISMATCH','Metric and snapshot source differ.');
  const quality=assessCoverage(metric.value,snapshot.value.coverage);demand(quality.quality!=='incomplete','INCOMPLETE_COVERAGE','Coverage/observation tail is incomplete.');
  for(const assumption of snapshot.value.coverage.assumptions??[])demand(input.acknowledged_assumptions.includes(assumption),'ASSUMPTION_REVIEW','Acknowledge each explicit source assumption.');
  const parent=(await tx.query('SELECT value FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,investigation.active_revision_id])).rows[0]?.value;demand(!parent?.selected_snapshots||parent.selected_snapshots.some((s:any)=>s.id===snapshot.id&&s.content_hash===snapshot.content_hash),'SNAPSHOT_NOT_SELECTED','Select this snapshot in the current bundle before freezing.',409);const revisionId=newId(),value={...(parent?.selected_snapshots?{selected_snapshots:parent.selected_snapshots,snapshot_bundle_hash:parent.snapshot_bundle_hash,selection_reason:parent.selection_reason}:{}),title:investigation.title,question:investigation.question,affected_flow:investigation.affected_flow,metric_id:metricId,metric_hash:metric.metric_hash,snapshot_id:snapshot.id,snapshot_hash:snapshot.content_hash};
  await tx.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,parent_id,value,content_hash) VALUES($1,$2,$3,$4,$5,$6)',[revisionId,wid,caseId,investigation.active_revision_id,value,hash(value)]);
  await tx.query('UPDATE faultline.cases SET active_revision_id=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[wid,caseId,revisionId]);await tx.query("UPDATE faultline.metric_versions SET state='frozen',snapshot_id=$2,revision_id=$3,acknowledged_assumptions=$4 WHERE id=$1",[metricId,snapshot.id,revisionId,input.acknowledged_assumptions]);
  await audit(tx,wid,pid,'metric.freeze',{case_id:caseId,revision_id:revisionId,metric_hash:metric.metric_hash,snapshot_hash:snapshot.content_hash});return {id:metricId,state:'frozen',revision_id:revisionId,metric_hash:metric.metric_hash,snapshot_id:snapshot.id};
 });
}
export async function queueComparison(wid:string,pid:string,key:string,caseId:string,revisionId:string){return command(wid,pid,'comparison.compute',key,{caseId,revisionId},async tx=>{
 const investigation=await getCaseTx(tx,wid,pid,caseId,true);demand(investigation.active_revision_id===revisionId,'STALE_INPUTS','Revision is not current.',409);
 const revision=(await tx.query('SELECT value FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,revisionId])).rows[0];demand(revision.value.metric_id&&revision.value.snapshot_id,'INPUTS_REQUIRED','Freeze a metric and snapshot first.');
 return enqueue(tx,wid,caseId,revisionId,'comparison_compute',{actor_id:pid,...revision.value});
});}
export async function eventRows(tx:Tx,wid:string,caseId:string,snapshotId:string):Promise<FaultlineCanonicalEvent[]>{await assertResourceRetainedTx(tx,wid,'snapshot',snapshotId);return (await tx.query("SELECT source_id::text,event_id,session_id,event_name,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS occurred_at,device,excluded,release_id FROM faultline.canonical_events WHERE workspace_id=$1 AND case_id=$2 AND snapshot_id=$3 ORDER BY occurred_at,event_id",[wid,caseId,snapshotId])).rows;}
export async function comparisonHandler(job:{id:string;workspace_id:string;case_id:string;revision_id:string;fence:string;input:any}){
 const {workspace_id:wid,case_id:caseId,input}=job;
 const data=await transaction(wid,async tx=>{await getCaseTx(tx,wid,input.actor_id,caseId,true);const metric=(await tx.query('SELECT * FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,input.metric_id])).rows[0],snapshot=await snapshotTx(tx,wid,caseId,input.snapshot_id);demand(metric?.state==='frozen'&&metric.metric_hash===input.metric_hash&&snapshot.content_hash===input.snapshot_hash,'STALE_INPUTS','Frozen inputs differ.',409);demand(metric.value.source_id===snapshot.source_id,'SOURCE_MISMATCH','Frozen metric source differs from its snapshot.',409);return {metric,snapshot,result:await computePostgresComparison(tx,wid,caseId,snapshot.id,metric.value,snapshot.value.coverage)};});
 const result=data.result,mix=computeMixShift(result);
 return transaction(wid,async tx=>{
  await access(tx,wid,input.actor_id,['owner','analyst']);const investigation=await getCaseTx(tx,wid,input.actor_id,caseId);demand(!investigation.archived&&investigation.lifecycle==='open','CASE_INACTIVE','Reopen this investigation before computing.',409);demand(investigation.active_revision_id===job.revision_id,'STALE_INPUTS','Case inputs changed before result publication.',409);
  demand((await tx.query("SELECT id FROM faultline.jobs WHERE id=$1 AND workspace_id=$2 AND fence=$3 AND status='running' AND lease_until>now() FOR UPDATE",[job.id,wid,job.fence])).rowCount,'CANCELLED_OR_FENCED','Attempt cannot publish.',409);
  const currentSnapshot=await snapshotTx(tx,wid,caseId,input.snapshot_id);demand(currentSnapshot.content_hash===input.snapshot_hash,'STALE_INPUTS','Snapshot dependency changed.',409);
  const currentMetric=(await tx.query('SELECT state,metric_hash FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,input.metric_id])).rows[0];demand(currentMetric?.state==='frozen'&&currentMetric.metric_hash===input.metric_hash,'STALE_INPUTS','Frozen metric dependency changed.',409);
  const prior=(await tx.query('SELECT id FROM faultline.comparisons WHERE job_id=$1',[job.id])).rows[0];if(prior){const published={comparison_id:prior.id};await finishJobTx(tx,wid,job.id,job.fence,'succeeded',published);return published;}
  const id=newId();await tx.query('INSERT INTO faultline.comparisons(id,workspace_id,case_id,revision_id,metric_hash,snapshot_hash,value,mix,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,wid,caseId,job.revision_id,input.metric_hash,input.snapshot_hash,result,mix,job.id]);
  const evidenceId=newId(),text=comparisonEvidenceSummary(result,mix);
  const evidence=validateContract<FaultlineEvidence>('evidence',{schema_version:1,id:evidenceId,workspace_id:wid,case_id:caseId,revision_id:job.revision_id,snapshot_id:input.snapshot_id,source_kind:'analytics',source_ref:'comparison:'+id,content_hash:hash({result,mix}),event_time:{kind:'range',start:data.metric.value.windows.baseline.start.replace('Z','000Z'),end:data.metric.value.windows.comparison.end.replace('Z','000Z')},captured_at:now(),text,redaction_status:'sanitized',evidence_status:'observed',supersedes_id:null,artifact_refs:[]});
  await tx.query('INSERT INTO faultline.evidence(id,workspace_id,case_id,value,redaction_status) VALUES($1,$2,$3,$4,$5)',[evidenceId,wid,caseId,evidence,'sanitized']);const published={comparison_id:id,evidence_id:evidenceId};await finishJobTx(tx,wid,job.id,job.fence,'succeeded',published);return published;
 });
}
export async function getComparison(wid:string,pid:string,caseId:string,id:string){return transaction(wid,async tx=>{
 const investigation=await getCaseTx(tx,wid,pid,caseId),row=(await tx.query('SELECT * FROM faultline.comparisons WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,id])).rows[0];demand(row,'NOT_FOUND','Comparison unavailable.',404);
 const dependency=(await tx.query("SELECT s.id FROM faultline.snapshots s JOIN faultline.jobs j ON j.workspace_id=s.workspace_id AND j.case_id=s.case_id AND j.input->>'snapshot_id'=s.id::text WHERE j.id=$4 AND j.status='succeeded' AND s.workspace_id=$1 AND s.case_id=$2 AND s.content_hash=$3 AND NOT s.withdrawn",[wid,caseId,row.snapshot_hash,row.job_id])).rows[0];
 if(dependency)await snapshotTx(tx,wid,caseId,dependency.id);
 return {...row,freshness:row.revision_id===investigation.active_revision_id&&dependency?'fresh':'stale'};
});}

export async function metricPreview(wid:string,pid:string,caseId:string,metricId:string,snapshotId:string){
 return transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId,true);const metric=(await tx.query('SELECT value FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,metricId])).rows[0];demand(metric,'NOT_FOUND','Metric unavailable.',404);const snapshot=await snapshotTx(tx,wid,caseId,snapshotId);demand(snapshot.source_id===metric.value.source_id,'SOURCE_MISMATCH','Metric and snapshot source differ.');return {preview:previewComparison(await eventRows(tx,wid,caseId,snapshotId),metric.value),quality:assessCoverage(metric.value,snapshot.value.coverage),coverage:snapshot.value.coverage};});
}
