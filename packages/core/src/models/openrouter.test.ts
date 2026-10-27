import test from 'node:test';
import assert from 'node:assert/strict';
import {endpoint,structuredWireBody} from './gateway.js';

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

test('OpenRouter structured calls keep a finite strict schema and output cap',()=>{
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
});

test('other compatible providers retain their original bounded request dialect',()=>{
 const body=structuredWireBody({provider:'openai_compatible',base_url:'https://example.com/v1',model_name:'synthetic/model'},[{role:'user',content:'Synthetic object'}],512,{type:'object'},'test');
 assert.ok('max_completion_tokens' in body);
 assert.equal(body.max_completion_tokens,512);
 assert.equal('reasoning' in body,false);
});
