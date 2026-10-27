import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireDiscardableImport,requireVisibleImport} from './discard-policy.js';
import {expected} from '../workspaces/service.js';
const deps={snapshot:false,activeJob:false};
const fails=(action:()=>unknown,code:string)=>assert.throws(action,(error:unknown)=>error instanceof Error&&'code'in error&&error.code===code);

test('only reviewed pre-capture stages can be logically discarded',()=>{
 for(const stage of ['staged','mapped','review_ready','blocked'])assert.doesNotThrow(()=>requireDiscardableImport({stage,snapshot_id:null,job_id:null},deps));
});
test('queued, accepted, unknown and discarded imports cannot be discarded',()=>{
 for(const stage of ['queued','accepted','running','cancelled','unknown'])fails(()=>requireDiscardableImport({stage},deps),'IMPORT_IMMUTABLE');
 fails(()=>requireDiscardableImport({stage:'discarded'},deps),'NOT_FOUND');
});
test('snapshot and any durable job binding protect otherwise staged imports',()=>{
 fails(()=>requireDiscardableImport({stage:'staged',snapshot_id:'snapshot'},deps),'IMPORT_IMMUTABLE');
 fails(()=>requireDiscardableImport({stage:'mapped',job_id:'completed-job'},deps),'IMPORT_IMMUTABLE');
 fails(()=>requireDiscardableImport({stage:'review_ready'},{...deps,snapshot:true}),'IMPORT_IMMUTABLE');
 fails(()=>requireDiscardableImport({stage:'blocked'},{...deps,activeJob:true}),'IMPORT_IMMUTABLE');
});
test('discarded and absent imports have the same unavailable lookup outcome',()=>{
 for(const record of [null,undefined,{stage:'discarded'}])fails(()=>requireVisibleImport(record),'NOT_FOUND');
 for(const stage of ['staged','queued','accepted'])assert.doesNotThrow(()=>requireVisibleImport({stage}));
});
test('the installed parent-resource revision guard rejects stale review before discard',()=>{
 assert.doesNotThrow(()=>expected('7',7));
 fails(()=>expected('6',7),'STALE_INPUTS');
});
