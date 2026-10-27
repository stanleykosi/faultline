import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {serviceFailureDiagnostic,type PoolSnapshot} from './request-diagnostics.js';

const context={request_id:'safe-request-id',route:'/api/v1/workspaces/:workspaceId/cases',elapsed_ms:32.9};

test('recognizes the exact installed pg-pool acquisition timeouts without emitting their messages',()=>{
 const rootRequire=createRequire(import.meta.url);
 const pgRequire=createRequire(rootRequire.resolve('pg'));
 const installedPool=readFileSync(pgRequire.resolve('pg-pool'),'utf8');
 for(const message of ['timeout exceeded when trying to connect','Connection terminated due to connection timeout']){
  assert.ok(installedPool.includes(`new Error('${message}'`),'The installed pool must still emit the classified exact message.');
  const diagnostic=serviceFailureDiagnostic(new Error(message),{},context);
  assert.equal(diagnostic.failure_class,'pool_acquire_timeout');
  assert.equal('pg_code' in diagnostic,false);
  assert.equal(JSON.stringify(diagnostic).includes(message),false);
  assert.equal(serviceFailureDiagnostic(new Error(`${message}: private database URL`),{},context).failure_class,'unknown');
 }
});

test('known transport codes map to a fixed classification while arbitrary provider codes remain unknown',()=>{
 for(const code of ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','CERT_HAS_EXPIRED']){
  const diagnostic=serviceFailureDiagnostic({code}, {},context);
  assert.equal(diagnostic.failure_class,'connection_transport');
  assert.equal('pg_code' in diagnostic,false);
  assert.equal(JSON.stringify(diagnostic).includes(code),false);
 }
 for(const code of ['MODEL_UNAVAILABLE','PROVIDER_SECRET_TOKEN','TOKEN','ABCDE','23505\n','28p01',12345,null]){
  const diagnostic=serviceFailureDiagnostic({code}, {},context);
  assert.equal(diagnostic.failure_class,'unknown');
  assert.equal('pg_code' in diagnostic,false);
 }
});

test('SQLSTATE is the only error-derived string exposed and is restricted to known PostgreSQL classes',()=>{
 for(const code of ['23505','28P01','08006','40001','57P01','53300','HV00N','P0001','XX000']){
  const diagnostic=serviceFailureDiagnostic({code,message:'private SQL text',detail:'private row'}, {},context);
  assert.equal(diagnostic.failure_class,'postgres_sqlstate');
  assert.equal(diagnostic.pg_code,code);
  assert.match(diagnostic.pg_code!,/^[0-9A-Z]{5}$/);
 }
});

test('all error details and pool configuration secrets are excluded by an independent exact projection',()=>{
 const secret='postgresql://private-user:private-password@private-host/db?token=private-token';
 const failure=Object.assign(new Error(secret),{
  name:secret,code:secret,detail:secret,hint:secret,query:secret,stack:secret,
  cause:{message:secret,code:secret},credentials:secret,url:secret,env:{DATABASE_URL:secret},
  toJSON(){throw Error('Untrusted serialization must never run.');},
 });
 const domain=Object.assign({totalCount:4,idleCount:1,waitingCount:2,options:{max:6,password:secret,connectionString:secret}}, {secret});
 const diagnostic=serviceFailureDiagnostic(failure,{domain,auth:null},context);
 assert.deepEqual(diagnostic,{
  diagnostic:'request_service_failure',request_id:context.request_id,route:context.route,elapsed_ms:32,
  failure_class:'unknown',pools:{domain:{totalCount:4,idleCount:1,waitingCount:2,max:6},auth:null},
 });
 assert.equal(Object.getPrototypeOf(diagnostic),Object.prototype);
 assert.equal(JSON.stringify(diagnostic).includes(secret),false);
 assert.equal(failure.message,secret);
 assert.equal(domain.options.password,secret);
});

test('metrics and trusted context lengths are bounded without coercing arbitrary values',()=>{
 const poison={toString(){throw Error('Do not coerce this value.');},valueOf(){throw Error('Do not coerce this value.');}};
 const invalid={totalCount:Number.POSITIVE_INFINITY,idleCount:-1,waitingCount:Number.NaN,options:{max:poison}} as unknown as PoolSnapshot;
 const diagnostic=serviceFailureDiagnostic(null,{domain:invalid,auth:{totalCount:3.8,idleCount:Number.NEGATIVE_INFINITY,waitingCount:1e20,options:{max:3.8}}},
  {request_id:'r'.repeat(1000),route:'/'.repeat(1000),elapsed_ms:Number.POSITIVE_INFINITY});
 assert.equal(diagnostic.request_id.length,128);
 assert.equal(diagnostic.route.length,256);
 assert.equal(diagnostic.elapsed_ms,2_147_483_647);
 assert.deepEqual(diagnostic.pools,{
  domain:{totalCount:2_147_483_647,idleCount:0,waitingCount:0,max:null},
  auth:{totalCount:3,idleCount:0,waitingCount:2_147_483_647,max:3},
 });
 assert.equal(serviceFailureDiagnostic(null,{}, {...context,elapsed_ms:Number.NaN}).elapsed_ms,0);
 assert.equal(serviceFailureDiagnostic(null,{}, {...context,elapsed_ms:-5}).elapsed_ms,0);
 assert.equal(serviceFailureDiagnostic(null,{domain:{totalCount:0,idleCount:0,waitingCount:0}},context).pools.domain?.max,null);
 assert.doesNotThrow(()=>JSON.stringify(diagnostic));
});

test('unknown exceptions, throwing accessors and nested cause codes stay unknown without escaping the helper',()=>{
 for(const failure of [undefined,null,'timeout exceeded when trying to connect',new Error('read-only unknown failure'),
  {name:'TimeoutError',cause:{code:'23505'}},
  new Proxy({}, {get(){throw Error('secret getter exception');}}),
 ]){
  assert.equal(serviceFailureDiagnostic(failure,{},context).failure_class,'unknown');
 }
 const pool=new Proxy({}, {get(){throw Error('secret pool exception');}}) as PoolSnapshot;
 assert.deepEqual(serviceFailureDiagnostic({}, {domain:pool},context).pools.domain,{totalCount:0,idleCount:0,waitingCount:0,max:null});
});
