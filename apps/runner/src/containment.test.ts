import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {containmentDecision} from './containment.js';
import {executionScope} from '../../../packages/core/src/experiments/protocol.js';
test('finite containment never treats cancellation, missing terminal, restart or changed scope as stopped',()=>{
 const scope={nonce:randomUUID(),job_id:randomUUID(),lease_id:randomUUID(),workspace_id:randomUUID(),case_id:randomUUID(),generation:randomUUID()},record={scope,request_hash:'a'.repeat(64),request_nonce:randomUUID()},terminal={version:1 as const,...record,terminal_at:new Date().toISOString(),files:[],unknown_files:0};
 assert.equal(containmentDecision(scope,scope.generation,scope,record,terminal,null).stopped,false);
 assert.equal(containmentDecision(scope,scope.generation,null,record,null,null).state,'containment_unknown');
 assert.equal(containmentDecision(scope,randomUUID(),null,record,null,null).stopped,false);
 assert.equal(containmentDecision(scope,randomUUID(),null,record,terminal,null).stopped,true);
 assert.equal(containmentDecision(scope,scope.generation,null,record,terminal,null).stopped,true);
 assert.throws(()=>containmentDecision({...scope,lease_id:randomUUID()},scope.generation,null,record,terminal,null),/exact/);
 assert.throws(()=>executionScope({...scope,path:'C:\\private'}),/finite fields/);
 const tombstone={version:1 as const,scope,request_hash:record.request_hash,request_nonce:record.request_nonce,terminal_hash:'b'.repeat(64),removed:3,pending:1,at:new Date().toISOString()};assert.equal(containmentDecision(scope,scope.generation,null,null,null,tombstone).state,'cleanup_pending');assert.equal(containmentDecision(scope,scope.generation,null,null,null,{...tombstone,pending:0}).state,'cleaned');
});
