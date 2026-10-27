import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {buildServer} from '../../apps/api/src/server.js';
import {pool,authPool} from '../../packages/database/src/client.js';
import {claimJob,finishJob} from '../../packages/core/src/jobs/service.js';
import {commitHandler} from '../../packages/core/src/captures/service.js';
import {DomainError} from '../../packages/core/src/errors.js';

// Real PostgreSQL and business API injection with production attempt handlers.
// The harness drives lease entry, not a main-worker daemon or external runner.
test('publication and cancellation have one atomic PostgreSQL truth boundary',{timeout:120000},async()=>{
 const dev=JSON.parse(await fs.readFile('.runtime/development-config.json','utf8'));
 assert.ok(process.env.MIGRATION_DATABASE_URL?.includes('127.0.0.1:'+dev.port+'/faultline'));
 const admin=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL,max:1,query_timeout:5000}),app=await buildServer(),origin='http://localhost:3000',checks:unknown[]=[],tag=randomUUID();
 let cookie='',csrf='',failure:unknown;
 const invoke=async(method:'GET'|'POST',url:string,payload?:unknown,revision?:number)=>app.inject({method,url,headers:{origin,cookie,'x-csrf-token':csrf,'idempotency-key':randomUUID(),...(payload===undefined?{}:{'content-type':'application/json'}),...(revision===undefined?{}:{'if-match':String(revision)})},...(payload===undefined?{}:{payload:JSON.stringify(payload)})});
 const data=(response:any,status=200)=>{assert.equal(response.statusCode,status,response.body);return response.json().data;};
 async function prepare(label:string){
  const workspace=data(await invoke('POST','/api/v1/workspaces',{name:'Generated atomic publication '+label+' '+tag.slice(0,8)}),201),base='/api/v1/workspaces/'+workspace.id;
  const item=data(await invoke('POST',base+'/cases',{title:'Atomic capture '+label,question:'Can cancellation contradict an already committed snapshot?'}),201),route=base+'/cases/'+item.id;
  const events=[['a-entry','a','checkout_started','10:00:00.000001'],['a-success','a','checkout_completed','10:01:00.000001'],['b-entry','b','checkout_started','10:02:00.000002'],['b-success','b','checkout_completed','10:03:00.000002']].map(([event_id,session_id,event_name,time])=>({source_id:'atomic-'+tag+'-'+label,event_id,session_id,event_name,occurred_at:'2026-10-01T'+time+'Z',device:'desktop',excluded:false,release_id:null}));
  const boundary='atomic-'+randomUUID(),body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="kind"\r\n\r\nanalytics\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="authored.json"\r\nContent-Type: application/json\r\n\r\n'),Buffer.from(JSON.stringify(events)),Buffer.from('\r\n--'+boundary+'--\r\n')]);
  const imported=data(await app.inject({method:'POST',url:route+'/imports',headers:{origin,cookie,'x-csrf-token':csrf,'idempotency-key':randomUUID(),'content-type':'multipart/form-data; boundary='+boundary},payload:body}),201);
  const mapping=data(await invoke('POST',route+'/imports/'+imported.id+'/mappings',{kind:'canonical',record_type:'analytics',schema_version:1},item.revision));
  assert.equal(data(await invoke('POST',route+'/imports/'+imported.id+'/preview',{mapping_id:mapping.id})).counts.accepted,4);
  const queued=data(await invoke('POST',route+'/imports/'+imported.id+'/commit',{mapping_id:mapping.id,coverage_declaration:{basis:'none',event_time_intervals:[],declared_event_watermark:null,statement:'No completeness assertion; this acceptance records four independently authored events only.',reference_evidence_ids:[],late_arrival_hours:0},accepted_issue_ids:[]},item.revision),202),job=await claimJob(workspace.id,queued.job_id);assert.ok(job);
  return {wid:workspace.id,cid:item.id,importId:imported.id,job:job!,cancel:()=>invoke('POST',base+'/jobs/'+queued.job_id+'/cancel',{reason:'Generated acceptance cancellation at the publication boundary.'},job!.attempt)};
 }
 async function facts(scope:Awaited<ReturnType<typeof prepare>>){
  const job=(await admin.query('SELECT status,result,input,input_hash,reserved_units FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[scope.wid,scope.cid,scope.job.id])).rows[0],snapshots=(await admin.query('SELECT id,content_hash FROM faultline.snapshots WHERE workspace_id=$1 AND case_id=$2 AND import_id=$3',[scope.wid,scope.cid,scope.importId])).rows,budget=(await admin.query('SELECT spent,reserved FROM faultline.budgets WHERE workspace_id=$1 AND case_id=$2',[scope.wid,scope.cid])).rows[0],events=(await admin.query("SELECT event FROM faultline.job_events WHERE workspace_id=$1 AND case_id=$2 AND job_id=$3 ORDER BY seq",[scope.wid,scope.cid,scope.job.id])).rows;
  assert.deepEqual(job.input,scope.job.input);assert.equal(job.input_hash,scope.job.input_hash);return {job,snapshots,budget,events:events.map(row=>row.event.status)};
 }
 try{
  const signed=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email:dev.ownerEmail,password:dev.ownerPassword}});assert.equal(signed.statusCode,200);const values=signed.headers['set-cookie'];cookie=(Array.isArray(values)?values:[values]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');csrf=data(await invoke('GET','/api/v1/session')).csrf_token;
  const published=await prepare('after'),result=await commitHandler(published.job),beforeAck=await facts(published);
  assert.equal(beforeAck.job.status,'succeeded');assert.deepEqual(beforeAck.job.result,result);assert.equal(beforeAck.snapshots.length,1);assert.deepEqual(beforeAck.budget,{spent:1,reserved:0});assert.equal(beforeAck.events.filter(x=>x==='succeeded').length,1);
  assert.equal(data(await published.cancel()).status,'succeeded');assert.equal(await finishJob(published.wid,published.job.id,published.job.fence,'succeeded',result),'succeeded');assert.deepEqual(await facts(published),beforeAck);
  await assert.rejects(finishJob(published.wid,published.job.id,published.job.fence,'succeeded',{snapshot_id:randomUUID()}),error=>error instanceof DomainError&&error.code==='FENCED_ATTEMPT');assert.deepEqual(await facts(published),beforeAck);
  checks.push({name:'Cancellation after publication observes succeeded before worker acknowledgement; exact acknowledgement settles once, forged acknowledgement rejected',workspace_id:published.wid,job_id:published.job.id,snapshots:1,spent:1,reserved:0});
  const cancelled=await prepare('before');assert.equal(data(await cancelled.cancel()).status,'cancel_requested');await assert.rejects(commitHandler(cancelled.job),error=>error instanceof DomainError&&error.code==='CANCELLED_OR_FENCED');assert.equal(await finishJob(cancelled.wid,cancelled.job.id,cancelled.job.fence,'failed',null,'CANCELLED_OR_FENCED'),'cancelled');const stopped=await facts(cancelled);assert.equal(stopped.job.status,'cancelled');assert.equal(stopped.job.result,null);assert.equal(stopped.snapshots.length,0);assert.deepEqual(stopped.budget,{spent:0,reserved:0});assert.deepEqual(stopped.events,['queued','running','cancel_requested','cancelled']);
  checks.push({name:'Cancellation before publication visibly requests stop; actual handler rejects publication and acknowledgement records cancelled with zero effects',workspace_id:cancelled.wid,job_id:cancelled.job.id,snapshots:0,spent:0,reserved:0});
  for(let index=0;index<4;index++){
   const scope=await prepare('race-'+index),raced=await Promise.allSettled([commitHandler(scope.job),scope.cancel()]),publication=raced[0]!,cancellation=raced[1]!;if(cancellation.status!=='fulfilled')throw cancellation.reason;
   const response=data(cancellation.value);
   if(publication.status==='fulfilled'){assert.equal(response.status,'succeeded');await finishJob(scope.wid,scope.job.id,scope.job.fence,'succeeded',publication.value);}
   else{assert.ok(publication.reason instanceof DomainError&&publication.reason.code==='CANCELLED_OR_FENCED');assert.equal(response.status,'cancel_requested');await finishJob(scope.wid,scope.job.id,scope.job.fence,'failed',null,'CANCELLED_OR_FENCED');}
   const actual=await facts(scope),won=publication.status==='fulfilled';assert.equal(actual.job.status,won?'succeeded':'cancelled');assert.equal(actual.snapshots.length,won?1:0);assert.deepEqual(actual.budget,{spent:won?1:0,reserved:0});assert.equal(actual.events.filter(x=>x==='succeeded').length,won?1:0);checks.push({name:'Concurrent actual PostgreSQL/API cancellation and capture publication serialize into one truthful outcome',workspace_id:scope.wid,job_id:scope.job.id,outcome:actual.job.status,snapshots:actual.snapshots.length,spent:actual.budget.spent,reserved:0});
  }
 }catch(error){failure=error;}finally{
  await app.close();await Promise.allSettled([admin.end(),pool?.end(),authPool?.end()]);
  const source=await fs.readFile(new URL(import.meta.url)),receipt={status:failure?'failed':'passed',at:new Date().toISOString(),checks,test_source_sha256:createHash('sha256').update(source).digest('hex'),scope:'Real private PostgreSQL/business API injection and production attempt handlers; main-worker daemon and connected browser not exercised.',sql_status_fabrication:false,error:failure instanceof Error?{name:failure.name,message:failure.message}:undefined,limits:['Running lease entry is explicitly driven by the production claimJob method in a quiesced test harness.','Cancellation rows and publication results come from production services; no SQL status mutation or fabricated snapshot.','This verifies the publication boundary; external cleanup, actor-analyst browser journey and daemon interruption remain unverified.']};await fs.mkdir('reports/application/consolidated',{recursive:true});const path='reports/application/consolidated/atomic-publication-'+tag+'.json';await fs.writeFile(path,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log('Atomic publication receipt '+path);
 }
 if(failure)throw failure;
});
