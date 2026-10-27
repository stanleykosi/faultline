import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedInstallId,isolatedRuntimeScope,isolatedInstallArgument} from './isolated-install.mjs';
const id='c5e38394-3518-4b61-856a-ba5633e717d9';
test('an explicit empty or repeated isolated selector never becomes an absent main-installation selector',()=>{
 assert.equal(isolatedInstallArgument([]),null);
 assert.equal(isolatedInstallArgument(['--isolated-install='+id]),id);
 for(const values of [['--isolated-install='],['--isolated-install'],['--isolated-install='+id,'--isolated-install='+id],['--isolated-install=','--isolated-install='+id]])assert.throws(()=>isolatedInstallArgument(values));
});
const fixture=()=>Object.fromEntries([...Object.entries({DATABASE_URL:'faultline_api',AUTH_DATABASE_URL:'faultline_auth',QUEUE_DATABASE_URL:'faultline_queue',DISPATCHER_DATABASE_URL:'faultline_dispatcher'}).map(([key,role])=>[key,`postgresql://${role}:explicit-unit-secret@127.0.0.1:54329/faultline_clean_1791749254092_c5e38394`]),['APP_ORIGIN','http://localhost:3500'],['PORT','3500'],['RUNNER_MODE','disabled'],['MODEL_PROVIDER','none']]);
test('explicit unit configuration requires the existing isolated installation and all restricted pools',()=>{
 assert.deepEqual(isolatedRuntimeScope(id,fixture(),54329),{database:'faultline_clean_1791749254092_c5e38394',origin:'http://localhost:3500',installation_id:id});
 for(const value of ['../main',id+'/../main',id.toUpperCase(),''])assert.throws(()=>isolatedInstallId(value));
});
test('isolated workload cannot silently fall back to main, another host, operator role or enabled execution',()=>{
 for(const [key,value]of [['DATABASE_URL','postgresql://faultline_api:unit@127.0.0.1:54329/faultline'],['AUTH_DATABASE_URL','postgresql://faultline_operator:unit@127.0.0.1:54329/faultline_clean_1791749254092_c5e38394'],['QUEUE_DATABASE_URL','postgresql://faultline_queue:unit@example.com:54329/faultline_clean_1791749254092_c5e38394'],['DISPATCHER_DATABASE_URL','postgresql://faultline_dispatcher:unit@127.0.0.1:54329/faultline_clean_1791749254092_c5e38394?options=x'],['RUNNER_MODE','trusted_fixture'],['MODEL_PROVIDER','compatible'],['APP_ORIGIN','https://example.com']])assert.throws(()=>isolatedRuntimeScope(id,{...fixture(),[key]:value},54329));
});
test('malformed credential-bearing configuration errors omit input and password sentinels',()=>{
 const sentinel='private-unit-password-must-not-appear';
 for(const value of ['postgresql://user:'+sentinel+'@[broken',sentinel]) {
   let failure;try{isolatedRuntimeScope(id,{...fixture(),DATABASE_URL:value},54329);}catch(error){failure=error;}
   assert.ok(failure);assert.equal(failure.message,'Isolated installation configuration is invalid.');
   assert.equal(String(failure.stack).includes(sentinel),false);assert.equal(failure.cause,undefined);assert.equal(failure.input,undefined);
 }
});
