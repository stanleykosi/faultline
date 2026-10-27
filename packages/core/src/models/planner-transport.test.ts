import test from 'node:test';import assert from 'node:assert/strict';
import {agentWireSchema} from '../agent/service.js';
import {structuredWireBody,modelCompletionDiagnostic,modelJsonDiagnostic} from './gateway.js';
import {ConnectorError} from '../connectors/wire.js';

test('planner wire object alternatives meet strict provider required/property closure',()=>{
 const visit=(value:any)=>{if(!value||typeof value!=='object')return;if(value.type==='object'){assert.equal(value.additionalProperties,false);assert.deepEqual([...(value.required??[])].sort(),Object.keys(value.properties??{}).sort());}if(value.type==='string'){assert.equal(value.minLength,undefined);assert.equal(value.maxLength,undefined);}for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);};
 for(const stage of ['setup','measure','explain','test','report','follow_up'] as const){const schema=agentWireSchema(stage) as any;visit(schema);assert.equal(schema.properties.actions.maxItems,1);if(['explain','report','follow_up'].includes(stage))assert.equal(schema.properties.analysis.properties.hypotheses.maxItems,0);}
});

test('OpenRouter bounded tasks disable optional reasoning and use the supported token cap without changing other providers',()=>{
 const profile={provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model_name:'synthetic-model'},messages=[{role:'system' as const,content:'Synthetic schema check only.'}];
 const planner=structuredWireBody(profile,messages,4000,agentWireSchema('explain'),'faultline_agent_turn') as any;
 assert.deepEqual(planner.reasoning,{effort:'none',exclude:true,enabled:false});assert.deepEqual(planner.provider,{require_parameters:true});assert.equal(planner.max_tokens,4000);assert.equal(planner.max_completion_tokens,undefined);assert.equal(planner.response_format.json_schema.strict,true);
 const proposal=structuredWireBody(profile,messages,4000,{type:'object'},'faultline_proposal') as any;assert.deepEqual(proposal.reasoning,{effort:'none',exclude:true,enabled:false});assert.equal(proposal.max_tokens,4000);assert.equal(proposal.max_completion_tokens,undefined);assert.deepEqual(proposal.provider,{require_parameters:true});
});

test('malformed JSON diagnostics expose only bounded shape and never response text or arbitrary errors',()=>{
 const privateText='PRIVATE_MODEL_TEXT',bytes=Buffer.from('```json\n{"text":"'+privateText+'"}\n```'),error=new ConnectorError('INVALID_PROVIDER_JSON',privateText);
 const diagnostic=modelJsonDiagnostic('faultline_agent_turn','content',bytes,error);
 assert.deepEqual(diagnostic,{event:'model_json_rejected',schemaName:'faultline_agent_turn',location:'content',code:'INVALID_PROVIDER_JSON',bytes:bytes.length,starts_object:false,ends_object:false,markdown_fence:true});assert.ok(!JSON.stringify(diagnostic).includes(privateText));
 assert.equal(modelJsonDiagnostic(privateText,'envelope',bytes,error),null);assert.equal(modelJsonDiagnostic('faultline_agent_turn','content',bytes,new Error(privateText)),null);
});

test('completion diagnostics retain finite reason and numeric usage without provider prose or unknown schema names',()=>{
 const secret='PRIVATE_RESPONSE_TEXT';
 assert.deepEqual(modelCompletionDiagnostic('faultline_agent_turn','length',{completion_tokens_details:{reasoning_tokens:3800}},secret),{event:'model_completion_rejected',schemaName:'faultline_agent_turn',finish_reason:'length',reported_reasoning:3800,content_bytes:Buffer.byteLength(secret)});
 const safe=modelCompletionDiagnostic('faultline_agent_turn',secret,{completion_tokens_details:{reasoning_tokens:secret}},secret);
 assert.equal(safe?.finish_reason,'unknown');assert.equal(safe?.reported_reasoning,null);assert.ok(!JSON.stringify(safe).includes(secret));assert.equal(modelCompletionDiagnostic(secret,'length',{},secret),null);
});
