import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

const connectionString=process.env.MIGRATION_DATABASE_URL;
const integration=connectionString?test:test.skip;

async function seed(client:pg.PoolClient,wid:string,cid:string,rid:string,pid:string,jid:string,sid:string,tid:string,aid:string){
 await client.query('SET CONSTRAINTS ALL DEFERRED');
 await client.query('INSERT INTO faultline.workspaces(id,name) VALUES($1,$2)',[wid,'Generated agent retention acceptance']);
 await client.query('INSERT INTO faultline.cases(id,workspace_id,title,question,active_revision_id,deletion_requested_at) VALUES($1,$2,$3,$4,$5,now())',[cid,wid,'Generated agent case','Does reviewed cleanup retain referential integrity?',rid]);
 await client.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,value,content_hash) VALUES($1,$2,$3,$4,$5)',[rid,wid,cid,{title:'Generated agent case'},'a'.repeat(64)]);
 await client.query("INSERT INTO faultline.model_profiles(id,workspace_id,name,provider,base_url,model_name,profile_hash,created_by) VALUES($1,$2,'Synthetic model','openrouter','https://openrouter.ai/api/v1','synthetic/model',$3,'generated-owner')",[pid,wid,'b'.repeat(64)]);
 await client.query("INSERT INTO faultline.jobs(id,workspace_id,case_id,revision_id,kind,input_hash,input,status,result) VALUES($1,$2,$3,$4,'agent_turn',$5,'{}','succeeded','{}')",[jid,wid,cid,rid,'c'.repeat(64)]);
 await client.query("INSERT INTO faultline.agent_sessions(id,workspace_id,case_id,profile_id,objective,status,created_by) VALUES($1,$2,$3,$4,'Generated objective','active','generated-owner')",[sid,wid,cid,pid]);
 await client.query("INSERT INTO faultline.agent_turns(id,workspace_id,case_id,session_id,revision_id,job_id,actor_id,user_message,status) VALUES($1,$2,$3,$4,$5,$6,'generated-owner','Generated question','succeeded')",[tid,wid,cid,sid,rid,jid]);
 await client.query("INSERT INTO faultline.agent_actions(id,workspace_id,case_id,session_id,turn_id,kind,title,reason,requires_approval,status,target_job_id,binding_hash) VALUES($1,$2,$3,$4,$5,'open_data','Open data','Generated review',true,'approved',$6,$7)",[aid,wid,cid,sid,tid,jid,'d'.repeat(64)]);
 const reportId=randomUUID(),capsuleId=randomUUID(),retrievalId=randomUUID();
 await client.query("INSERT INTO faultline.report_versions(id,workspace_id,case_id,value,binding) VALUES($1,$2,$3,$4,'{}')",[reportId,wid,cid,{status:'published',revision_id:rid}]);
 await client.query("INSERT INTO faultline.memory_capsules(id,workspace_id,case_id,revision_id,report_id,value,capsule_hash,accepted_by) VALUES($1,$2,$3,$4,$5,'{}',$6,'generated-owner')",[capsuleId,wid,cid,rid,reportId,'f'.repeat(64)]);
 await client.query("INSERT INTO faultline.memory_retrievals(id,workspace_id,case_id,revision_id,query_hash,catalog_hash,result_hash,status,value) VALUES($1,$2,$3,$4,$5,$6,$7,'complete','{}')",[retrievalId,wid,cid,rid,'1'.repeat(64),'2'.repeat(64),'3'.repeat(64)]);
 await client.query("INSERT INTO faultline.memory_feedback(id,workspace_id,case_id,capsule_id,retrieval_id,actor_id,kind,engine_trace) VALUES($1,$2,$3,$4,$5,'generated-owner','helpful','{}')",[randomUUID(),wid,cid,capsuleId,retrievalId]);
 await client.query('UPDATE faultline.agent_turns SET memory_retrieval_id=$4 WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,tid,retrievalId]);
}

integration('agent job bindings reject cross-scope targets and reviewed case/workspace purge removes generated agent rows',async()=>{
 const pool=new pg.Pool({connectionString,max:1}),client=await pool.connect();
 try{
  await client.query('BEGIN');
  const ids=Array.from({length:16},()=>randomUUID()),[wid,cid,rid,pid,jid,sid,tid,aid,wid2,cid2,rid2,pid2,jid2,sid2,tid2,aid2]=ids;
  await seed(client,wid!,cid!,rid!,pid!,jid!,sid!,tid!,aid!);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('SAVEPOINT invalid_job');
  await assert.rejects(client.query("INSERT INTO faultline.agent_actions(id,workspace_id,case_id,session_id,turn_id,kind,title,reason,requires_approval,status,target_job_id,binding_hash) VALUES($1,$2,$3,$4,$5,'open_data','Invalid','Generated negative',true,'suggested',$6,$7)",[randomUUID(),wid,cid,sid,tid,randomUUID(),'e'.repeat(64)]),(error:any)=>error?.code==='23503');
  await client.query('ROLLBACK TO SAVEPOINT invalid_job');
  await client.query("SELECT set_config('faultline.workspace_id',$1,true)",[wid]);
  assert.equal((await client.query('SELECT faultline.purge_case_data($1) AS removed',[cid])).rows[0]?.removed,true);
  assert.equal(Number((await client.query('SELECT count(*) AS count FROM faultline.agent_sessions WHERE workspace_id=$1',[wid])).rows[0]?.count),0);
  assert.equal(Number((await client.query('SELECT count(*) AS count FROM faultline.memory_capsules WHERE workspace_id=$1',[wid])).rows[0]?.count),0);
  await seed(client,wid2!,cid2!,rid2!,pid2!,jid2!,sid2!,tid2!,aid2!);
  await client.query('UPDATE faultline.workspaces SET deletion_requested_at=now() WHERE id=$1',[wid2]);
  await client.query("SELECT set_config('faultline.workspace_id',$1,true)",[wid2]);
  assert.equal((await client.query('SELECT faultline.purge_workspace_data() AS removed')).rows[0]?.removed,true);
  assert.equal(Number((await client.query('SELECT count(*) AS count FROM faultline.cases WHERE workspace_id=$1',[wid2])).rows[0]?.count),0);
  assert.equal(Number((await client.query('SELECT count(*) AS count FROM faultline.agent_sessions WHERE workspace_id=$1',[wid2])).rows[0]?.count),0);
  assert.equal((await client.query('SELECT name FROM faultline.workspaces WHERE id=$1',[wid2])).rows[0]?.name,'Deleted workspace');
 }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await pool.end();}
});
