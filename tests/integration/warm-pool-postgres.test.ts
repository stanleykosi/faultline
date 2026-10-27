import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {warmPool} from '../../packages/database/src/warm-pool.js';
import {DomainError} from '../../packages/core/src/errors.js';

type Backend={backend_pid:number;database:string;read_only:string;observed:number};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const code=(error:unknown)=>error instanceof DomainError?error.code:error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.name:'UNKNOWN';

test('actual private read-only PostgreSQL warming retains two idle backends and wrong-password failure releases all slots',{timeout:30000},async()=>{
 const tag=randomUUID(),started=new Date().toISOString(),output=path.resolve('reports/application/consolidated/warm-pool-postgres-'+tag+'.json');
 const receipt:Record<string,unknown>={status:'not_run',started_at:started,scope:'Two explicitly read-only private local PostgreSQL connections; no DDL, data mutation, API/browser/provider/native execution.',checks:[],sql_mutations:0};
 const checks=receipt.checks as Record<string,unknown>[];
 const pools:pg.Pool[]=[],idleErrors:string[]=[];let phase='configuration',failure:unknown;
 try{
  const dev=JSON.parse(await fs.readFile('.runtime/development-config.json','utf8')) as {port:number};
  let local:URL;try{local=new URL(process.env.DATABASE_URL??'');}catch{throw Error('Explicit private local database configuration is required.');}
  assert.ok(['postgres:','postgresql:'].includes(local.protocol)&&['localhost','127.0.0.1','[::1]'].includes(local.hostname));assert.equal(local.port,String(dev.port));assert.equal(local.pathname,'/faultline');assert.equal(local.search,'');assert.equal(local.hash,'');assert.ok(local.username&&local.password);
  if(local.hostname==='localhost')local.hostname='127.0.0.1';
  const pgVersion=(createRequire(import.meta.url)('pg/package.json') as {version:string}).version;assert.equal(pgVersion,'8.16.3');receipt.installed_pg_version=pgVersion;
  const configuration={max:2,min:2,idleTimeoutMillis:50,connectionTimeoutMillis:3000,query_timeout:3000,options:'-c default_transaction_read_only=on -c statement_timeout=3000'};
  const pool=new pg.Pool({...configuration,connectionString:local.toString(),application_name:'faultline-readonly-warm-pool-'+tag});pools.push(pool);pool.on('error',error=>idleErrors.push(code(error)));
  assert.deepEqual({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},{total:0,idle:0,waiting:0},'Minimum retention does not manufacture eagerly established connections.');
  phase='actual_warm';await warmPool(pool,2);assert.deepEqual({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},{total:2,idle:2,waiting:0});
  async function heldBackendProof():Promise<number[]>{
   const connected=await Promise.allSettled([pool.connect(),pool.connect()]),clients=connected.flatMap(value=>value.status==='fulfilled'?[value.value]:[]);
   try{
    assert.equal(clients.length,2);assert.deepEqual({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},{total:2,idle:0,waiting:0});
    const rows=await Promise.all(clients.map(async client=>{const result:pg.QueryResult<Backend>=await client.query<Backend>('SELECT pg_backend_pid() AS backend_pid,current_database() AS database,current_setting(\'default_transaction_read_only\') AS read_only,1 AS observed');assert.equal(result.rows.length,1);const row=result.rows[0];assert.ok(row);assert.equal(row.database,'faultline');assert.equal(row.read_only,'on');assert.equal(row.observed,1);assert.ok(Number.isSafeInteger(row.backend_pid)&&row.backend_pid>0);return row;}));
    const ids=rows.map(row=>row.backend_pid).sort((a,b)=>a-b);assert.equal(new Set(ids).size,2,'Both warmed slots must be distinct real PostgreSQL backends.');return ids;
   }finally{for(const client of clients)client.release();}
  }
  const first=await heldBackendProof();const released=performance.now();await new Promise(resolve=>setTimeout(resolve,200));const idleElapsed=performance.now()-released;assert.ok(idleElapsed>=150,'Observe actual elapsed time well beyond the50ms idle timeout.');
  phase='actual_idle_retention';assert.deepEqual({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},{total:2,idle:2,waiting:0});const afterIdle=await heldBackendProof();assert.deepEqual(afterIdle,first,'Checked-out slots must reuse both retained real backend PIDs, not silently reconnect.');assert.equal(pool.totalCount,2);assert.equal(pool.waitingCount,0);assert.equal(idleErrors.length,0);
  checks.push({name:'Actual warm-up establishes both slots and min2 retains/reuses the exact two PostgreSQL backends after idleTimeout50ms',before_backend_pids:first,after_backend_pids:afterIdle,idle_timeout_ms:50,actual_idle_elapsed_ms:idleElapsed,maximum_total_connections:2,waiting_count:0,read_only:'on'});
  phase='actual_wrong_password';const invalid=new URL(local);invalid.password=randomUUID();assert.notEqual(invalid.password,local.password);
  const bad=new pg.Pool({...configuration,connectionString:invalid.toString(),application_name:'faultline-readonly-warm-reject-'+tag});pools.push(bad);bad.on('error',error=>idleErrors.push(code(error)));
  const rejectedAt=performance.now();await assert.rejects(warmPool(bad,2),error=>error instanceof DomainError&&error.code==='DEPENDENCY_UNAVAILABLE'&&error.status===503);const rejectedElapsed=performance.now()-rejectedAt;
  assert.deepEqual({total:bad.totalCount,idle:bad.idleCount,waiting:bad.waitingCount},{total:0,idle:0,waiting:0});assert.ok(rejectedElapsed<10000,'Authentication rejection must settle within bounded connection timeouts.');
  checks.push({name:'Different generated password for the already verified real configured role rejects warm-up without leaking a slot',expected_error:'DEPENDENCY_UNAVAILABLE',elapsed_ms:rejectedElapsed,total_count:bad.totalCount,idle_count:bad.idleCount,waiting_count:bad.waitingCount,password_written_or_logged:false});
  assert.equal(idleErrors.length,0);phase='close_all_pools';
 }catch(error){failure=error;receipt.status='failed';receipt.failed_phase=phase;receipt.failure={code:code(error),name:error instanceof Error?error.name:'UNKNOWN'};}
 finally{
  const closed=await Promise.allSettled(pools.map(async pool=>{await pool.end();assert.equal(pool.ended,true);assert.deepEqual({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},{total:0,idle:0,waiting:0});return {ended:true,total_count:0,idle_count:0,waiting_count:0};}));receipt.pool_closure=closed.map(result=>result.status==='fulfilled'?result.value:{ended:false,error:code(result.reason)});
  for(const result of closed)if(result.status==='rejected'&&!failure){failure=result.reason;receipt.status='failed';receipt.failed_phase='close_all_pools';receipt.failure={code:code(result.reason)};}
 }
 receipt.status=failure?'failed':'passed';receipt.finished_at=new Date().toISOString();receipt.source_sha256=digest(await fs.readFile(new URL(import.meta.url)));receipt.unit_test_source_sha256=digest(await fs.readFile('packages/database/src/warm-pool.test.ts'));receipt.limits=['Focused read-only pool semantics; this is not an API performance result or startup-listen journey.','Partial-connect/query-failure injection is a separately labelled unit test, not proof of a failed live product dependency.'];
 await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});await fs.writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 if(failure)throw Error('Actual read-only warm-pool acceptance failed; inspect '+output);console.log('Read-only warm-pool retention/authentication failure passed. Receipt '+output);
});
