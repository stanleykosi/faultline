import fs from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ajv, validateContract} from './validate.js';
import {operationBody} from './transport.js';

// validate
test('all 24 canonical draft-2020-12 contracts compile under strict installed Ajv',()=>{
 const files=fs.readdirSync('contracts').filter(f=>f.endsWith('.schema.json'));assert.equal(files.length,24);
 for(const name of files)assert.ok(ajv.getSchema('https://faultline.invalid/contracts/'+name),name);
});
test('model and client cannot provide an extra verified verdict on a canonical metric',()=>{
 const metric=JSON.parse(fs.readFileSync('fixtures/regression/metric.json','utf8'));
 assert.ok(validateContract('metric',metric));assert.throws(()=>validateContract('metric',{...metric,verified:true}));
});

test('model profile requests admit each configured provider and reject undeclared aliases or readiness',()=>{
 for(const provider of ['openrouter','meterless']){
  const input={name:'Investigation model',provider,base_url:provider==='meterless'?'http://127.0.0.1:8088/v1':'https://openrouter.ai/api/v1',model_name:provider==='meterless'?'meterless/auto':'vendor/model',secret_value:'synthetic-private-token'};
  assert.deepEqual(operationBody('createModelProfile',input),input);
  assert.throws(()=>operationBody('createModelProfile',{...input,status:'available'}),{code:'INVALID_INPUT'});
  assert.throws(()=>operationBody('createModelProfile',{...input,provider:'nightshift'}),{code:'INVALID_INPUT'});
 }
});

// agent allowance
const ceiling={max_automatic_model_calls:24,max_input_tokens:500000,max_output_tokens:64000};
test("owner policy contracts bound capacity without counter-reset or nonintegral fields", () => {
 // owner policy and preview contracts admit the authorized headroom and tighter disabled values
 {
  for(const [operation,wrap] of [['updateWorkspacePolicy',(patch:object)=>patch],['previewPolicyRetention',(patch:object)=>({patch})]] as const){
     const allowed=wrap(ceiling);assert.deepEqual(operationBody(operation,allowed),allowed);
     const disabled=wrap({max_automatic_model_calls:0,max_input_tokens:0,max_output_tokens:0});assert.deepEqual(operationBody(operation,disabled),disabled);
    }
 }
 // policy contracts reject excess, nonintegral and counter-reset fields before mutation
 {
  for(const [operation,wrap] of [['updateWorkspacePolicy',(patch:object)=>patch],['previewPolicyRetention',(patch:object)=>({patch})]] as const){
     for(const patch of [{max_automatic_model_calls:25},{max_input_tokens:500001},{max_output_tokens:64001},{max_automatic_model_calls:1.5},{calls_spent:0},{reset:true}])assert.throws(()=>operationBody(operation,wrap(patch)),{code:'INVALID_INPUT'});
    }
 }
});

// import mapping
test("import mapping contracts preserve explicit finite paths and reject unsafe values", () => {
 // generic import accepts explicit finite property paths and preserves literal dotted headers
 {
  const mapping={kind:'analytics',event_id_path:'id',session_id_path:['properties','$session_id'],event_time_path:['meta','at'],event_name_path:'event',device_path:['properties','device'],device_map:[{source_value:'phone',cohort:'mobile'}],precision_policy:'lossless_utc_microseconds'};
    assert.deepEqual(operationBody('saveImportMapping',mapping),mapping);
    const literal={...mapping,session_id_path:'properties.$session_id'};
    assert.equal(operationBody<typeof literal>('saveImportMapping',literal).session_id_path,'properties.$session_id');
    const support={kind:'support',record_id_path:['ticket','id'],text_path:['ticket','text'],event_time_path:['ticket','time']};
    assert.deepEqual(operationBody('saveImportMapping',support),support);
 }
 // unsafe or unbounded path arrays and strings are refused before mapping publication
 {
  const mapping={kind:'analytics',event_id_path:'id',session_id_path:'session',event_time_path:'at',event_name_path:'event',device_path:'device',device_map:[{source_value:'phone',cohort:'mobile'}],precision_policy:'lossless_utc_microseconds'};
    for(const path of [[],['__proto__','session'],['props','constructor'],['prototype'],[1],[''],['x'.repeat(129)],Array(9).fill('next'),'__proto__']){
     assert.throws(()=>operationBody('saveImportMapping',{...mapping,session_id_path:path}),(e:unknown)=>(e as {code?:string}).code==='INVALID_INPUT');
    }
 }
});
