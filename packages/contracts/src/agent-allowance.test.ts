import test from 'node:test';
import assert from 'node:assert/strict';
import {operationBody} from './transport.js';

const ceiling={max_automatic_model_calls:24,max_input_tokens:500000,max_output_tokens:64000};
test('owner policy and preview contracts admit the authorized headroom and tighter disabled values',()=>{
 for(const [operation,wrap] of [['updateWorkspacePolicy',(patch:object)=>patch],['previewPolicyRetention',(patch:object)=>({patch})]] as const){
  const allowed=wrap(ceiling);assert.deepEqual(operationBody(operation,allowed),allowed);
  const disabled=wrap({max_automatic_model_calls:0,max_input_tokens:0,max_output_tokens:0});assert.deepEqual(operationBody(operation,disabled),disabled);
 }
});
test('policy contracts reject excess, nonintegral and counter-reset fields before mutation',()=>{
 for(const [operation,wrap] of [['updateWorkspacePolicy',(patch:object)=>patch],['previewPolicyRetention',(patch:object)=>({patch})]] as const){
  for(const patch of [{max_automatic_model_calls:25},{max_input_tokens:500001},{max_output_tokens:64001},{max_automatic_model_calls:1.5},{calls_spent:0},{reset:true}])assert.throws(()=>operationBody(operation,wrap(patch)),{code:'INVALID_INPUT'});
 }
});
