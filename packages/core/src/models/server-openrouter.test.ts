import test from 'node:test';
import assert from 'node:assert/strict';
import {serverOpenRouter,bindServerModel,serverModelToken,SERVER_MODEL_ACTOR} from './server-openrouter.js';
const wid='11111111-1111-4111-8111-111111111111';
const env={OPENROUTER_API_KEY:'synthetic-key-only',OPENROUTER_MODEL:'provider/selected-model',OPENROUTER_WORKSPACE_ID:wid,AUTH_SECRET:'synthetic-auth-secret-for-tests-only-123456'};
const row=(config:NonNullable<ReturnType<typeof serverOpenRouter>>)=>({id:config.profile_id,workspace_id:wid,profile_hash:config.profile_hash,provider:config.provider,base_url:config.base_url,model_name:config.model_name,created_by:SERVER_MODEL_ACTOR,secret_id:null});
function withEnv(fn:()=>void){const before={...process.env};Object.assign(process.env,env);try{fn();}finally{for(const key of Object.keys(env)){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}}
test('server model is inert without a valid key, model, workspace context and signing secret',()=>{
 assert.equal(serverOpenRouter({}),null);
 for(const field of Object.keys(env)){const incomplete={...env};delete incomplete[field as keyof typeof env];assert.equal(serverOpenRouter(incomplete),null);}
 for(const change of [{OPENROUTER_API_KEY:'key\r\nInjected: header'},{OPENROUTER_MODEL:'invalid model'},{OPENROUTER_WORKSPACE_ID:'all'},{AUTH_SECRET:'short'}])assert.equal(serverOpenRouter({...env,...change}),null);
});
test('immutable profile generation changes for key, model, scope or auth-secret changes',()=>{
 const current=serverOpenRouter(env)!;assert.deepEqual(serverOpenRouter({...env}),current);
 for(const change of [{OPENROUTER_API_KEY:'new-synthetic-key'},{OPENROUTER_MODEL:'provider/other-model'},{OPENROUTER_WORKSPACE_ID:'22222222-2222-4222-8222-222222222222'},{AUTH_SECRET:'other-synthetic-auth-secret-1234567890'}]){const next=serverOpenRouter({...env,...change})!;assert.notEqual(next.profile_id,current.profile_id);assert.notEqual(next.profile_hash,current.profile_hash);}
 assert.doesNotMatch(JSON.stringify({id:current.profile_id,hash:current.profile_hash}),/synthetic-key-only/);
});
test('only the current exact workspace/profile can resolve the runtime key; DTO row carries no key',()=>withEnv(()=>{
 const current=serverOpenRouter()!,bound=bindServerModel(row(current),wid);assert.equal(bound.active_version,null);assert.equal(bound.credential_source,'server');assert.equal(bound.token,undefined);assert.doesNotMatch(JSON.stringify(bound),/synthetic-key-only/);assert.equal(serverModelToken(bound,wid),env.OPENROUTER_API_KEY);
 for(const invalid of [{...bound,id:'22222222-2222-4222-8222-222222222222'},{...bound,workspace_id:'foreign'},{...bound,model_name:'provider/other'},{...bound,secret_id:'stored-secret'},{...bound,profile_hash:'0'.repeat(64)}])assert.throws(()=>bindServerModel(invalid,wid),{code:'SERVER_MODEL_CHANGED'});
 assert.throws(()=>bindServerModel(bound,'22222222-2222-4222-8222-222222222222'),{code:'SERVER_MODEL_CHANGED'});
 process.env.OPENROUTER_API_KEY='new-synthetic-key';assert.throws(()=>serverModelToken(bound,wid),{code:'SERVER_MODEL_CHANGED'});
}));
test('ordinary workspace profiles remain unchanged and never inherit the server credential',()=>withEnv(()=>{
 const ordinary={id:'manual-profile',created_by:'ordinary-owner',secret_id:'encrypted-workspace-key'};assert.equal(bindServerModel(ordinary,wid),ordinary);assert.equal(serverModelToken(ordinary,wid),undefined);
}));

test('blank or absent scope enables independent workspace profiles without accepting foreign rows',()=>withEnv(()=>{
 const other='22222222-2222-4222-8222-222222222222';
 for(const blank of [undefined,'','   ']){
  if(blank===undefined)delete process.env.OPENROUTER_WORKSPACE_ID;else process.env.OPENROUTER_WORKSPACE_ID=blank;
  const first=serverOpenRouter(process.env,wid)!,second=serverOpenRouter(process.env,other)!;assert.ok(first);assert.ok(second);assert.equal(first.workspace_id,wid);assert.equal(second.workspace_id,other);assert.notEqual(first.profile_id,second.profile_id);assert.notEqual(first.profile_hash,second.profile_hash);
  assert.equal(serverModelToken(row(first),wid),env.OPENROUTER_API_KEY);assert.throws(()=>bindServerModel(row(first),other),{code:'SERVER_MODEL_CHANGED'});
 }
 process.env.OPENROUTER_WORKSPACE_ID='invalid-nonblank';assert.equal(serverOpenRouter(process.env,wid),null);
}));
