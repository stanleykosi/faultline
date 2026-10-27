import {test} from 'node:test';
import assert from 'node:assert/strict';
import {endpoint, structuredWireBody, modelCompletionDiagnostic, modelJsonDiagnostic} from './gateway.js';
import {agentWireSchema} from '../agent/service.js';
import {ConnectorError} from '../connectors/wire.js';
import {serverOpenRouter, bindServerModel, serverModelToken, SERVER_MODEL_ACTOR} from './server-openrouter.js';
import {serverMeterless,currentServerModelIds,SERVER_MODEL_ACTORS,SERVER_METERLESS_ACTOR} from './server-openrouter.js';
import {normalizeMeterlessProfile,validMeterlessToken,METERLESS_BASE_URL} from './meterless-profile.js';
import {normalizeModelProfileInput} from './service.js';

// openrouter
test('OpenRouter uses its exact reviewed OpenAI-compatible route',()=>{
 const before=process.env.MODEL_ALLOWED_ORIGINS;
 process.env.MODEL_ALLOWED_ORIGINS=JSON.stringify(['https://openrouter.ai']);
 try{
  const profile={provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model_name:'openai/gpt-4o'};
  assert.deepEqual(endpoint(profile),{origin:'https://openrouter.ai',url:'https://openrouter.ai/api/v1/chat/completions',local:false});
  assert.throws(()=>endpoint({...profile,base_url:'https://openrouter.ai/v1'}),/exact supported API dialect/);
  assert.throws(()=>endpoint({...profile,base_url:'https://example.com/api/v1'}),/register this exact model origin/);
 }finally{
  if(before===undefined)delete process.env.MODEL_ALLOWED_ORIGINS;
  else process.env.MODEL_ALLOWED_ORIGINS=before;
 }
});

test("provider dialects preserve strict schemas and their supported finite output caps", () => {
 // OpenRouter structured calls keep a finite strict schema and output cap
 {
  const body=structuredWireBody(
     {provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model_name:'openai/gpt-4o'},
     [{role:'user',content:'Return the bounded object.'}],
     512,
     {type:'object',additionalProperties:false,properties:{message:{type:'string'}},required:['message']},
     'faultline_agent_turn',
    );
    assert.ok('max_tokens' in body && 'response_format' in body && 'reasoning' in body);
    assert.equal(body.stream,false);
    assert.equal(body.max_tokens,512);
    assert.deepEqual(body.reasoning,{effort:'none',exclude:true,enabled:false});
    assert.equal(body.response_format.json_schema.name,'faultline_agent_turn');
    assert.equal(body.response_format.json_schema.strict,true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties,false);
    assert.deepEqual((body as any).provider,{require_parameters:true});assert.equal('max_completion_tokens' in body,false);
    for(const name of ['faultline_agent_turn','faultline_proposal']){const request=structuredWireBody({provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model_name:'synthetic-model'},[],4000,agentWireSchema('explain'),name) as any;assert.equal(request.max_tokens,4000);assert.deepEqual(request.reasoning,body.reasoning);assert.deepEqual(request.provider,(body as any).provider);}
 }
 // other compatible providers retain their original bounded request dialect
 {
  const body=structuredWireBody({provider:'openai_compatible',base_url:'https://example.com/v1',model_name:'synthetic/model'},[{role:'user',content:'Synthetic object'}],512,{type:'object'},'test');
    assert.ok('max_completion_tokens' in body);
    assert.equal(body.max_completion_tokens,512);
    assert.equal('reasoning' in body,false);
 }
});

// planner transport
test('planner wire object alternatives meet strict provider required/property closure',()=>{
 const visit=(value:any)=>{if(!value||typeof value!=='object')return;if(value.type==='object'){assert.equal(value.additionalProperties,false);assert.deepEqual([...(value.required??[])].sort(),Object.keys(value.properties??{}).sort());}if(value.type==='string'){assert.equal(value.minLength,undefined);assert.equal(value.maxLength,undefined);}for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);};
 for(const stage of ['setup','measure','explain','test','report','follow_up'] as const){const schema=agentWireSchema(stage) as any;visit(schema);assert.equal(schema.properties.actions.maxItems,1);if(['explain','report','follow_up'].includes(stage))assert.equal(schema.properties.analysis.properties.hypotheses.maxItems,0);}
});

test("provider diagnostics expose only bounded shape, reasons and usage", () => {
 // malformed JSON diagnostics expose only bounded shape and never response text or arbitrary errors
 {
  const privateText='PRIVATE_MODEL_TEXT',bytes=Buffer.from('```json\n{"text":"'+privateText+'"}\n```'),error=new ConnectorError('INVALID_PROVIDER_JSON',privateText);
    const diagnostic=modelJsonDiagnostic('faultline_agent_turn','content',bytes,error);
    assert.deepEqual(diagnostic,{event:'model_json_rejected',schemaName:'faultline_agent_turn',location:'content',code:'INVALID_PROVIDER_JSON',bytes:bytes.length,starts_object:false,ends_object:false,markdown_fence:true});assert.ok(!JSON.stringify(diagnostic).includes(privateText));
    assert.equal(modelJsonDiagnostic(privateText,'envelope',bytes,error),null);assert.equal(modelJsonDiagnostic('faultline_agent_turn','content',bytes,new Error(privateText)),null);
 }
 // completion diagnostics retain finite reason and numeric usage without provider prose or unknown schema names
 {
  const secret='PRIVATE_RESPONSE_TEXT';
    assert.deepEqual(modelCompletionDiagnostic('faultline_agent_turn','length',{completion_tokens_details:{reasoning_tokens:3800}},secret),{event:'model_completion_rejected',schemaName:'faultline_agent_turn',finish_reason:'length',reported_reasoning:3800,content_bytes:Buffer.byteLength(secret)});
    const safe=modelCompletionDiagnostic('faultline_agent_turn',secret,{completion_tokens_details:{reasoning_tokens:secret}},secret);
    assert.equal(safe?.finish_reason,'unknown');assert.equal(safe?.reported_reasoning,null);assert.ok(!JSON.stringify(safe).includes(secret));assert.equal(modelCompletionDiagnostic(secret,'length',{},secret),null);
 }
});

// server openrouter
const wid='11111111-1111-4111-8111-111111111111';
const env={OPENROUTER_API_KEY:'synthetic-key-only',OPENROUTER_MODEL:'provider/selected-model',OPENROUTER_WORKSPACE_ID:wid,AUTH_SECRET:'synthetic-auth-secret-for-tests-only-123456'};
const row=(config:NonNullable<ReturnType<typeof serverOpenRouter>>)=>({id:config.profile_id,workspace_id:wid,profile_hash:config.profile_hash,provider:config.provider,base_url:config.base_url,model_name:config.model_name,created_by:SERVER_MODEL_ACTOR,secret_id:null});
function withEnv(fn:()=>void){const before={...process.env};Object.assign(process.env,env);try{fn();}finally{for(const key of Object.keys(env)){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}}
test("server profiles require complete configuration and bind immutable credential generation", () => {
 // server model is inert without a valid key, model, workspace context and signing secret
 {
  assert.equal(serverOpenRouter({}),null);
    for(const field of Object.keys(env)){const incomplete={...env};delete incomplete[field as keyof typeof env];assert.equal(serverOpenRouter(incomplete),null);}
    for(const change of [{OPENROUTER_API_KEY:'key\r\nInjected: header'},{OPENROUTER_MODEL:'invalid model'},{OPENROUTER_WORKSPACE_ID:'all'},{AUTH_SECRET:'short'}])assert.equal(serverOpenRouter({...env,...change}),null);
 }
 // immutable profile generation changes for key, model, scope or auth-secret changes
 {
  const current=serverOpenRouter(env)!;assert.deepEqual(serverOpenRouter({...env}),current);
    for(const change of [{OPENROUTER_API_KEY:'new-synthetic-key'},{OPENROUTER_MODEL:'provider/other-model'},{OPENROUTER_WORKSPACE_ID:'22222222-2222-4222-8222-222222222222'},{AUTH_SECRET:'other-synthetic-auth-secret-1234567890'}]){const next=serverOpenRouter({...env,...change})!;assert.notEqual(next.profile_id,current.profile_id);assert.notEqual(next.profile_hash,current.profile_hash);}
    assert.doesNotMatch(JSON.stringify({id:current.profile_id,hash:current.profile_hash}),/synthetic-key-only/);
 }
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

test('Meterless URL normalization separates connect credentials and rejects ambiguous or unsafe URLs',()=>{
 for(const value of ['127.0.0.1:8088','http://127.0.0.1:8088/','http://127.0.0.1:8088/v1','http://127.0.0.1:8088/v1/','127.0.0.1:8088/v1/chat/completions','127.0.0.1:8088/v1/models','127.0.0.1:8088/healthz'])assert.deepEqual(normalizeMeterlessProfile(value),{base_url:METERLESS_BASE_URL});
 const connected=normalizeMeterlessProfile('http://127.0.0.1:8088/connect#k=synthetic-runtime-token');assert.deepEqual(connected,{base_url:METERLESS_BASE_URL,token:'synthetic-runtime-token'});assert.ok(!connected.base_url.includes('#'));
 for(const value of ['http://user:password@127.0.0.1:8088/v1','http://127.0.0.1:8088/v1/v1','http://127.0.0.1:8088/v1?key=secret','http://127.0.0.1:8088/v1#k=secret','http://127.0.0.1:8088/connect#k=rt-local','http://127.0.0.1:8088/connect#k=one&k=two','file:///v1'])assert.throws(()=>normalizeMeterlessProfile(value));
 assert.throws(()=>normalizeMeterlessProfile('http://127.0.0.1:8088/connect#k=first','second'));
 for(const token of [undefined,'','rt-local','token\r\nheader','token with spaces'])assert.equal(validMeterlessToken(token),false);
 const profile=normalizeModelProfileInput({name:'Nightshift',provider:'meterless',base_url:'127.0.0.1:8088/connect#k=synthetic-runtime-token',model_name:'meterless/novel.mode'});assert.equal(profile.base_url,METERLESS_BASE_URL);assert.equal(profile.secret_value,'synthetic-runtime-token');
 assert.throws(()=>normalizeModelProfileInput({...profile,secret_value:undefined}),{code:'INVALID_MODEL_CREDENTIAL'});
 const before=process.env.MODEL_LOCAL_ORIGINS;process.env.MODEL_LOCAL_ORIGINS='[]';try{assert.throws(()=>endpoint({...profile,token:profile.secret_value}),{code:'MODEL_ENDPOINT_NOT_APPROVED'});}finally{if(before===undefined)delete process.env.MODEL_LOCAL_ORIGINS;else process.env.MODEL_LOCAL_ORIGINS=before;}
});

test('Meterless structured dialect preserves string messages, exact schema and max_tokens cap',()=>{
 const body=structuredWireBody({provider:'meterless',base_url:METERLESS_BASE_URL,model_name:'meterless/auto'},[{role:'user',content:'Plain text stays a string.'}],256,{type:'object',additionalProperties:false,properties:{text:{type:'string'}},required:['text']},'test') as any;
 assert.equal(body.messages[0].content,'Plain text stays a string.');assert.equal(body.max_tokens,256);assert.equal(body.max_completion_tokens,undefined);assert.equal(body.reasoning,undefined);assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.response_format.json_schema.schema.additionalProperties,false);
});

test('OpenRouter and Nightshift server profiles coexist with isolated credentials and immutable generations',async()=>{
 const meterless={METERLESS_RUNTIME_TOKEN:'synthetic-runtime-token',METERLESS_MODEL:'meterless/auto',METERLESS_BASE_URL:METERLESS_BASE_URL,METERLESS_WORKSPACE_ID:wid},keys=[...Object.keys(env),...Object.keys(meterless)],before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));Object.assign(process.env,env,meterless);
 try{
  const router=serverOpenRouter()!,runtime=serverMeterless()!,runtimeRow={...row(router),id:runtime.profile_id,provider:runtime.provider,base_url:runtime.base_url,model_name:runtime.model_name,profile_hash:runtime.profile_hash,created_by:SERVER_METERLESS_ACTOR};
  assert.deepEqual(currentServerModelIds(wid),[router.profile_id,runtime.profile_id]);assert.equal(SERVER_MODEL_ACTORS.length,2);assert.notEqual(router.profile_id,runtime.profile_id);assert.equal(serverModelToken(runtimeRow,wid),meterless.METERLESS_RUNTIME_TOKEN);assert.equal(serverModelToken(row(router),wid),env.OPENROUTER_API_KEY);assert.equal(bindServerModel(runtimeRow,wid).token,undefined);
  for(const change of [{METERLESS_RUNTIME_TOKEN:'another-token'},{METERLESS_MODEL:'meterless/deep'},{METERLESS_BASE_URL:'http://127.0.0.1:8090/v1'}])assert.notEqual(serverMeterless({...env,...meterless,...change})!.profile_id,runtime.profile_id);
  for(const change of [{METERLESS_RUNTIME_TOKEN:'rt-local'},{METERLESS_MODEL:'ordinary/model'},{METERLESS_BASE_URL:'http://127.0.0.1:8088/connect#k=synthetic-runtime-token'},{METERLESS_WORKSPACE_ID:'invalid'}])assert.equal(serverMeterless({...env,...meterless,...change}),null);
  process.env.METERLESS_RUNTIME_TOKEN='rotated-runtime-token';assert.throws(()=>bindServerModel(runtimeRow,wid),{code:'SERVER_MODEL_CHANGED'});assert.equal(serverModelToken(row(router),wid),env.OPENROUTER_API_KEY);
 }finally{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}
});
