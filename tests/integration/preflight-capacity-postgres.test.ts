import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {createHash} from 'node:crypto';import pg from 'pg';
const development=JSON.parse(await fs.readFile('.runtime/development-config.json','utf8'));
const connect=(key:string)=>{const url=new URL(process.env[key]!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,String(development.port));assert.equal(url.pathname,'/faultline');return new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:3000,query_timeout:5000,options:'-c default_transaction_read_only=on'});};
test('installed capacity observation is read-only, exact, checksum-bound and unavailable to non-API runtime roles',{timeout:15000},async()=>{
 const api=connect('DATABASE_URL'),proof=connect('MIGRATION_DATABASE_URL'),denied=[connect('AUTH_DATABASE_URL'),connect('QUEUE_DATABASE_URL'),connect('DISPATCHER_DATABASE_URL')];
 try {
  const applied=(await proof.query("SELECT checksum FROM faultline.schema_migrations WHERE id='0022-readonly-preflight-capacity'")).rows[0];assert.equal(applied.checksum,createHash('sha256').update(await fs.readFile('packages/database/migrations/0022-readonly-preflight-capacity.sql')).digest('hex'));
  assert.equal((await api.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
  const actual=Number((await api.query('SELECT faultline.preflight_active_runs()::text AS active')).rows[0].active);
  const expected=Number((await proof.query("SELECT ((SELECT count(*) FROM faultline.jobs WHERE status IN('queued','running','cancel_requested'))+(SELECT count(*) FROM faultline.provider_operations WHERE status IN('queued','running','cancel_requested')))::text AS active")).rows[0].active);assert.equal(actual,expected);
  const metadata=(await proof.query("SELECT p.prosecdef,p.provolatile,p.pronargs,p.proconfig,r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='faultline.preflight_active_runs()'::regprocedure")).rows[0];assert.equal(metadata.prosecdef,true);assert.equal(metadata.provolatile,'s');assert.equal(metadata.pronargs,0);assert.equal(metadata.owner,'faultline_authority');assert.ok(metadata.proconfig.includes('search_path=pg_catalog, faultline'));
  for(const pool of denied)await assert.rejects(pool.query('SELECT faultline.preflight_active_runs()'),(error:any)=>error.code==='42501');
  const after=Number((await api.query('SELECT faultline.preflight_active_runs()::text AS active')).rows[0].active);assert.equal(after,actual,'Read-only observation must not admit a job.');
 }finally{await Promise.all([api.end(),proof.end(),...denied.map(pool=>pool.end())]);}
});
