import {transaction,type Tx} from '../../../database/src/client.js';
import {getCaseTx} from '../cases/service.js';
import {encodeCursor,decodeCursor} from '../cases/cursor.js';
import {snapshotTx} from '../captures/service.js';
import {evidenceTx} from '../investigation/service.js';
import {access} from '../workspaces/service.js';
import {demand} from '../errors.js';
import {projectTimeline,type TimelineCapture,type TimelineWindow} from './timeline.js';
import type {FaultlineEvidence} from '../../../contracts/src/generated.js';

/** Only the immutable selected bundle establishes which captures were reviewed. */
export async function sourceCoverageTx(tx:Tx,wid:string,cid:string,revision:any,window:TimelineWindow){
 const selected=revision.value.selected_snapshots??(revision.value.snapshot_id?[{id:revision.value.snapshot_id,content_hash:revision.value.snapshot_hash}]:[]);
 demand(Array.isArray(selected)&&selected.length<=100,'TIMELINE_LIMIT','Select at most100 snapshots.',409);
 const captures:TimelineCapture[]=[];
 for(const item of selected){
  const snapshot=await snapshotTx(tx,wid,cid,item.id);
  demand(snapshot.content_hash===item.content_hash,'STALE_INPUTS','Selected capture content differs.',409);
  const origin=(await tx.query('SELECT record_kind FROM faultline.imports WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,snapshot.import_id])).rows[0];
  demand(origin&&['analytics','support','release'].includes(origin.record_kind),'WRONG_RECORD_KIND','Timeline requires a supported accepted capture.',409);
  captures.push({id:snapshot.id,source_id:snapshot.source_id,content_hash:snapshot.content_hash,source_kind:origin.record_kind,coverage:snapshot.value.coverage});
 }
 return {captures,projection:projectTimeline({window,captures,evidence:[]})};
}
export async function getTimeline(wid:string,pid:string,cid:string,query:{from?:string;to?:string;source_kind?:string;cursor?:string;limit?:number}){
 return transaction(wid,async tx=>{
  const investigation=await getCaseTx(tx,wid,pid,cid),role=await access(tx,wid,pid);
  const revision=(await tx.query('SELECT id,value FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,investigation.active_revision_id])).rows[0];
  const metric=revision.value.metric_id?(await tx.query('SELECT value FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,revision.value.metric_id])).rows[0]?.value:null;
  demand((query.from===undefined)===(query.to===undefined),'TIMELINE_INTERVAL','Supply both from and to.',400);
  const window={start:query.from??metric?.windows.baseline.start,end:query.to??metric?.windows.comparison.end};
  demand(typeof window.start==='string'&&typeof window.end==='string','INPUTS_REQUIRED','Choose a timeline interval or freeze metric windows.',409);
  const limit=query.limit??50;demand(Number.isInteger(limit)&&limit>0&&limit<=100,'INVALID_LIMIT','Limit must be1..100.',400);
  demand(!query.source_kind||['analytics','support','release','deployment','test','human_note'].includes(query.source_kind),'TIMELINE_SOURCE','Choose a declared evidence source kind.',400);
  const {captures}=await sourceCoverageTx(tx,wid,cid,revision,window);
  const scope={wid,pid,cid,revision:revision.id,window,source_kind:query.source_kind??null,role},position=decodeCursor(query.cursor,scope);
  const rows=(await tx.query(`SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM faultline.evidence
   WHERE workspace_id=$1 AND case_id=$2 AND redaction_status<>'withdrawn' AND ($3::boolean=false OR redaction_status='sanitized')
   AND ($4::text IS NULL OR value->>'source_kind'=$4)
   AND (value->>'snapshot_id' IS NULL OR value->>'snapshot_id'=ANY($5::text[]))
   AND (value->'event_time'->>'kind'='unknown'
    OR (value->'event_time'->>'kind'='exact' AND (value->'event_time'->>'at')::timestamptz >=$6::timestamptz AND (value->'event_time'->>'at')::timestamptz <$7::timestamptz)
    OR (value->'event_time'->>'kind'='range' AND (value->'event_time'->>'start')::timestamptz <$7::timestamptz AND (value->'event_time'->>'end')::timestamptz >$6::timestamptz))
   AND ($8::timestamptz IS NULL OR (created_at,id)>($8::timestamptz,$9::uuid)) ORDER BY created_at,id LIMIT $10`,
   [wid,cid,role==='viewer',query.source_kind??null,captures.map(c=>c.id),window.start,window.end,position?.created_at??null,position?.id??null,limit+1])).rows;
  const page=rows.slice(0,limit),last=page.at(-1),evidence=await evidenceTx(tx,wid,cid,page.map(row=>row.id),role==='viewer');
  const comparison=(await tx.query("SELECT c.value FROM faultline.comparisons c WHERE c.workspace_id=$1 AND c.case_id=$2 AND c.revision_id=$3 AND EXISTS(SELECT 1 FROM faultline.jobs j WHERE j.workspace_id=c.workspace_id AND j.case_id=c.case_id AND j.id=c.job_id AND j.status='succeeded') ORDER BY c.created_at DESC,c.id LIMIT 1",[wid,cid,revision.id])).rows[0];
  return {...projectTimeline({window,captures,evidence,source_kind:query.source_kind as FaultlineEvidence['source_kind']|undefined}),revision_id:revision.id,
   metric_windows:metric?.windows??null,metric_cohorts:metric?.cohorts??[],metric_summary:comparison?.value??null,affected_flow:investigation.affected_flow,
   page:{next_cursor:rows.length>limit&&last?encodeCursor(scope,last):null},
   association_limit:'Temporal overlap does not establish a cohort link or aggregate causal effect.'};
 });
}
