import test from 'node:test';import assert from 'node:assert/strict';import {deterministicJobOutcome} from './outcome.js';import {DomainError} from '../errors.js';
test('only exact bound deterministic follow-up waiting outcome changes durable queue completion',()=>{
 const job={kind:'followup_due',input:{followup_id:'declared-followup'}};
 assert.deepEqual(deterministicJobOutcome(job,{id:'declared-followup',state:'waiting_for_data',result:{counts:null}}),{status:'waiting_for_input',errorCode:'FOLLOWUP_DATA_REQUIRED'});
 assert.deepEqual(deterministicJobOutcome(job,{id:'declared-followup',state:'compared'}),{status:'succeeded',errorCode:null});
 for(const result of [null,[],{id:'other-followup',state:'waiting_for_data'},{id:'declared-followup',state:'verified'},{status:'waiting_for_input'}])assert.throws(()=>deterministicJobOutcome(job,result),(e:unknown)=>e instanceof DomainError&&e.code==='INVALID_WORKER_OUTCOME');
 for(const kind of ['model_proposal','analytic_compute','source_capture'])assert.deepEqual(deterministicJobOutcome({kind,input:{}},{state:'waiting_for_data',status:'verified',id:'untrusted-model-text'}),{status:'succeeded',errorCode:null});
});
