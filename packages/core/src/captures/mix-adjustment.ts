import {transaction,type Tx} from '../../../database/src/client.js';
import {getCaseTx} from '../cases/service.js';
import {command,audit,access} from '../workspaces/service.js';
import {enqueue,finishJobTx} from '../jobs/service.js';
import {snapshotTx} from './service.js';
import {computeMixShift} from '../metrics/comparison.js';
import {hash} from '../canonical.js';
import {demand} from '../errors.js';

export type MixAdjustmentInput={standard_population:'baseline'};
type MixBinding={comparison_revision_id:string;current_revision_id:string;comparison_metric_hash:string;current_metric_hash:string;comparison_snapshot_hash:string;current_snapshot_hash:string;source_job_status:string};
export function requireCurrentMixBinding(binding:MixBinding) {
 demand(binding.comparison_revision_id===binding.current_revision_id&&binding.comparison_metric_hash===binding.current_metric_hash&&binding.comparison_snapshot_hash===binding.current_snapshot_hash&&binding.source_job_status==='succeeded','STALE_INPUTS','Mix adjustment requires the current frozen comparison and succeeded source computation.',409);
}
export function baselineAdjustment(value:unknown,input:MixAdjustmentInput) {
 demand(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1&&input.standard_population==='baseline','INVALID_POPULATION','Only the baseline standard population is supported.',400);
 return computeMixShift(value);
}
async function currentComparisonTx(tx:Tx,wid:string,pid:string,cid:string,id:string) {
 const investigation=await getCaseTx(tx,wid,pid,cid,true),row=(await tx.query('SELECT * FROM faultline.comparisons WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,id])).rows[0];
 demand(row,'NOT_FOUND','Comparison unavailable.',404);
 const revision=(await tx.query('SELECT value FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,investigation.active_revision_id])).rows[0];
 const sourceJob=(await tx.query('SELECT status,input,input_hash,kind,revision_id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,row.job_id])).rows[0];
 requireCurrentMixBinding({comparison_revision_id:row.revision_id,current_revision_id:investigation.active_revision_id,comparison_metric_hash:row.metric_hash,current_metric_hash:revision?.value.metric_hash,comparison_snapshot_hash:row.snapshot_hash,current_snapshot_hash:revision?.value.snapshot_hash,source_job_status:sourceJob?.status});
 const snapshot=await snapshotTx(tx,wid,cid,revision.value.snapshot_id),metric=(await tx.query('SELECT state,metric_hash,value FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,revision.value.metric_id])).rows[0];
 demand(snapshot.content_hash===row.snapshot_hash&&metric?.state==='frozen'&&metric.metric_hash===row.metric_hash&&row.value.metric_hash===row.metric_hash&&sourceJob.kind==='comparison_compute'&&sourceJob.revision_id===row.revision_id&&sourceJob.input_hash===hash(sourceJob.input)&&sourceJob.input.snapshot_id===snapshot.id&&sourceJob.input.snapshot_hash===row.snapshot_hash&&sourceJob.input.metric_hash===row.metric_hash,'STALE_INPUTS','Frozen comparison dependencies differ.',409);
 demand(metric.value.source_id===snapshot.source_id,'SOURCE_MISMATCH','Frozen comparison source differs from its snapshot.',409);
 return {row,revision_id:investigation.active_revision_id,comparison_hash:hash({id:row.id,revision_id:row.revision_id,metric_hash:row.metric_hash,snapshot_hash:row.snapshot_hash,job_id:row.job_id,value:row.value,mix:row.mix})};
}
export async function queueMixAdjustment(wid:string,pid:string,key:string,cid:string,comparisonId:string,input:MixAdjustmentInput) {
 // Validate the exact finite body before doing any work or consuming an allowance.
 demand(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1&&input.standard_population==='baseline','INVALID_POPULATION','Only the baseline standard population is supported.',400);
 return command(wid,pid,'comparison.mix.adjust',key,{cid,comparisonId,input},async tx=>{
  const bound=await currentComparisonTx(tx,wid,pid,cid,comparisonId),mix=baselineAdjustment(bound.row.value,input);
  demand(hash(mix)===hash(bound.row.mix),'COMPARISON_CORRUPT','Stored mix differs from deterministic baseline accounting.',409);
  return enqueue(tx,wid,cid,bound.revision_id,'mix_adjustment',{actor_id:pid,comparison_id:comparisonId,standard_population:'baseline',comparison_hash:bound.comparison_hash});
 },['owner','analyst'],async(tx,_result,replayed)=>{if(replayed)await currentComparisonTx(tx,wid,pid,cid,comparisonId);});
}
export async function mixAdjustmentHandler(job:{id:string;workspace_id:string;case_id:string;revision_id:string;fence:string;input:{actor_id:string;comparison_id:string;standard_population:'baseline';comparison_hash:string}}) {
 const {workspace_id:wid,case_id:cid,input}=job;
 const bound=await transaction(wid,async tx=>{
  await access(tx,wid,input.actor_id,['owner','analyst']);const current=await currentComparisonTx(tx,wid,input.actor_id,cid,input.comparison_id);
  demand(current.revision_id===job.revision_id&&current.comparison_hash===input.comparison_hash,'STALE_INPUTS','Queued comparison binding changed.',409);return current;
 });
 const mix=baselineAdjustment(bound.row.value,{standard_population:input.standard_population});
 demand(hash(mix)===hash(bound.row.mix),'COMPARISON_CORRUPT','Stored mix differs from deterministic baseline accounting.',409);
 return transaction(wid,async tx=>{
  await access(tx,wid,input.actor_id,['owner','analyst']);const current=await currentComparisonTx(tx,wid,input.actor_id,cid,input.comparison_id);
  demand(current.revision_id===job.revision_id&&current.comparison_hash===input.comparison_hash,'STALE_INPUTS','Comparison dependencies changed before publication.',409);
  demand((await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3 AND id=$4 AND fence=$5 AND input_hash=$6 AND status='running' AND lease_until>now() FOR UPDATE",[wid,cid,job.revision_id,job.id,job.fence,hash(input)])).rowCount,'CANCELLED_OR_FENCED','Attempt cannot publish.',409);
  const result={comparison_id:input.comparison_id,standard_population:'baseline' as const,mix,comparison_hash:input.comparison_hash,scope:'observed_association' as const,aggregate_causal_effect:'not_established' as const};
  await audit(tx,wid,input.actor_id,'comparison.mix.adjust',{case_id:cid,comparison_id:input.comparison_id,revision_id:job.revision_id,job_id:job.id,standard_population:'baseline',mix_status:mix.status,aggregate_causal_effect:'not_established'});
  await finishJobTx(tx,wid,job.id,job.fence,'succeeded',result);return result;
 });
}
