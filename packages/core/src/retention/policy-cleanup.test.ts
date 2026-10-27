import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanPolicyObjects,type PolicyObjectReceipt} from './policy-cleanup.js';

const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
function journal(rows:PolicyObjectReceipt[]=[]){return new Map(rows.map(row=>[row.object_key,row]));}

test('policy object cleanup skips committed items and records exact unshared removals',async()=>{
 const rows=journal([{object_key:a,status:'removed'}]),calls:string[]=[];
 const result=await cleanPolicyObjects({keys:[a,b],existing:[...rows.values()],sharedKeys:new Set(),remove:async key=>{calls.push(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
 assert.deepEqual(calls,[b]);assert.deepEqual(result,{status:'complete',removed:2,retained_shared:0,failed:0});assert.equal(rows.get(b)?.status,'removed');
});

test('shared bytes are retained explicitly while the scoped resource can finish cleanup',async()=>{
 const rows=journal(),calls:string[]=[];
 const result=await cleanPolicyObjects({keys:[a,b],existing:[],sharedKeys:new Set([a]),remove:async key=>{calls.push(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
 assert.deepEqual(calls,[b]);assert.deepEqual(result,{status:'complete',removed:1,retained_shared:1,failed:0});assert.equal(rows.get(a)?.status,'retained_shared');
});

test('a failed remove stays retryable and does not imply cleanup success',async()=>{
 const rows=journal(),calls:string[]=[];let fail=true;
 const result=await cleanPolicyObjects({keys:[a],existing:[],sharedKeys:new Set(),remove:async key=>{calls.push(key);if(fail)throw Error('synthetic unlink failure');},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
 assert.deepEqual(result,{status:'pending',removed:0,retained_shared:0,failed:1});assert.equal(rows.get(a)?.status,'failed');
 fail=false;
 const retry=await cleanPolicyObjects({keys:[a],existing:[...rows.values()],sharedKeys:new Set(),remove:async key=>{calls.push(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
 assert.deepEqual(retry,{status:'complete',removed:1,retained_shared:0,failed:0});assert.equal(calls.length,2);assert.equal(rows.get(a)?.status,'removed');
});

test('crash after unlink but before journal commit retries safely as already absent',async()=>{
 const rows=journal(),present=new Set([a]);let loseCommit=true,unlinkCalls=0;
 const remove=async(key:string)=>{unlinkCalls++;present.delete(key);};
 const record=async(key:string,status:PolicyObjectReceipt['status'],error_code:string|null)=>{if(status==='removed'&&loseCommit){loseCommit=false;throw Error('synthetic transaction loss after unlink');}rows.set(key,{object_key:key,status,error_code});};
 const first=await cleanPolicyObjects({keys:[a],existing:[],sharedKeys:new Set(),remove,record});
 assert.equal(first.status,'pending');assert.equal(rows.get(a)?.status,'failed');assert.equal(present.has(a),false);
 const second=await cleanPolicyObjects({keys:[a],existing:[...rows.values()],sharedKeys:new Set(),remove:async key=>{unlinkCalls++;present.delete(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
 assert.equal(second.status,'complete');assert.equal(rows.get(a)?.status,'removed');assert.equal(unlinkCalls,2);assert.equal(present.has(a),false);
});

test('malformed, duplicated, and foreign journal objects reject before cleanup',async()=>{
 let calls=0;const remove=async()=>{calls++;};const record=async()=>{};
 await assert.rejects(cleanPolicyObjects({keys:['../private'],existing:[],sharedKeys:new Set(),remove,record}),/exact unique object hashes/);
 await assert.rejects(cleanPolicyObjects({keys:[a,a],existing:[],sharedKeys:new Set(),remove,record}),/exact unique object hashes/);
 await assert.rejects(cleanPolicyObjects({keys:[a],existing:[{object_key:b,status:'removed'}],sharedKeys:new Set(),remove,record}),/journal differs/);
 assert.equal(calls,0);
});
