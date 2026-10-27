import test from 'node:test';import assert from 'node:assert/strict';import {sessionPseudonym,pseudonymizeRecords} from './identity.js';
test('session pseudonyms join only within the pinned workspace/source policy and hide low-entropy identifiers',()=>{const key=Buffer.alloc(32,7),value=sessionPseudonym(key,'workspace-a','source-a','v1','person@example.test');assert.match(value,/^s_[a-f0-9]{64}$/);assert.equal(value,sessionPseudonym(key,'workspace-a','source-a','v1','person@example.test'));for(const fields of [['workspace-b','source-a','v1'],['workspace-a','source-b','v1'],['workspace-a','source-a','v2']])assert.notEqual(value,sessionPseudonym(key,...fields as [string,string,string],'person@example.test'));assert.throws(()=>sessionPseudonym(Buffer.alloc(31),'workspace-a','source-a','v1','person@example.test'));});
test('owned import buffers consume raw identities with the same finite canonical output as copy mode',()=>{
 const key=Buffer.alloc(32,7),raw=[{event_id:'e1',session_id:'basket',device:'mobile'},{event_id:'e2',session_id:'basket',device:'desktop'},{event_id:'e3',session_id:'other',device:'mobile'}];
 const original=structuredClone(raw),copy=pseudonymizeRecords(key,'workspace-a','source-a','v1',raw);
 assert.deepEqual(raw,original);assert.notEqual(copy,raw);
 assert.equal(copy[0].session_id,copy[1].session_id);assert.notEqual(copy[0].session_id,copy[2].session_id);
 assert(copy.every(e=>/^s_[a-f0-9]{64}$/.test(e.session_id)));assert.deepEqual(copy.map(e=>[e.event_id,e.device]),[['e1','mobile'],['e2','desktop'],['e3','mobile']]);
 const owned=structuredClone(raw);assert.equal(pseudonymizeRecords(key,'workspace-a','source-a','v1',owned,true),owned);assert.deepEqual(owned,copy);
 assert.notEqual(pseudonymizeRecords(key,'workspace-b','source-a','v1',raw)[0].session_id,copy[0].session_id);
 assert.notEqual(pseudonymizeRecords(key,'workspace-a','source-b','v1',raw)[0].session_id,copy[0].session_id);
});
