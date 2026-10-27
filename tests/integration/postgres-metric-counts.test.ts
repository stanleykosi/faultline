import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {computePostgresComparison} from '../../packages/core/src/metrics/postgres.js';
import {computeComparison,computeMixShift} from '../../packages/core/src/metrics/comparison.js';
import {normalizeEventTime} from '../../packages/core/src/imports/time.js';
import {hash,byteHash} from '../../packages/core/src/canonical.js';
import {validateContract} from '../../packages/contracts/src/validate.js';
import type {FaultlineCanonicalEvent,FaultlineCoverage,FaultlineMetric,FaultlineMetricResult} from '../../packages/contracts/src/generated.js';

// Actual SQL fixtures, not an import/API/business journey. All seeded rows are
// confined to generated UUID scopes and rolled back; no private objects are written.
pg.types.setTypeParser(1184,value=>value);
const read=async<T>(file:string):Promise<T>=>JSON.parse(await fs.readFile(file,'utf8')) as T;
const close=(actual:number|null|undefined,wanted:number)=>{
 assert.equal(typeof actual,'number');assert.ok(Math.abs(actual!-wanted)<1e-12,`${actual} differs from independently expected ${wanted}`);
};
type Scope={wid:string;cid:string;otherCid:string;sid:string;otherSid:string;revision:string};
type ReceiptCheck={name:string;scope?:Record<string,string>;observed:unknown};
const checks:ReceiptCheck[]=[],scopes:{workspace_id:string;case_id:string;rolled_back:boolean}[]=[],inputHashes:Record<string,string>={};
const tag=randomUUID(),receipt=`reports/application/consolidated/postgres-metric-counts-${tag}.json`;
const fixtureMetric=await read<FaultlineMetric>('fixtures/regression/metric.json');
const fullCoverage=await read<FaultlineCoverage>('fixtures/regression/coverage.json');
const development=await read<{port:number}>('.runtime/development-config.json');
let privateUrl:URL;
try{privateUrl=new URL(process.env.MIGRATION_DATABASE_URL??'');}catch{throw new Error('Private local operator database configuration is required.');}
assert.ok(['postgres:','postgresql:'].includes(privateUrl.protocol)&&['localhost','127.0.0.1','[::1]'].includes(privateUrl.hostname));
assert.equal(Number(privateUrl.port),development.port,'Use only the configured private PostgreSQL instance.');
assert.equal(privateUrl.pathname,'/faultline','Use only the configured private development database.');
assert.equal(privateUrl.search,'');assert.equal(privateUrl.hash,'');
assert.ok(privateUrl.username&&privateUrl.password,'Private operator credentials are required; never output them.');
if(privateUrl.hostname==='localhost')privateUrl.hostname='127.0.0.1';
const database=new pg.Pool({connectionString:privateUrl.toString(),max:1,connectionTimeoutMillis:5000,
 application_name:'faultline-generated-counted-metric-acceptance',options:'-c statement_timeout=10000 -c lock_timeout=2000'});

async function seedCase(tx:pg.PoolClient,wid:string,cid:string,revision:string){
 await tx.query('INSERT INTO faultline.cases(id,workspace_id,title,question,active_revision_id) VALUES($1,$2,$3,$4,$5)',
  [cid,wid,'Generated SQL metric acceptance '+tag,'Independent counted SQL expectations; rollback fixture only.',revision]);
 const value={title:'Generated SQL component fixture',question:'No persisted product journey or source capture is claimed.'};
 await tx.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,value,content_hash) VALUES($1,$2,$3,$4,$5)',[revision,wid,cid,value,hash(value)]);
}
async function seedSnapshot(tx:pg.PoolClient,scope:Scope,events:FaultlineCanonicalEvent[],cid=scope.cid){
 const importId=randomUUID(),snapshotId=randomUUID(),payload=Buffer.from(JSON.stringify(events));
 for(const event of events)validateContract('canonical-event',event);
 await tx.query("INSERT INTO faultline.imports(id,workspace_id,case_id,source_id,record_kind,format,stage,raw_key,raw_bytes) VALUES($1,$2,$3,$4,'analytics','json','uploaded',$5,$6)",
  [importId,scope.wid,cid,scope.sid,byteHash(payload),payload.length]);
 // Metadata is explicitly fixture-only. The component reads canonical_events,
 // not this JSON. No object, accepted import, frozen product snapshot or queue job
 // is asserted to exist, and these rows never commit.
 await tx.query('INSERT INTO faultline.snapshots(id,workspace_id,case_id,source_id,import_id,value,object_key,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
  [snapshotId,scope.wid,cid,scope.sid,importId,{test_fixture:'transaction-only counted SQL',record_count:events.length},byteHash(payload),hash({events})]);
 if(events.length)await tx.query(`INSERT INTO faultline.canonical_events(workspace_id,case_id,snapshot_id,source_id,event_id,session_id,event_name,occurred_at,device,excluded,release_id)
  SELECT $1,$2,$3,e.source_id::uuid,e.event_id,e.session_id,e.event_name,e.occurred_at::timestamptz,e.device,e.excluded,e.release_id
  FROM jsonb_to_recordset($4::jsonb) AS e(source_id text,event_id text,session_id text,event_name text,occurred_at text,device text,excluded boolean,release_id text)`,
  [scope.wid,cid,snapshotId,JSON.stringify(events)]);
 assert.equal(Number((await tx.query('SELECT count(*) AS n FROM faultline.canonical_events WHERE workspace_id=$1 AND case_id=$2 AND snapshot_id=$3',[scope.wid,cid,snapshotId])).rows[0].n),events.length);
 return snapshotId;
}
async function runtimeScope(tx:pg.PoolClient,scope:Scope){
 await tx.query('SET CONSTRAINTS ALL IMMEDIATE'); // Prove the fixture satisfies real FK constraints before measuring.
 await tx.query('SET LOCAL ROLE faultline_api');
 await tx.query("SELECT set_config('faultline.workspace_id',$1,true)",[scope.wid]);
 const role=(await tx.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 assert.equal(role.name,'faultline_api');assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
}
async function rolledBack(action:(tx:pg.PoolClient,scope:Scope)=>Promise<void>){
 const tx=await database.connect(),scope:Scope={wid:randomUUID(),cid:randomUUID(),otherCid:randomUUID(),sid:randomUUID(),otherSid:randomUUID(),revision:randomUUID()};
 const record={workspace_id:scope.wid,case_id:scope.cid,rolled_back:false};scopes.push(record);
 try{
  await tx.query('BEGIN');
  await tx.query('INSERT INTO faultline.workspaces(id,name) VALUES($1,$2)',[scope.wid,'Generated rolled-back metric acceptance '+tag]);
  await seedCase(tx,scope.wid,scope.cid,scope.revision);await seedCase(tx,scope.wid,scope.otherCid,randomUUID());
  await tx.query("INSERT INTO faultline.sources(id,workspace_id,kind,name) VALUES($1,$2,'file',$3),($4,$2,'file',$5)",
   [scope.sid,scope.wid,'Generated primary SQL source',scope.otherSid,'Generated foreign SQL source']);
  await action(tx,scope);
 }finally{
  await tx.query('ROLLBACK');record.rolled_back=true;
  assert.equal((await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1',[scope.wid])).rowCount,0,'Generated workspace must not survive rollback.');
  assert.equal((await tx.query('SELECT event_id FROM faultline.canonical_events WHERE workspace_id=$1',[scope.wid])).rowCount,0,'Generated events must not survive rollback.');
  tx.release();
 }
}
function complete(result:FaultlineMetricResult){
 assert.equal(result.quality,'complete_attested');assert.ok(result.baseline&&result.comparison);
 return {baseline:result.baseline,comparison:result.comparison};
}
function incomplete(result:FaultlineMetricResult,reason:string){
 assert.equal(result.quality,'incomplete');assert.equal(result.reason,reason);
 assert.equal(result.baseline,null);assert.equal(result.comparison,null);assert.equal(result.delta_pp,null);assert.equal(result.relative_change,null);
 assert.equal(computeMixShift(result).status,'inconclusive');
}

test('actual PostgreSQL counted metrics meet independent fixture, microsecond, exclusion, isolation and coverage expectations',{timeout:120000},async()=>{
 const startedAt=new Date().toISOString();
 try{
  const postgres=(await database.query("SELECT version() AS version,current_database() AS database,current_setting('server_encoding') AS encoding")).rows[0];
  assert.equal(postgres.database,'faultline');assert.equal(typeof postgres.encoding,'string');
  for(const name of ['regression','mix-shift'] as const){
   const files=['events.json','metric.json','coverage.json','expected.json','README.md'];
   for(const file of files)inputHashes[`fixtures/${name}/${file}`]=byteHash(await fs.readFile(`fixtures/${name}/${file}`));
   const raw=await read<FaultlineCanonicalEvent[]>(`fixtures/${name}/events.json`),sourceMetric=await read<FaultlineMetric>(`fixtures/${name}/metric.json`),coverage=await read<FaultlineCoverage>(`fixtures/${name}/coverage.json`),expected=await read<Record<string,number>>(`fixtures/${name}/expected.json`);
   await rolledBack(async(tx,scope)=>{
    const events=raw.map(e=>({...e,source_id:scope.sid,occurred_at:normalizeEventTime(e.occurred_at)})),snapshotId=await seedSnapshot(tx,scope,events),metric={...sourceMetric,source_id:scope.sid};
    await runtimeScope(tx,scope);
    const result=await computePostgresComparison(tx,scope.wid,scope.cid,snapshotId,metric,coverage),{baseline,comparison}=complete(result),mix=computeMixShift(result);
    // Counts below come from the README, not either runtime implementation.
    assert.equal(baseline.eligible,1000);assert.equal(comparison.eligible,1000);
    assert.equal(baseline.converted,name==='regression'?200:340);assert.equal(comparison.converted,name==='regression'?110:160);
    const strata=name==='regression'?{baseline:{mobile:[500,100],desktop:[500,100]},comparison:{mobile:[500,10],desktop:[500,100]}}:{baseline:{mobile:[200,20],desktop:[800,320]},comparison:{mobile:[800,80],desktop:[200,80]}};
    for(const [side,summary] of Object.entries({baseline,comparison}) as ['baseline'|'comparison',typeof baseline][])
     for(const cohort of ['mobile','desktop'] as const){const counts=strata[side][cohort];assert.equal(summary.strata[cohort]!.eligible,counts[0]);assert.equal(summary.strata[cohort]!.converted,counts[1]);}
    close(baseline.rate,expected.baseline_rate!);close(comparison.rate,expected.comparison_rate!);close(result.delta_pp,expected.delta_pp!);
    close(baseline.strata.mobile!.rate,expected.mobile_before!);close(comparison.strata.mobile!.rate,expected.mobile_after!);
    close(baseline.strata.desktop!.rate,expected.desktop_before!);close(comparison.strata.desktop!.rate,expected.desktop_after!);
    assert.equal(mix.status,'complete');close(mix.standardized_rate,expected.standardized_rate!);
    close(mix.within_component_pp,expected.within_component_pp!);close(mix.composition_component_pp,expected.composition_component_pp!);
    close(mix.within_component_pp!+mix.composition_component_pp!,expected.delta_pp!);
    assert.ok(mix.limitations.some(text=>/not a causal/i.test(text)),'Mix identity must remain descriptive, not causal.');
    assert.deepEqual(result,computeComparison(events,metric,coverage),'Supplemental pure/SQL equivalence; independent counts above remain authoritative.');
    checks.push({name:`${name} independent exact counts and mix`,scope:{workspace_id:scope.wid,snapshot_id:snapshotId},observed:{result,mix}});
   });
  }

  await rolledBack(async(tx,scope)=>{
   const events:FaultlineCanonicalEvent[]=[],event=(session:string,id:string,name:string,time:string,device='mobile',excluded=false,source=scope.sid)=>{
    const e={source_id:source,event_id:id,session_id:session,event_name:name,occurred_at:normalizeEventTime(time),device,excluded,release_id:null};events.push(e);return e;
   };
   const entry=(session:string,id:string,time:string,device='mobile',excluded=false,source=scope.sid)=>event(session,id,fixtureMetric.entry_event,time,device,excluded,source);
   const success=(session:string,id:string,time:string,device='mobile',excluded=false,source=scope.sid)=>event(session,id,fixtureMetric.success_event,time,device,excluded,source);
   // Deliberately insert later/unexcluded entry first. Earliest selection precedes exclusion.
   entry('earliest-excluded','later-entry','2026-09-01T01:00:00.000002Z','desktop');
   entry('earliest-excluded','first-entry','2026-09-01T01:00:00.000001Z','tablet',true);
   success('earliest-excluded','first-success','2026-09-01T01:01:00.000001Z');
   entry('C-tie-excluded','a-entry','2026-09-01T02:00:00.000001Z','desktop');
   entry('C-tie-excluded','Z-entry','2026-09-01T02:00:00.000001Z','tablet',true);
   success('C-tie-excluded','tie-success','2026-09-01T02:01:00.000001Z');
   // First entry owns the cohort; excluded/device values on success do not replace it.
   entry('entry-device','z-device','2026-09-01T03:00:00.000001Z','desktop');
   entry('entry-device','a-device','2026-09-01T03:00:00.000001Z');
   success('entry-device','device-success','2026-09-01T03:00:00.000001Z','desktop',true);
   entry('inclusive','inclusive-entry','2026-09-01T23:50:00.123456Z');
   success('inclusive','inclusive-success','2026-09-02T00:20:00.123456Z','desktop');
   success('inclusive','second-success','2026-09-02T00:20:00.123456Z');
   entry('one-micro-late','late-entry','2026-09-01T04:00:00.123456Z','desktop');
   success('one-micro-late','late-success','2026-09-01T04:30:00.123457Z');
   entry('before-entry','before-entry','2026-09-01T05:00:00.000001Z');
   success('before-entry','too-early-success','2026-09-01T05:00:00.000000Z');
   entry('source-reuse','source-entry','2026-09-01T06:00:00.000001Z');
   success('source-reuse','source-success','2026-09-01T06:01:00.000001Z','mobile',false,scope.otherSid);
   entry('foreign-only','foreign-entry','2026-09-01T06:10:00.000001Z','tablet',false,scope.otherSid);
   success('foreign-only','foreign-success','2026-09-01T06:11:00.000001Z','tablet',false,scope.otherSid);
   entry('session-entry','session-entry','2026-09-01T07:00:00.000001Z');
   success('different-session','different-session-success','2026-09-01T07:01:00.000001Z');
   entry('snapshot-reuse','snapshot-entry','2026-09-01T08:00:00.000001Z','desktop');
   entry('before-window','outside-before','2026-08-31T23:59:59.999999Z');
   entry('at-start','window-start','2026-09-01T00:00:00.000000Z');
   entry('last-baseline','last-baseline','2026-09-01T23:59:59.999999Z','desktop');
   entry('at-end','window-end','2026-09-02T00:00:00.000000Z');
   success('at-end','window-end-success','2026-09-02T00:00:00.000000Z');
   entry('after-comparison','outside-after','2026-09-03T00:00:00.000000Z');
   entry('later-excluded','eligible-earliest','2026-09-01T11:00:00.000001Z');
   entry('later-excluded','excluded-later','2026-09-01T11:00:00.000002Z','desktop',true);
   success('later-excluded','eligible-success','2026-09-01T11:01:00.000001Z');
   const snapshotId=await seedSnapshot(tx,scope,events);
   const otherEvent={source_id:scope.sid,event_id:'other-snapshot-success',session_id:'snapshot-reuse',event_name:fixtureMetric.success_event,occurred_at:'2026-09-01T08:01:00.000001Z',device:'desktop',excluded:false,release_id:null};
   await seedSnapshot(tx,scope,[otherEvent]);await seedSnapshot(tx,scope,[{...otherEvent,event_id:'other-case-success'}],scope.otherCid);
   const emptySnapshotId=await seedSnapshot(tx,scope,[]);
   await runtimeScope(tx,scope);const metric={...fixtureMetric,source_id:scope.sid};
   const result=await computePostgresComparison(tx,scope.wid,scope.cid,snapshotId,metric,fullCoverage),{baseline,comparison}=complete(result);
   // Ten eligible baseline sessions: first-device, inclusive, late, before, source,
   // session, snapshot, start, last, later-excluded. Only first-device, inclusive,
   // later-excluded convert. Comparison is the exact baseline-end entry, converted.
   assert.equal(baseline.eligible,10);assert.equal(baseline.converted,3);
   assert.equal(baseline.strata.mobile!.eligible,7);assert.equal(baseline.strata.mobile!.converted,3);
   assert.equal(baseline.strata.desktop!.eligible,3);assert.equal(baseline.strata.desktop!.converted,0);
   assert.equal(comparison.eligible,1);assert.equal(comparison.converted,1);
   assert.equal(baseline.unknown_cohort_count,0);assert.equal(comparison.unknown_cohort_count,0);
   const times=(await tx.query(`SELECT event_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact,occurred_at
    FROM faultline.canonical_events WHERE workspace_id=$1 AND snapshot_id=$2 AND event_id IN('late-entry','late-success','inclusive-success') ORDER BY event_id`,[scope.wid,snapshotId])).rows;
   assert.deepEqual(times.map(r=>[r.event_id,r.exact]),[
    ['inclusive-success','2026-09-02T00:20:00.123456Z'],['late-entry','2026-09-01T04:00:00.123456Z'],['late-success','2026-09-01T04:30:00.123457Z']]);
   assert.ok(times.every(r=>typeof r.occurred_at==='string'),'Event instants must not hydrate through millisecond Date.');
   const difference=(await tx.query(`SELECT (extract(epoch FROM (s.occurred_at-e.occurred_at))*1000000)::bigint::text AS micros
    FROM faultline.canonical_events e JOIN faultline.canonical_events s ON s.workspace_id=e.workspace_id AND s.snapshot_id=e.snapshot_id
    WHERE e.workspace_id=$1 AND e.snapshot_id=$2 AND e.event_id='late-entry' AND s.event_id='late-success'`,[scope.wid,snapshotId])).rows[0].micros;
   assert.equal(difference,'1800000001');
   const cOrder=(await tx.query(`SELECT event_id FROM faultline.canonical_events WHERE workspace_id=$1 AND snapshot_id=$2 AND session_id='C-tie-excluded' AND event_name=$3 ORDER BY event_id COLLATE "C"`,[scope.wid,snapshotId,metric.entry_event])).rows.map(r=>r.event_id);
   assert.deepEqual(cOrder,['Z-entry','a-entry']);
   const empty=await computePostgresComparison(tx,scope.wid,scope.cid,emptySnapshotId,metric,fullCoverage),emptyCounts=complete(empty);
   assert.equal(emptyCounts.baseline.eligible,0);assert.equal(emptyCounts.comparison.eligible,0);
   for(const side of [emptyCounts.baseline,emptyCounts.comparison]){assert.equal(side.rate,null);assert.equal(side.interval,null);}
   assert.equal(empty.delta_pp,null);assert.equal(empty.relative_change,null);assert.equal(empty.reason,'known_empty_window');assert.equal(computeMixShift(empty).status,'inconclusive');
   for(const [wid,cid] of [[scope.wid,scope.otherCid],[randomUUID(),scope.cid]]){
    const isolated=complete(await computePostgresComparison(tx,wid!,cid!,snapshotId,metric,fullCoverage));
    assert.equal(isolated.baseline.eligible,0);assert.equal(isolated.comparison.eligible,0);
   }
   checks.push({name:'microseconds, half-open windows, first-entry exclusion/C tie/cohort, inclusive horizon, source/session/snapshot/case/workspace isolation and known empty',scope:{workspace_id:scope.wid,snapshot_id:snapshotId},observed:{result,times:times.map(({event_id,exact})=>({event_id,exact})),late_horizon_micros:difference,c_order:cOrder,empty}});
  });

  await rolledBack(async(tx,scope)=>{
   const e=(id:string,session:string,name:string,time:string,device='mobile'):FaultlineCanonicalEvent=>({source_id:scope.sid,event_id:id,session_id:session,event_name:name,occurred_at:normalizeEventTime(time),device,excluded:false,release_id:null});
   const events=[e('baseline-entry','base',fixtureMetric.entry_event,'2026-09-01T01:00:00.000001Z'),e('baseline-success','base',fixtureMetric.success_event,'2026-09-01T01:01:00.000001Z'),e('comparison-entry','comparison',fixtureMetric.entry_event,'2026-09-02T01:00:00.000001Z'),e('comparison-success','comparison',fixtureMetric.success_event,'2026-09-02T01:01:00.000001Z')];
   const snapshotId=await seedSnapshot(tx,scope,events),unknownId=await seedSnapshot(tx,scope,[...events,e('unknown-cohort','unknown',fixtureMetric.entry_event,'2026-09-02T02:00:00.000001Z','tablet')]);
   await runtimeScope(tx,scope);const metric={...fixtureMetric,source_id:scope.sid};
   const unknown=await computePostgresComparison(tx,scope.wid,scope.cid,unknownId,metric,fullCoverage);incomplete(unknown,'unknown_entry_cohort');
   const coverageCases:{name:string;value:FaultlineCoverage;reason:string}[]=[
    {name:'missing observation tail',value:{...fullCoverage,covered_end:metric.windows.comparison.end},reason:'missing_window_or_observation_tail'},
    {name:'watermark before observation tail',value:{...fullCoverage,event_watermark:metric.windows.comparison.end},reason:'missing_window_or_observation_tail'},
    {name:'event-time coverage hole',value:{...fullCoverage,event_time_intervals:[{start:metric.windows.baseline.start,end:'2026-09-01T12:00:00.000Z'},{start:'2026-09-01T12:01:00.000Z',end:fullCoverage.covered_end!}]},reason:'event_time_coverage_gap'},
    {name:'received-time-only coverage',value:{...fullCoverage,event_time_intervals:[],received_time_intervals:[{start:fullCoverage.covered_start!,end:fullCoverage.covered_end!}]},reason:'event_time_coverage_gap'},
    {name:'partial extraction',value:{...fullCoverage,extraction_status:'partial'},reason:'extraction_not_complete'},
    {name:'no completeness basis',value:{...fullCoverage,basis:'none'},reason:'no_completeness_basis'}
   ];
   const outcomes:{name:string;result:FaultlineMetricResult}[]=[];
   for(const item of coverageCases){const result=await computePostgresComparison(tx,scope.wid,scope.cid,snapshotId,metric,item.value);incomplete(result,item.reason);outcomes.push({name:item.name,result});}
   const provisional=await computePostgresComparison(tx,scope.wid,scope.cid,snapshotId,metric,{...fullCoverage,basis:'lateness_assumption',attestation:'Explicit synthetic clock fixture assumption; not a provider completeness guarantee.',assumptions:['Operator assumes bounded arrival; no live source was contacted.']});
   assert.equal(provisional.quality,'provisional');assert.equal(provisional.basis,'lateness_assumption');
   assert.equal(provisional.baseline!.eligible,1);assert.equal(provisional.baseline!.converted,1);assert.equal(provisional.comparison!.eligible,1);assert.equal(provisional.comparison!.converted,1);
   assert.equal(computeMixShift(provisional).status,'provisional');
   checks.push({name:'unknown cohorts/incomplete tails/holes/received-only/extraction never authoritative; assumptions stay provisional',scope:{workspace_id:scope.wid,snapshot_id:snapshotId},observed:{unknown,outcomes,provisional}});
  });
  await rolledBack(async(tx,scope)=>{
   const metric={...fixtureMetric,source_id:scope.sid};
   const make=(id:string,name:string,time:string,device:string):FaultlineCanonicalEvent=>({source_id:scope.sid,event_id:id,session_id:'same-session-both-windows',event_name:name,occurred_at:normalizeEventTime(time),device,excluded:false,release_id:null});
   const events=[make('baseline-entry',metric.entry_event,'2026-09-01T01:00:00.123456Z','mobile'),make('comparison-entry',metric.entry_event,'2026-09-02T01:00:00.123456Z','desktop')];
   for(let n=0;n<1024;n++)events.push(make('dense-success-'+n,metric.success_event,n<512?'2026-09-01T01:01:00.123456Z':'2026-09-02T01:01:00.123456Z','tablet'));
   const snapshotId=await seedSnapshot(tx,scope,events);await runtimeScope(tx,scope);
   const dense=complete(await computePostgresComparison(tx,scope.wid,scope.cid,snapshotId,metric,fullCoverage));
   for(const side of [dense.baseline,dense.comparison]){assert.equal(side.eligible,1);assert.equal(side.converted,1);assert.equal(side.unknown_cohort_count,0);}
   assert.equal(dense.baseline.strata.mobile!.eligible,1);assert.equal(dense.comparison.strata.desktop!.eligible,1);
   const identical=complete(await computePostgresComparison(tx,scope.wid,scope.cid,snapshotId,{...metric,success_event:metric.entry_event},fullCoverage));
   for(const side of [identical.baseline,identical.comparison]){assert.equal(side.eligible,1);assert.equal(side.converted,1);}
   checks.push({name:'one session in both windows, 1024 successes counted once per window, and identical entry/success names convert at entry timestamp',scope:{workspace_id:scope.wid,snapshot_id:snapshotId},observed:{dense,identical}});
  });
  assert.ok(scopes.every(s=>s.rolled_back));
  await fs.mkdir('reports/application/consolidated',{recursive:true});
  await fs.writeFile(receipt,JSON.stringify({status:'passed',started_at:startedAt,finished_at:new Date().toISOString(),postgres,
   scope:'Actual PostgreSQL transaction-only generated component fixtures; queries executed as forced-RLS faultline_api. Not a product import/API/worker journey.',
   checks,scopes,input_hashes:inputHashes,test_source_sha256:byteHash(await fs.readFile('tests/integration/postgres-metric-counts.test.ts')),
   postgres_counter_source_sha256:byteHash(await fs.readFile('packages/core/src/metrics/postgres.ts')),
   shared_summary_source_sha256:byteHash(await fs.readFile('packages/core/src/metrics/comparison.ts')),
   all_generated_rows_rolled_back:true,private_objects_written:0,services_started:0,external_execution:'not_run',native_runner:'not_run',physical_cleanup:'not_run',
   limitations:['SQL metadata was directly seeded solely inside rolled-back generated transactions; this does not prove import mapping/queue/UI integration or production source completeness.','Mix components are descriptive accounting; aggregate causal effect is not established.']},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('PostgreSQL counted metric acceptance passed; private receipt '+receipt+'.');
 }catch(error){
  await fs.mkdir('reports/application/consolidated',{recursive:true});
  await fs.writeFile(receipt.replace('.json','-failure.json'),JSON.stringify({status:'failed',started_at:startedAt,finished_at:new Date().toISOString(),scopes,checks,input_hashes:inputHashes,error:{name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown'},private_objects_written:0,services_started:0},null,2)+'\n',{flag:'wx',mode:0o600});throw error;
 }finally{await database.end();}
});
