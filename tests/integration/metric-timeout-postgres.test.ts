import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {computePostgresComparison} from '../../packages/core/src/metrics/postgres.js';
import {DomainError} from '../../packages/core/src/errors.js';

test('actual blocked SQL fails within its resource deadline without publishing counts in the isolated restored database',{timeout:25000},async()=>{
 const restore=JSON.parse(await fs.readFile(process.env.RECOVERED_RESTORE_RECEIPT!,'utf8'));
 assert.equal(restore.status,'isolated_restore_verified');
 const url=new URL(process.env.MIGRATION_DATABASE_URL!);
 assert(['127.0.0.1','localhost'].includes(url.hostname));
 assert.equal(url.pathname,'/'+restore.destination_database);
 assert(/^faultline_restore_[0-9]{13}_[a-f0-9]{8}$/.test(restore.destination_database));
 const locker=new pg.Client({connectionString:url.toString()});
 const readerPool=new pg.Pool({connectionString:url.toString(),max:1});
 let reader:pg.PoolClient|undefined;
 const receipt:any={status:'not_run',at:new Date().toISOString(),database:restore.destination_database,scope:'Injected table-lock delay in a separate restored database with services stopped; no source/main lock or data mutation.'};
 await locker.connect();
 try{
  assert.equal((await locker.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].n,0,'Rehearsal services and other clients must be stopped.');
  const wid='fcb94a07-a649-4530-bb16-d9dda1a39c3d',cid='2fc60630-e764-447f-aa37-403378f8697f';
  const metric=(await locker.query("SELECT value,snapshot_id FROM faultline.metric_versions WHERE workspace_id=$1 AND case_id=$2 AND state='frozen' ORDER BY created_at DESC LIMIT 1",[wid,cid])).rows[0];
  assert(metric?.snapshot_id);
  const snapshot=(await locker.query('SELECT value FROM faultline.snapshots WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,metric.snapshot_id])).rows[0].value;
  const before=Number((await locker.query('SELECT count(*) AS n FROM faultline.comparisons')).rows[0].n);
  await locker.query('BEGIN');
  await locker.query('LOCK TABLE faultline.canonical_events IN ACCESS EXCLUSIVE MODE');
  reader=await readerPool.connect();
  await reader.query('BEGIN');await reader.query('SET LOCAL ROLE faultline_api');
  await reader.query("SELECT set_config('faultline.workspace_id',$1,true)",[wid]);
  const started=performance.now();
  await assert.rejects(computePostgresComparison(reader,wid,cid,metric.snapshot_id,metric.value,snapshot.coverage),(e:unknown)=>e instanceof DomainError&&e.code==='METRIC_QUERY_TIMEOUT');
  receipt.elapsed_ms=performance.now()-started;
  assert(receipt.elapsed_ms>=4500&&receipt.elapsed_ms<15000,'The configured five-second server deadline must be observed with a bounded transport allowance.');
  await reader.query('ROLLBACK');await locker.query('ROLLBACK');
  assert.equal(Number((await locker.query('SELECT count(*) AS n FROM faultline.comparisons')).rows[0].n),before);
  receipt.status='passed';receipt.expected_sql_deadline_ms=5000;receipt.result_returned=false;receipt.comparisons_published=0;
  console.log('Real SQL deadline rejected a blocked query without counts or publication.');
 }catch(e){receipt.status='failed';receipt.error=(e as Error).message;throw e;}
 finally{
  if(reader){await reader.query('ROLLBACK').catch(()=>{});reader.release();}
  await readerPool.end();
  await locker.query('ROLLBACK').catch(()=>{});await locker.end();
  await fs.writeFile('reports/application/consolidated/metric-query-deadline-'+randomUUID()+'.json',JSON.stringify(receipt,null,2));
 }
});
