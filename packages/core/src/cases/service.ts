import {decodeCursor,encodeCursor} from './cursor.js';
import {transaction,type Tx} from '../../../database/src/client.js';
import {newId,hash} from '../canonical.js';
import {access,audit,command,expected} from '../workspaces/service.js';
import {demand} from '../errors.js';
export type CaseInput={title:string;question:string;affected_flow?:string|null};
export async function getCaseTx(tx:Tx,wid:string,pid:string,id:string,write=false,allowInactive=false){
 if(!write){
  const row=(await tx.query("SELECT c.* FROM faultline.cases c JOIN faultline.memberships m ON m.workspace_id=c.workspace_id JOIN faultline.workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=$1 AND c.id=$3 AND m.user_id=$2 AND m.role IN('owner','analyst','viewer') AND w.deletion_requested_at IS NULL FOR SHARE OF m",[wid,pid,id])).rows[0];
  demand(row&&!row.deletion_requested_at,'NOT_FOUND','Investigation unavailable.',404);return row;
 }
 await access(tx,wid,pid,write?['owner','analyst']:['owner','analyst','viewer']);
 const row=(await tx.query('SELECT * FROM faultline.cases WHERE workspace_id=$1 AND id=$2'+(write?' FOR UPDATE':''),[wid,id])).rows[0];
 demand(row&&!row.deletion_requested_at,'NOT_FOUND','Investigation unavailable.',404);if(write&&!allowInactive)demand(!row.archived&&row.lifecycle==='open','CASE_INACTIVE','Reopen or restore this investigation before changing its inputs.',409);return row;
}
export async function createCase(wid:string,pid:string,key:string,input:CaseInput){
 return command(wid,pid,'case.create',key,input,async tx=>{
  await access(tx,wid,pid,['owner','analyst']);const id=newId(),revisionId=newId();
  const row=(await tx.query('INSERT INTO faultline.cases(id,workspace_id,title,question,affected_flow,active_revision_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,wid,input.title,input.question,input.affected_flow??null,revisionId])).rows[0];
  const value={title:input.title,question:input.question,affected_flow:input.affected_flow??null};
  await tx.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,value,content_hash) VALUES($1,$2,$3,$4,$5)',[revisionId,wid,id,value,hash(value)]);
  await audit(tx,wid,pid,'case.create',{case_id:id,revision_id:revisionId});return row;
 });
}
export async function getCase(wid:string,pid:string,id:string){return transaction(wid,async tx=>{const item=await getCaseTx(tx,wid,pid,id),revision=(await tx.query('SELECT value FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,id,item.active_revision_id])).rows[0]?.value,demo=(await tx.query('SELECT fixture AS demo_fixture,fixture_version AS demo_fixture_version,generation AS demo_generation FROM faultline.demo_cases WHERE workspace_id=$1 AND case_id=$2',[wid,id])).rows[0];return {...item,...(demo??{}),snapshot_selection:revision?.selected_snapshots?{selected_snapshots:revision.selected_snapshots,snapshot_bundle_hash:revision.snapshot_bundle_hash,selection_reason:revision.selection_reason,revision_id:item.active_revision_id}:null};});}
export async function listCases(wid:string,pid:string,query:{q?:string;archived?:string;lifecycle?:string;cursor?:string;limit?:number}){
 return transaction(wid,async tx=>{
  await access(tx,wid,pid);const limit=query.limit??50;demand(Number.isInteger(limit)&&limit>0&&limit<=200,'INVALID_LIMIT','Limit must be 1..200.',400);
  const scope={wid,pid,q:query.q??'',archived:query.archived==='true',lifecycle:query.lifecycle??null},position=decodeCursor(query.cursor,scope);
  const rows=(await tx.query("SELECT c.*,d.fixture AS demo_fixture,d.fixture_version AS demo_fixture_version,d.generation AS demo_generation FROM faultline.cases c LEFT JOIN faultline.demo_cases d ON d.workspace_id=c.workspace_id AND d.case_id=c.id WHERE c.workspace_id=$1 AND c.deletion_requested_at IS NULL AND c.archived=$2 AND ($3='' OR c.title ILIKE '%'||$3||'%' OR c.question ILIKE '%'||$3||'%') AND ($4::text IS NULL OR c.lifecycle=$4) AND ($5::timestamptz IS NULL OR (c.created_at,c.id)>($5::timestamptz,$6::uuid)) ORDER BY c.created_at,c.id LIMIT $7",[wid,scope.archived,scope.q,scope.lifecycle,position?.created_at??null,position?.id??null,limit+1])).rows;
  const visible=rows.slice(0,limit),last=visible.at(-1);return {data:visible,page:{next_cursor:rows.length>limit&&last?encodeCursor(scope,{created_at:last.created_at,id:last.id}):null}};
 });
}
export async function updateCase(wid:string,pid:string,key:string,id:string,input:Partial<CaseInput>,match:string){
 return command(wid,pid,'case.update',key,{id,input,match},async tx=>{
  const old=await getCaseTx(tx,wid,pid,id,true);expected(match,old.revision);
  const value={title:input.title??old.title,question:input.question??old.question,affected_flow:input.affected_flow===undefined?old.affected_flow:input.affected_flow},revisionId=newId();
  await tx.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,parent_id,value,content_hash) VALUES($1,$2,$3,$4,$5,$6)',[revisionId,wid,id,old.active_revision_id,value,hash(value)]);
  const row=(await tx.query('UPDATE faultline.cases SET title=$3,question=$4,affected_flow=$5,active_revision_id=$6,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *',[wid,id,value.title,value.question,value.affected_flow,revisionId])).rows[0];
  await audit(tx,wid,pid,'case.revise',{case_id:id,revision_id:revisionId,parent_id:old.active_revision_id});return row;
 });
}
export async function archiveCase(wid:string,pid:string,key:string,id:string,archived:boolean,match:string){
 return command(wid,pid,'case.archive',key,{id,archived,match},async tx=>{
  const old=await getCaseTx(tx,wid,pid,id,true,true);expected(match,old.revision);
  const active=await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND status IN('queued','running','cancel_requested')",[wid,id]);
  demand(active.rowCount===0,'ACTIVE_WORK','Cancel active work before archiving.',409);
  const row=(await tx.query('UPDATE faultline.cases SET archived=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *',[wid,id,archived])).rows[0];
  await audit(tx,wid,pid,'case.archive',{case_id:id,archived});return row;
 });
}


export async function disposition(wid:string,pid:string,key:string,id:string,input:{disposition?:'resolved'|'unresolved'|'no_issue';note:string},match:string,reopen=false){
 return command(wid,pid,reopen?'case.reopen':'case.close',key,{id,input,match},async tx=>{const old=await getCaseTx(tx,wid,pid,id,true,true);expected(match,old.revision);demand(!old.archived,'CASE_ARCHIVED','Restore this case before changing its disposition.',409);
  demand(old.lifecycle===(reopen?'closed':'open'),'INVALID_CASE_STATE','Case state changed.',409);
  demand(!(await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND status IN('queued','running','cancel_requested')",[wid,id])).rowCount,'ACTIVE_WORK','Finish or cancel active work first.',409);
  const row=(await tx.query('UPDATE faultline.cases SET lifecycle=$3,disposition=$4,disposition_note=$5,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *',[wid,id,reopen?'open':'closed',reopen?null:input.disposition,input.note])).rows[0];
  await audit(tx,wid,pid,reopen?'case.reopen':'case.close',{case_id:id,disposition:row.disposition,note:input.note,active_revision_preserved:old.active_revision_id});return row;
 });
}
