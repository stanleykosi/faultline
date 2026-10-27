import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {currentSanitizedEvidenceIdsTx} from '../../packages/core/src/investigation/service.js';

const connectionString=process.env.MIGRATION_DATABASE_URL;
const integration=connectionString?test:test.skip;

function evidence(id:string,wid:string,cid:string,rid:string,source_kind:'federated_query'|'human_note',supersedes_id:string|null){
 return {schema_version:1,id,workspace_id:wid,case_id:cid,revision_id:rid,snapshot_id:null,source_kind,source_ref:'generated acceptance',content_hash:'e'.repeat(64),event_time:{kind:'unknown',raw_description:'generated'},captured_at:'2026-10-21T12:00:00.000Z',text:'Generated reviewed evidence.',redaction_status:'sanitized',evidence_status:'observed',supersedes_id,artifact_refs:[]};
}

integration('current model context admits only reviewed current-revision Zetaris capture lineage',async()=>{
 const pool=new pg.Pool({connectionString,max:1}),client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');
  const wid=randomUUID(),cid=randomUUID(),currentRid=randomUUID(),oldRid=randomUUID(),sourceId=randomUUID(),secretId=randomUUID(),currentJob=randomUUID(),oldJob=randomUUID(),currentCapture=randomUUID(),oldCapture=randomUUID(),currentOriginal=randomUUID(),currentDerivative=randomUUID(),currentLatest=randomUUID(),oldOriginal=randomUUID(),oldDerivative=randomUUID(),unrelatedOriginal=randomUUID(),unrelatedDerivative=randomUUID(),noteId=randomUUID();
  await client.query('INSERT INTO faultline.workspaces(id,name) VALUES($1,$2)',[wid,'Generated agent tool acceptance']);
  await client.query('INSERT INTO faultline.cases(id,workspace_id,title,question,active_revision_id) VALUES($1,$2,$3,$4,$5)',[cid,wid,'Generated sponsor case','Which evidence is current?',currentRid]);
  for(const rid of [oldRid,currentRid])await client.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,value,content_hash) VALUES($1,$2,$3,$4,$5)',[rid,wid,cid,{title:'Generated sponsor case'},'a'.repeat(64)]);
  await client.query("INSERT INTO faultline.sources(id,workspace_id,kind,name) VALUES($1,$2,'zetaris_federated_evidence','Generated Zetaris')",[sourceId,wid]);
  await client.query("INSERT INTO faultline.secrets(id,workspace_id,purpose,key_version,ciphertext) VALUES($1,$2,'source','generated','generated')",[secretId,wid]);
  await client.query("INSERT INTO faultline.source_connections(source_id,workspace_id,config,config_hash,secret_id,credential_hint,created_by) VALUES($1,$2,'{}',$3,$4,'configured','generated-owner')",[sourceId,wid,'b'.repeat(64),secretId]);
  for(const [jobId,rid] of [[currentJob,currentRid],[oldJob,oldRid]])await client.query("INSERT INTO faultline.jobs(id,workspace_id,case_id,revision_id,kind,input_hash,input,status) VALUES($1,$2,$3,$4,'source_capture',$5,'{}','succeeded')",[jobId,wid,cid,rid,'c'.repeat(64)]);
  await client.query("INSERT INTO faultline.integration_captures(id,workspace_id,case_id,revision_id,source_id,job_id,fence,request_hash,value,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'complete')",[currentCapture,wid,cid,currentRid,sourceId,currentJob,randomUUID(),'d'.repeat(64),{evidence_ids:[currentOriginal]}]);
  await client.query("INSERT INTO faultline.integration_captures(id,workspace_id,case_id,revision_id,source_id,job_id,fence,request_hash,value,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'complete')",[oldCapture,wid,cid,oldRid,sourceId,oldJob,randomUUID(),'d'.repeat(64),{evidence_ids:[oldOriginal]}]);
  const rows=[
   [currentOriginal,evidence(currentOriginal,wid,cid,currentRid,'federated_query',null),'restricted'],
   [currentDerivative,evidence(currentDerivative,wid,cid,currentRid,'federated_query',currentOriginal),'sanitized'],
   [currentLatest,evidence(currentLatest,wid,cid,currentRid,'federated_query',currentDerivative),'sanitized'],
   [oldOriginal,evidence(oldOriginal,wid,cid,oldRid,'federated_query',null),'restricted'],
   [oldDerivative,evidence(oldDerivative,wid,cid,oldRid,'federated_query',oldOriginal),'sanitized'],
   [unrelatedDerivative,evidence(unrelatedDerivative,wid,cid,currentRid,'federated_query',unrelatedOriginal),'sanitized'],
   [noteId,evidence(noteId,wid,cid,currentRid,'human_note',null),'sanitized'],
  ] as const;
  for(const [id,value,status] of rows)await client.query('INSERT INTO faultline.evidence(id,workspace_id,case_id,value,redaction_status) VALUES($1,$2,$3,$4,$5)',[id,wid,cid,value,status]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  const ids=await currentSanitizedEvidenceIdsTx(client as never,wid,cid,currentRid,[],101);
  assert.deepEqual(new Set(ids),new Set([currentLatest,noteId]));
  assert.equal(ids.includes(currentDerivative),false);assert.equal(ids.includes(oldDerivative),false);assert.equal(ids.includes(unrelatedDerivative),false);assert.equal(ids.includes(currentOriginal),false);
 }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await pool.end();}
});

integration('migration 0033 enforces exact feedback provenance and supporting catalog indexes',async()=>{
 const pool=new pg.Pool({connectionString,max:1});
 try{
  const nullable=await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='faultline' AND table_name='memory_feedback' AND column_name='retrieval_id'");
  assert.equal(nullable.rows[0]?.is_nullable,'NO');
  const indexes=await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='faultline' AND indexname=ANY($1::text[])",[['memory_capsules_active_catalog_idx','memory_feedback_latest_idx']]);
  assert.deepEqual(new Set(indexes.rows.map(row=>row.indexname)),new Set(['memory_capsules_active_catalog_idx','memory_feedback_latest_idx']));
 }finally{await pool.end();}
});

integration('agent runtime role has only the lifecycle update columns required by current services',async()=>{
 const pool=new pg.Pool({connectionString,max:1});
 try{
  const tablePrivileges=await pool.query("SELECT table_name,has_table_privilege('faultline_api',format('faultline.%I',table_name),'SELECT') AS can_select,has_table_privilege('faultline_api',format('faultline.%I',table_name),'INSERT') AS can_insert,has_table_privilege('faultline_api',format('faultline.%I',table_name),'DELETE') AS can_delete FROM unnest($1::text[]) AS table_name ORDER BY table_name",[['agent_sessions','agent_turns','agent_actions']]);
  assert.deepEqual(tablePrivileges.rows.map(row=>[row.table_name,row.can_select,row.can_insert,row.can_delete]),[
   ['agent_actions',true,true,false],['agent_sessions',true,true,false],['agent_turns',true,true,false],
  ]);
  const rows=await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='faultline' AND table_name=ANY($1::text[]) AND has_column_privilege('faultline_api',format('faultline.%I',table_name),column_name,'UPDATE') ORDER BY table_name,column_name",[['agent_sessions','agent_turns','agent_actions']]);
  const actual=rows.rows.map(row=>`${row.table_name}.${row.column_name}`);
  assert.deepEqual(actual,[
   'agent_actions.approved_at','agent_actions.approved_by','agent_actions.last_error_code','agent_actions.reflection_turn_id','agent_actions.status','agent_actions.target_job_id','agent_actions.tool_result','agent_actions.updated_at',
   'agent_sessions.status','agent_sessions.updated_at',
   'agent_turns.error_code','agent_turns.input_hash','agent_turns.job_id','agent_turns.memory_retrieval_id','agent_turns.response','agent_turns.status','agent_turns.updated_at',
  ]);
 }finally{await pool.end();}
});
