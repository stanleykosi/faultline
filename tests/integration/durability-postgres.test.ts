import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildServer} from '../../apps/api/src/server.js';
import {pool,authPool,transaction} from '../../packages/database/src/client.js';
import {claimJob,finishJob,cancelJob} from '../../packages/core/src/jobs/service.js';
import {commitHandler} from '../../packages/core/src/captures/service.js';
const dev=JSON.parse(await fs.readFile('.runtime/development-config.json','utf8')),origin='http://localhost:3000';
assert.ok(process.env.MIGRATION_DATABASE_URL?.includes('127.0.0.1:'+dev.port+'/faultline'),'Only configured private test database');
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL,max:1}),app=await buildServer();
let cookie='',csrf='';
async function call(method:'GET'|'POST',url:string,payload?:unknown,revision?:number,key=randomUUID()){
 const response=await app.inject({method,url,headers:{origin,cookie,'x-csrf-token':csrf,'idempotency-key':key,...(payload===undefined?{}:{'content-type':'application/json'}),...(revision===undefined?{}:{'if-match':String(revision)})},...(payload===undefined?{}:{payload:JSON.stringify(payload)})});return response;
}
const signed=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email:dev.ownerEmail,password:dev.ownerPassword}});
assert.equal(signed.statusCode,200);
const cookies=signed.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');
csrf=(await call('GET','/api/v1/session')).json().data.csrf_token;
function result(response:any,status=200){assert.equal(response.statusCode,status,response.body);return response.json().data;}
async function prepare(wid?:string){
 if(!wid)wid=result(await call('POST','/api/v1/workspaces',{name:'Local durability validation '+randomUUID().slice(0,8)}),201).id;
 const base='/api/v1/workspaces/'+wid,investigation=result(await call('POST',base+'/cases',{title:'Durable publication acceptance',question:'Does one reviewed capture publish at most once?'}),201);
 const caseBase=base+'/cases/'+investigation.id;
 const bytes=Buffer.from(JSON.stringify([['b-entry','b','checkout_started','2026-09-01T01:00:00.000001Z'],['b-success','b','checkout_completed','2026-09-01T01:01:00.000001Z'],['c-entry','c','checkout_started','2026-09-02T01:00:00.000001Z'],['c-success','c','checkout_completed','2026-09-02T01:01:00.000001Z']].map(([event_id,session_id,event_name,occurred_at])=>({source_id:'durability',event_id,session_id,event_name,occurred_at,device:'mobile',excluded:false,release_id:null}))));
 const boundary='faultline-'+randomUUID(),multipart=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="kind"\r\n\r\nanalytics\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="events.json"\r\nContent-Type: application/json\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
 const stagedResponse=await app.inject({method:'POST',url:caseBase+'/imports',headers:{origin,cookie,'x-csrf-token':csrf,'idempotency-key':randomUUID(),'content-type':'multipart/form-data; boundary='+boundary},payload:multipart});
 const staged=result(stagedResponse,201),mapping=result(await call('POST',caseBase+'/imports/'+staged.id+'/mappings',{kind:'canonical',record_type:'analytics',schema_version:1},investigation.revision));
 const preview=result(await call('POST',caseBase+'/imports/'+staged.id+'/preview',{mapping_id:mapping.id}));assert.equal(preview.can_finalize,true);
 const body={mapping_id:mapping.id,coverage_declaration:{basis:'operator_attestation',event_time_intervals:[{start:'2026-09-01T00:00:00.000Z',end:'2026-09-03T00:30:00.000Z'}],declared_event_watermark:'2026-09-03T00:30:00.000Z',statement:'Generated trusted four-record local durability acceptance.',reference_evidence_ids:[],late_arrival_hours:0},accepted_issue_ids:[]};
 return {wid:wid!,caseId:investigation.id,base,caseBase,importId:staged.id,revision:investigation.revision,body};
}
async function enqueue(input:Awaited<ReturnType<typeof prepare>>,key=randomUUID()){return call('POST',input.caseBase+'/imports/'+input.importId+'/commit',input.body,input.revision,key);}
async function running(input:Awaited<ReturnType<typeof prepare>>,id:string){const job=await claimJob(input.wid,id);assert.ok(job);return job!;}
const assertions:string[]=[];
test('actual PostgreSQL capture crash/expiry, cancellation and raced admission preserve independent invariants',{timeout:180_000},async()=>{
 try{
  const first=await prepare(),key=randomUUID(),job=result(await enqueue(first,key),202),replay=result(await enqueue(first,key),202);assert.equal(job.job_id,replay.job_id);
  const childCode="import {claimJob} from './packages/core/src/jobs/service.ts';const j=await claimJob(process.env.TEST_WID,process.env.TEST_JOB);console.log(JSON.stringify({fence:j.fence,attempt:j.attempt}));process.exit(17);";
  const crashed=await new Promise<{code:number|null;fence:string}>( (resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',childCode],{env:{...process.env,TEST_WID:first.wid,TEST_JOB:job.job_id},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',c=>out+=c);child.once('error',reject);child.once('close',code=>{try{resolve({code,fence:JSON.parse(out.trim()).fence});}catch(e){reject(e);}});});
  assert.equal(crashed.code,17);
  const start=Date.now();let recovered=false;while(Date.now()-start<75_000){await pool!.query('SELECT faultline.recover_expired_jobs()');const row=(await admin.query('SELECT status FROM faultline.jobs WHERE id=$1',[job.job_id])).rows[0];if(row.status==='queued'){recovered=true;break;}await new Promise(r=>setTimeout(r,500));}assert.equal(recovered,true,'Actual60second lease must expire after attempt process exits');
  const fresh=await running(first,job.job_id);assert.equal(fresh.attempt,2);assert.notEqual(fresh.fence,crashed.fence);
  await assert.rejects(()=>commitHandler({...fresh,fence:crashed.fence}),(error:unknown)=>error instanceof Error && 'code' in error && error.code==='CANCELLED_OR_FENCED');
  const publication=await commitHandler(fresh);await finishJob(first.wid,job.job_id,fresh.fence,'succeeded',publication);
  await assert.rejects(()=>commitHandler(fresh),(error:unknown)=>error instanceof Error && 'code' in error && error.code==='CANCELLED_OR_FENCED');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM faultline.snapshots WHERE import_id=$1',[first.importId])).rows[0].n,1);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM faultline.canonical_events WHERE case_id=$1',[first.caseId])).rows[0].n,4);
  const budget=(await admin.query('SELECT reserved,spent FROM faultline.budgets WHERE case_id=$1',[first.caseId])).rows[0];assert.deepEqual(budget,{reserved:0,spent:1});
  assertions.push('Actual attempt child crash, natural lease expiry and new fence publish exactly one real snapshot/four events; stale delivery rejected and original budget settled once');
  const cancelled=await prepare(),cancelJob=result(await enqueue(cancelled),202),attempt=await running(cancelled,cancelJob.job_id);
  result(await call('POST',cancelled.base+'/jobs/'+cancelJob.job_id+'/cancel',{reason:'Independent cancel-before-publication acceptance'},attempt.attempt));
  await assert.rejects(()=>commitHandler(attempt),(error:unknown)=>error instanceof Error && 'code' in error && error.code==='CANCELLED_OR_FENCED');assert.equal(await finishJob(cancelled.wid,cancelJob.job_id,attempt.fence,'succeeded',{forged:true}),'cancelled');
  const counts=(await admin.query('SELECT (SELECT count(*) FROM faultline.snapshots WHERE case_id=$1)::int AS snapshots,(SELECT count(*) FROM faultline.canonical_events WHERE case_id=$1)::int AS events',[cancelled.caseId])).rows[0];assert.deepEqual(counts,{snapshots:0,events:0});
  const saved=result(await call('GET',cancelled.base+'/jobs/'+cancelJob.job_id));assert.equal(saved.result,null);assert.equal(saved.status,'cancelled');
  assertions.push('Accepted cancellation fences capture publication and discards late returned result');
  const a=await prepare(),b=await prepare(a.wid),race=await Promise.all([enqueue(a),enqueue(b)]);assert.deepEqual(race.map(x=>x.statusCode).sort(),[202,429]);
  const chosen=race[0].statusCode===202?a:b,queued=result(race.find(x=>x.statusCode===202),202);
  result(await call('POST',chosen.base+'/jobs/'+queued.job_id+'/cancel',{reason:'Clean raced validation'},0));
  assert.equal((await admin.query("SELECT count(*)::int n FROM faultline.jobs WHERE workspace_id=$1 AND status IN('queued','running','cancel_requested')",[a.wid])).rows[0].n,0);
  assertions.push('Concurrent commands admit one workspace job and reject the other without a reservation');
  const c=await prepare(),d=await prepare(),e=await prepare(),globalRace=await Promise.all([enqueue(c),enqueue(d),enqueue(e)]);assert.deepEqual(globalRace.map(x=>x.statusCode).sort(),[202,202,429]);
  for(const [i,response]of globalRace.entries())if(response.statusCode===202){const selected=[c,d,e][i]!,queued=result(response,202);result(await call('POST',selected.base+'/jobs/'+queued.job_id+'/cancel',{reason:'Clean installation admission validation'},0));}
  assertions.push('Installation admission serializes two slots across three workspaces');
  await fs.writeFile('reports/application/consolidated/durability.json',JSON.stringify({status:'passed',at:new Date().toISOString(),assertions,natural_lease_expiry:true,scope:'Real local PostgreSQL, actual attempt process death, reviewed capture handler and authenticated cancellation/admission. SSE/file-interruption acceptance remains separate.'},null,2));
 }finally{await pool!.query('SELECT faultline.recover_expired_jobs()');const pending=(await admin.query("SELECT j.workspace_id,j.case_id,j.id,j.attempt,j.input->>'actor_id' AS actor FROM faultline.jobs j JOIN faultline.cases c ON c.id=j.case_id WHERE c.title='Durable publication acceptance' AND c.question='Does one reviewed capture publish at most once?' AND j.status IN('queued','running','cancel_requested')")).rows;for(const row of pending){await cancelJob(row.workspace_id,row.actor,randomUUID(),row.case_id,row.id,'Clean generated acceptance attempt',String(row.attempt));}await app.close();await admin.end();await pool?.end();await authPool?.end();}
});
