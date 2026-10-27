import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {transaction,pool,authPool,verifyRuntimeRole} from '../../packages/database/src/client.js';
import {createWorkspace,invite,claimInvitation,changeMember,type Principal} from '../../packages/core/src/workspaces/service.js';
import {createCase,updateCase} from '../../packages/core/src/cases/service.js';
import {enqueue,claimJob,finishJob,restartJob,cancelJob} from '../../packages/core/src/jobs/service.js';
import {hash,byteHash} from '../../packages/core/src/canonical.js';
import {DomainError} from '../../packages/core/src/errors.js';

type Scope={wid:string;cid:string;revisionId:string;jobId:string;attempt:number;input:Record<string,unknown>};
type JobRow={id:string;case_id:string;revision_id:string;kind:string;input_hash:string;input:Record<string,unknown>;status:string;attempt:number;retry_of:string|null;reserved_units:number;result:unknown;error_code:string|null};
type Budget={reserved:number;spent:number;ceiling:number};
type Allocation={jobs:number;outbox:number;receipts:number;events:number;state_hash:string};
type Queued={wid:string;cid:string;id:string};
const errorCode=(error:unknown)=>error instanceof DomainError?error.code:error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.name:'UNKNOWN';

test('actual PostgreSQL resume rechecks bindings and membership and losing raced admissions leave no extra reservation or outbox',{timeout:120000},async()=>{
 const tag=randomUUID(),started=new Date().toISOString(),file=path.resolve('reports/application/consolidated/resume-binding-'+tag+'.json');
 const receipt:Record<string,unknown>={status:'not_run',started_at:started,scenario_expectations_supplemented:['J-046-C'],scope:'Generated PostgreSQL/domain admission only, with API/worker explicitly quiesced. Waiting states are harness-driven setup, not proof a runtime handler paused.',runtime_handler_execution:'not_run',browser_approval_grant_artifact_preflight:'not_run',http_session_enforcement:'not_run',external_execution:'not_run',objects_written:0,objects_deleted:0,sql_deletes:0,checks:[],generated_scopes:[]};
 const checks=receipt.checks as Record<string,unknown>[],scopes=receipt.generated_scopes as Record<string,string>[];
 let admin:pg.Pool|undefined,owner:Principal|undefined,analyst:Principal|undefined,failure:unknown,phase='quiescence_configuration';const queued:Queued[]=[];
 try{
  assert.equal(process.env.FAULTLINE_TEST_SERVICES_QUIESCED,'1','Root must explicitly assert the reviewed API/worker stop window; this harness never infers stopped writers from age.');
  const dev=JSON.parse(await fs.readFile('.runtime/development-config.json','utf8')) as {ownerEmail:string;viewerEmail:string;port:number};
  assert.ok(dev.ownerEmail&&dev.viewerEmail&&dev.ownerEmail!==dev.viewerEmail,'Distinct existing local principals are required.');
  let operator:URL;try{operator=new URL(process.env.MIGRATION_DATABASE_URL??'');}catch{throw Error('Private loopback operator configuration is required.');}
  for(const variable of ['MIGRATION_DATABASE_URL','DATABASE_URL','AUTH_DATABASE_URL']){let value:URL;try{value=new URL(process.env[variable]??'');}catch{throw Error('Explicit private database configuration missing.');}assert.ok(['postgres:','postgresql:'].includes(value.protocol)&&['localhost','127.0.0.1','[::1]'].includes(value.hostname));assert.equal(value.port,String(dev.port));assert.equal(value.pathname,'/faultline');assert.equal(value.search,'');assert.equal(value.hash,'');assert.ok(value.username&&value.password);}
  if(operator.hostname==='localhost')operator.hostname='127.0.0.1';
  admin=new pg.Pool({connectionString:operator.toString(),max:1,connectionTimeoutMillis:3000,options:'-c statement_timeout=5000 -c lock_timeout=5000',application_name:'faultline-generated-resume-acceptance-'+tag});
  const identity=(await admin.query<{database:string}>('SELECT current_database() AS database')).rows[0];assert.ok(identity);assert.equal(identity.database,'faultline');await verifyRuntimeRole();
  const globalActive=async()=>{const rows:{n:string}[]=(await admin!.query<{n:string}>("SELECT ((SELECT count(*) FROM faultline.jobs WHERE status IN('queued','running','cancel_requested'))+(SELECT count(*) FROM faultline.provider_operations WHERE status IN('queued','running','cancel_requested')))::text AS n")).rows;assert.equal(rows.length,1);const row=rows[0];assert.ok(row);return Number(row.n);};
  assert.equal(await globalActive(),0,'Do not modify or suppress existing active work to obtain free admission slots.');
  const principals:Principal[]=(await admin.query<Principal>('SELECT id,email,name FROM auth."user" WHERE email=ANY($1::text[])',[ [dev.ownerEmail,dev.viewerEmail] ])).rows;
  owner=principals.find(value=>value.email===dev.ownerEmail);analyst=principals.find(value=>value.email===dev.viewerEmail);assert.ok(owner&&analyst&&owner.id!==analyst.id);
  const ownerActor=owner,analystActor=analyst;
  async function workspace(name:string):Promise<string>{const value:Awaited<ReturnType<typeof createWorkspace>>=await createWorkspace(ownerActor,name+' '+tag.slice(0,8),randomUUID());assert.equal(value.role,'owner');assert.match(value.id,/^[a-f0-9-]{36}$/);return value.id;}
  async function job(scope:Scope,id=scope.jobId):Promise<JobRow>{const rows:JobRow[]=(await admin!.query<JobRow>('SELECT id::text,case_id::text,revision_id::text,kind,input_hash,input,status,attempt,retry_of::text,reserved_units,result,error_code FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[scope.wid,scope.cid,id])).rows;assert.equal(rows.length,1);const row=rows[0];assert.ok(row);return row;}
  async function budget(scope:Scope):Promise<Budget>{const rows:Budget[]=(await admin!.query<Budget>('SELECT reserved,spent,ceiling FROM faultline.budgets WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3',[scope.wid,scope.cid,scope.revisionId])).rows;assert.equal(rows.length,1);const row=rows[0];assert.ok(row);return row;}
  async function allocations(wid:string):Promise<Allocation>{
   const queries=[
    'SELECT * FROM faultline.jobs WHERE workspace_id=$1 ORDER BY id',
    'SELECT * FROM faultline.budgets WHERE workspace_id=$1 ORDER BY case_id,revision_id',
    'SELECT * FROM faultline.job_outbox WHERE workspace_id=$1 ORDER BY id',
    'SELECT * FROM faultline.idempotency WHERE workspace_id=$1 ORDER BY principal_id,operation,key',
    'SELECT * FROM faultline.job_events WHERE workspace_id=$1 ORDER BY seq',
    'SELECT * FROM faultline.audit WHERE workspace_id=$1 ORDER BY id',
    'SELECT * FROM faultline.notifications WHERE workspace_id=$1 ORDER BY id',
   ];const rows:pg.QueryResultRow[][]=[];for(const query of queries)rows.push((await admin!.query(query,[wid])).rows);
   return {jobs:rows[0]!.length,outbox:rows[2]!.length,receipts:rows[3]!.length,events:rows[4]!.length,state_hash:hash(rows)};
  }
  async function waiting(wid:string,title:string,kind='comparison_compute'):Promise<Scope>{
   const item:Awaited<ReturnType<typeof createCase>>=await createCase(wid,ownerActor.id,randomUUID(),{title:title+' '+tag.slice(0,8),question:'Generated queue admission assertions only; no runtime or aggregate causal result.',affected_flow:'Explicit waiting-state setup'});
   const input:Record<string,unknown>={actor_id:ownerActor.id,revision_id:item.active_revision_id,scope:'Explicit controlled local setup; runtime handler not executed',immutable_record_id:randomUUID(),snapshot_hash:'a'.repeat(64)};
   await transaction(wid,tx=>tx.query('INSERT INTO faultline.budgets(workspace_id,case_id,revision_id,ceiling) VALUES($1,$2,$3,2)',[wid,item.id,item.active_revision_id]));
   const first:Awaited<ReturnType<typeof enqueue>>=await transaction(wid,tx=>enqueue(tx,wid,item.id,item.active_revision_id,kind,input));queued.push({wid,cid:item.id,id:first.job_id});
   const lease:Awaited<ReturnType<typeof claimJob>>=await claimJob(wid,first.job_id);assert.ok(lease);assert.equal(lease.attempt,1);
   assert.equal(await finishJob(wid,first.job_id,lease.fence,'waiting_for_input',{checkpoint:'Explicit test harness lease completion; no runtime handler executed',evidence_hash:hash({fixture:tag,case_id:item.id})},'EXPLICIT_WAITING_FIXTURE'),'waiting_for_input');
   const scope:Scope={wid,cid:item.id,revisionId:item.active_revision_id,jobId:first.job_id,attempt:1,input};assert.deepEqual(await budget(scope),{reserved:0,spent:0,ceiling:2});assert.equal((await job(scope)).status,'waiting_for_input');scopes.push({workspace_id:wid,case_id:scope.cid,original_job_id:scope.jobId,setup:'Harness invokes real enqueue/claim/finish waiting; runtime wait NOTRUN'});return scope;
  }
  async function rejectUnchanged(name:string,scope:Scope,code:string,action:()=>Promise<unknown>){const before=await allocations(scope.wid);await assert.rejects(action,error=>error instanceof DomainError&&error.code===code);const after=await allocations(scope.wid);assert.deepEqual(after,before,'Denied resume cannot change job/budget/outbox/idempotency/event/audit/notification state.');checks.push({name,expected_code:code,workspace_id:scope.wid,case_id:scope.cid,allocation_hash:before.state_hash,no_mutation:true});}
  async function cancelGenerated(scope:Scope,id:string){const row=await job(scope,id);if(['queued','running','cancel_requested','waiting_for_input'].includes(row.status)){const result:Awaited<ReturnType<typeof cancelJob>>=await cancelJob(scope.wid,ownerActor.id,randomUUID(),scope.cid,id,'Only generated acceptance work; release reserved unit',String(row.attempt));assert.equal(result.status,'cancelled');}}
  phase='current_analyst_setup';const wid=await workspace('Generated resume binding');
  const invitation:Awaited<ReturnType<typeof invite>>=await invite(wid,ownerActor.id,randomUUID(),{intended_email:analystActor.email,role:'analyst',expires_at:new Date(Date.now()+3600000).toISOString()});
  const enrollment:Awaited<ReturnType<typeof claimInvitation>>=await claimInvitation(invitation.token,analystActor,randomUUID());assert.equal(enrollment.status,'claimed');
  const scope=await waiting(wid,'Current immutable resume');
  phase='positive_resume';const original=await job(scope),before=await allocations(wid),key=randomUUID();
  const resumed:Awaited<ReturnType<typeof restartJob>>=await restartJob(wid,analystActor.id,key,scope.jobId,'1','resume');queued.push({wid,cid:scope.cid,id:resumed.job_id});
  assert.notEqual(resumed.job_id,scope.jobId);assert.equal(resumed.retry_of,scope.jobId);assert.equal(resumed.status,'queued');assert.equal(resumed.attempt,0);
  const child=await job(scope,resumed.job_id);assert.deepEqual(child.input,original.input);assert.equal(child.input_hash,original.input_hash);assert.equal(child.input_hash,hash(child.input));assert.equal(child.revision_id,scope.revisionId);assert.equal(child.retry_of,scope.jobId);assert.equal(child.reserved_units,1);assert.deepEqual(await job(scope),original);assert.deepEqual(await budget(scope),{reserved:1,spent:0,ceiling:2});
  const after=await allocations(wid);assert.equal(after.jobs-before.jobs,1);assert.equal(after.outbox-before.outbox,1);assert.equal(after.receipts-before.receipts,1);assert.equal(after.events-before.events,1);
  const replay:Awaited<ReturnType<typeof restartJob>>=await restartJob(wid,analystActor.id,key,scope.jobId,'1','resume');assert.deepEqual(replay,resumed);assert.deepEqual(await allocations(wid),after);
  checks.push({name:'Current analyst resumes as one distinct immutable queued run; replay allocates nothing',workspace_id:wid,case_id:scope.cid,original_job_id:scope.jobId,resumed_job_id:resumed.job_id,input_hash:child.input_hash,reserved_units:1,spent:0,original_history_preserved:true});
  await cancelGenerated(scope,resumed.job_id);assert.deepEqual(await budget(scope),{reserved:0,spent:0,ceiling:2});
  phase='permission_and_binding_negatives';
  await rejectUnchanged('Arbitrary replacement prerequisite rejected',scope,'UNKNOWN_PREREQUISITE',()=>restartJob(wid,analystActor.id,randomUUID(),scope.jobId,'1','resume',[randomUUID()]));
  await rejectUnchanged('Changed attempt rejected',scope,'STALE_INPUTS',()=>restartJob(wid,analystActor.id,randomUUID(),scope.jobId,'0','resume'));
  await rejectUnchanged('Waiting work cannot use failed-only retry',scope,'INVALID_JOB_STATE',()=>restartJob(wid,analystActor.id,randomUUID(),scope.jobId,'1','retry'));
  const member=async()=>{const rows:{revision:number;role:string}[]=(await admin!.query<{revision:number;role:string}>('SELECT revision,role FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2',[wid,analystActor.id])).rows;assert.equal(rows.length,1);const value=rows[0];assert.ok(value);return value;};
  await changeMember(wid,ownerActor.id,randomUUID(),analystActor.id,'viewer',String((await member()).revision));
  await rejectUnchanged('Demoted viewer cannot resume',scope,'FORBIDDEN',()=>restartJob(wid,analystActor.id,randomUUID(),scope.jobId,'1','resume'));
  await rejectUnchanged('Demoted viewer cannot replay original resume receipt',scope,'FORBIDDEN',()=>restartJob(wid,analystActor.id,key,scope.jobId,'1','resume'));
  await changeMember(wid,ownerActor.id,randomUUID(),analystActor.id,null,String((await member()).revision));
  await rejectUnchanged('Revoked membership cannot resume',scope,'NOT_FOUND',()=>restartJob(wid,analystActor.id,randomUUID(),scope.jobId,'1','resume'));
  await rejectUnchanged('Revoked membership cannot replay prior receipt',scope,'NOT_FOUND',()=>restartJob(wid,analystActor.id,key,scope.jobId,'1','resume'));
  const currentCase:Awaited<ReturnType<typeof updateCase>>=await updateCase(wid,ownerActor.id,randomUUID(),scope.cid,{question:'A new reviewed case revision invalidates the previous waiting input binding.'},'1');assert.notEqual(currentCase.active_revision_id,scope.revisionId);
  await rejectUnchanged('Changed active case revision cannot resume prior waiting inputs',scope,'STALE_INPUTS',()=>restartJob(wid,ownerActor.id,randomUUID(),scope.jobId,'1','resume'));
  const unsupported=await waiting(wid,'Explicit unavailable handler','generated_unavailable_handler');await rejectUnchanged('Unavailable handler cannot resume',unsupported,'PREREQUISITE_UNAVAILABLE',()=>restartJob(wid,ownerActor.id,randomUUID(),unsupported.jobId,'1','resume'));
  const altered=await waiting(wid,'Explicit changed stored-input hash fixture'),unaltered=await job(altered);
  try{const tampered={...unaltered.input,snapshot_hash:'b'.repeat(64)};const changed=await admin.query("UPDATE faultline.jobs SET input=$4 WHERE workspace_id=$1 AND case_id=$2 AND id=$3 AND status='waiting_for_input'",[wid,altered.cid,altered.jobId,tampered]);assert.equal(changed.rowCount,1);await rejectUnchanged('Controlled stored-input alteration cannot resume under old digest',altered,'STALE_INPUTS',()=>restartJob(wid,ownerActor.id,randomUUID(),altered.jobId,'1','resume'));}
  finally{const restored=await admin.query("UPDATE faultline.jobs SET input=$4 WHERE workspace_id=$1 AND case_id=$2 AND id=$3 AND status='waiting_for_input'",[wid,altered.cid,altered.jobId,unaltered.input]);assert.equal(restored.rowCount,1);assert.deepEqual(await job(altered),unaltered);}
  phase='workspace_raced_resume';const raced=await waiting(wid,'Same-workspace raced resume'),raceBefore=await allocations(wid);
  const workspaceRace=await Promise.allSettled([restartJob(wid,ownerActor.id,randomUUID(),raced.jobId,'1','resume'),restartJob(wid,ownerActor.id,randomUUID(),raced.jobId,'1','resume')]);
  const workspaceWinner=workspaceRace.find((result):result is PromiseFulfilledResult<Awaited<ReturnType<typeof restartJob>>>=>result.status==='fulfilled'),workspaceLoser=workspaceRace.find((result):result is PromiseRejectedResult=>result.status==='rejected');assert.ok(workspaceWinner&&workspaceLoser);assert.equal(workspaceRace.filter(result=>result.status==='fulfilled').length,1);assert.equal(errorCode(workspaceLoser.reason),'WORKSPACE_BUSY');
  queued.push({wid,cid:raced.cid,id:workspaceWinner.value.job_id});const raceAfter=await allocations(wid);assert.equal(raceAfter.jobs-raceBefore.jobs,1);assert.equal(raceAfter.outbox-raceBefore.outbox,1);assert.equal(raceAfter.receipts-raceBefore.receipts,1);assert.equal(raceAfter.events-raceBefore.events,1);assert.deepEqual(await budget(raced),{reserved:1,spent:0,ceiling:2});
  checks.push({name:'Two different-key same-workspace resumes race; loser leaves only winner reservation/outbox/receipt',winner_job_id:workspaceWinner.value.job_id,loser_code:'WORKSPACE_BUSY',new_jobs:1,new_outbox:1,new_receipts:1,reserved_units:1});await cancelGenerated(raced,workspaceWinner.value.job_id);
  phase='installation_raced_resume';
  const contenders=[await waiting(await workspace('Global resume contender A'),'Only one global slot A'),await waiting(await workspace('Global resume contender B'),'Only one global slot B')];
  const blocker=await waiting(await workspace('Global generated blocker'),'Explicit blocker setup');const blockerRun:Awaited<ReturnType<typeof restartJob>>=await restartJob(blocker.wid,ownerActor.id,randomUUID(),blocker.jobId,'1','resume');queued.push({wid:blocker.wid,cid:blocker.cid,id:blockerRun.job_id});assert.equal(await globalActive(),1);
  const contenderBefore=await Promise.all(contenders.map(value=>allocations(value.wid))),raceKeys=[randomUUID(),randomUUID()];
  const globalRace=await Promise.allSettled(contenders.map((value,index)=>restartJob(value.wid,ownerActor.id,raceKeys[index]!,value.jobId,'1','resume')));assert.equal(globalRace.filter(value=>value.status==='fulfilled').length,1);assert.equal(globalRace.filter(value=>value.status==='rejected').length,1);
  const winningIndex=globalRace.findIndex(value=>value.status==='fulfilled'),losingIndex=globalRace.findIndex(value=>value.status==='rejected'),winningScope=contenders[winningIndex],losingScope=contenders[losingIndex],winner=globalRace[winningIndex],loser=globalRace[losingIndex];assert.ok(winningScope&&losingScope&&winner?.status==='fulfilled'&&loser?.status==='rejected');assert.equal(errorCode(loser.reason),'INSTALLATION_BUSY');queued.push({wid:winningScope.wid,cid:winningScope.cid,id:winner.value.job_id});
  const winnerAfter=await allocations(winningScope.wid),winnerBefore=contenderBefore[winningIndex];assert.ok(winnerBefore);assert.equal(winnerAfter.jobs-winnerBefore.jobs,1);assert.equal(winnerAfter.outbox-winnerBefore.outbox,1);assert.equal(winnerAfter.receipts-winnerBefore.receipts,1);assert.deepEqual(await budget(winningScope),{reserved:1,spent:0,ceiling:2});assert.deepEqual(await allocations(losingScope.wid),contenderBefore[losingIndex]);assert.deepEqual(await budget(losingScope),{reserved:0,spent:0,ceiling:2});assert.equal(await globalActive(),2);
  await cancelGenerated(winningScope,winner.value.job_id);
  const recovered:Awaited<ReturnType<typeof restartJob>>=await restartJob(losingScope.wid,ownerActor.id,raceKeys[losingIndex]!,losingScope.jobId,'1','resume');queued.push({wid:losingScope.wid,cid:losingScope.cid,id:recovered.job_id});assert.deepEqual((await job(losingScope,recovered.job_id)).input,losingScope.input);assert.deepEqual(await budget(losingScope),{reserved:1,spent:0,ceiling:2});
  const recoveredAfter=await allocations(losingScope.wid),loserBefore=contenderBefore[losingIndex];assert.ok(loserBefore);assert.equal(recoveredAfter.jobs-loserBefore.jobs,1);assert.equal(recoveredAfter.outbox-loserBefore.outbox,1);assert.equal(recoveredAfter.receipts-loserBefore.receipts,1);
  checks.push({name:'Different workspaces compete for the final installation slot; losing transaction changes no allocation, and same failed key can admit once slot is free',winner_job_id:winner.value.job_id,loser_workspace_id:losingScope.wid,loser_code:'INSTALLATION_BUSY',loser_allocation_hash:loserBefore.state_hash,recovered_job_id:recovered.job_id,reserved_units:1});
  await cancelGenerated(losingScope,recovered.job_id);await cancelGenerated(blocker,blockerRun.job_id);assert.equal(await globalActive(),0);
  receipt.status='passed';receipt.waiting_setup='Real production enqueue/claim/finish invoked by test harness; actual worker missing-input transition NOTRUN';receipt.operator_asserted_services_quiesced=true;receipt.final_global_active_jobs_and_provider_operations=0;
 }catch(error){failure=error;receipt.status='failed';receipt.failed_phase=phase;receipt.error={code:errorCode(error)};}
 finally{
  const cleanup:{job_id:string;status:string}[]=[];
  if(admin&&owner)for(const value of queued){try{const rows:{status:string;attempt:number}[]=(await admin.query<{status:string;attempt:number}>('SELECT status,attempt FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[value.wid,value.cid,value.id])).rows;const row=rows[0];if(row&&['queued','running','cancel_requested'].includes(row.status)){const result:Awaited<ReturnType<typeof cancelJob>>=await cancelJob(value.wid,owner.id,randomUUID(),value.cid,value.id,'Generated acceptance cleanup only',String(row.attempt));cleanup.push({job_id:value.id,status:result.status});if(result.status!=='cancelled')throw Error('Generated cleanup remains pending');}}
   catch(error){receipt.cleanup_failed=true;cleanup.push({job_id:value.id,status:errorCode(error)});failure??=error;}}
  receipt.cleanup=cleanup;if(failure)receipt.status='failed';receipt.finished_at=new Date().toISOString();receipt.test_source_sha256=byteHash(await fs.readFile(new URL(import.meta.url)));
  receipt.limitations=['Waiting status/checkpoints are explicitly driven by domain lease methods in a quiesced test harness, not a runtime handler transition.','This verifies generic job admission, current roles, active revision, frozen-input digest and arbitrary-prerequisite rejection. Browser approval/grant/artifact freshness is not exercised; no native plan is fabricated or old fixture reused.','Actual HTTP session/CSRF routes and eventual handler completion are outside this DB/domain acceptance; queued generated children are cancelled through the normal domain service.'];
  await admin?.end().catch(error=>{failure??=error;receipt.status='failed';});await pool?.end().catch(error=>{failure??=error;receipt.status='failed';});await authPool?.end().catch(error=>{failure??=error;receipt.status='failed';});
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(receipt.status==='passed'?file:file.replace('.json','-failure.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 if(failure)throw Error('Generated resume/admission acceptance failed; inspect '+file.replace('.json','-failure.json'));
 console.log('Generated resume binding and raced admission accounting passed; receipt '+file+'.');
});
