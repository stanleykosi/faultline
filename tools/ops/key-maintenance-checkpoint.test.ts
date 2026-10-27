import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {byteHash} from '../../packages/core/src/canonical.js';
import {open,seal} from '../../packages/core/src/secrets/keyring.js';
import {completeReencryptionBatch,completeReencryptionOperation,stageReencryptionBatch,startReencryptionCheckpoint,validateCheckpointResume,verifyReencryptionCheckpoint,type CheckpointEnvelope} from './key-maintenance-checkpoint.js';

const active='active-v2',old='old-v1';
function fixture(){
 const ring={active:active,keys:{[old]:randomBytes(32).toString('base64'),[active]:randomBytes(32).toString('base64')}},oldRing={active:old,keys:{[old]:ring.keys[old]!}},rows:CheckpointEnvelope[]=[];
 for(let index=0;index<3;index++){const identity=`secret:generated-workspace:${String(index).padStart(2,'0')}`,aad=`generated-workspace:generated-secret:${index}`;rows.push({identity,aad,key_version:old,ciphertext:seal(`synthetic credential ${index}`,aad,oldRing)});}
 const key=Buffer.from(ring.keys[active]!,'base64'),plaintextHash=(row:CheckpointEnvelope)=>byteHash(Buffer.from(open(row.ciphertext,row.aad,ring)));
 return {ring,key,rows,plaintextHash};
}
function commitBatch(rows:CheckpointEnvelope[],batch:CheckpointEnvelope[],ring:{active:string;keys:Record<string,string>}){
 const old=Object.fromEntries(batch.map(row=>{const envelope=JSON.parse(row.ciphertext) as {key_version:string};return [envelope.key_version,ring.keys[envelope.key_version]!] }));
 return rows.map(row=>batch.some(item=>item.identity===row.identity)?{...row,key_version:ring.active,ciphertext:seal(open(row.ciphertext,row.aad,{active:JSON.parse(row.ciphertext).key_version,keys:old}),row.aad,ring)}:row);
}

test('checkpointed batches sign exact inventory and advance only after the batch commits',()=>{
 const f=fixture(),started=startReencryptionCheckpoint({operation_id:randomUUID(),active_key_version:active,rows:f.rows,now:'2026-10-14T00:00:00.000Z'},f.key);
 assert.equal(verifyReencryptionCheckpoint(started,f.key,active).remaining_hash,started.remaining_hash);
 const first=f.rows.slice(0,2),remaining=f.rows.slice(2),staged=stageReencryptionBatch(started,first,remaining,f.plaintextHash,f.key,'2026-10-14T00:01:00.000Z');
 assert.deepEqual(validateCheckpointResume(staged,f.rows,active,f.plaintextHash).stagedRows.map(row=>row.identity),first.map(row=>row.identity));
 assert.deepEqual(validateCheckpointResume(staged,f.rows,active,f.plaintextHash).remainingRows.map(row=>row.identity),remaining.map(row=>row.identity));
 const committed=commitBatch(f.rows,first,f.ring),next=completeReencryptionBatch(staged,{rewritten:2,already_current:0},committed,f.key,'2026-10-14T00:02:00.000Z');
 assert.equal(next.cursor,first.at(-1)?.identity);assert.equal(next.rewritten,2);assert.notEqual(next.remaining_hash,started.remaining_hash);assert.equal(validateCheckpointResume(next,committed,active,f.plaintextHash).remainingRows.length,1);
});

test('restart recovers a database commit that happened before the checkpoint cursor advanced',()=>{
 const f=fixture(),started=startReencryptionCheckpoint({operation_id:randomUUID(),active_key_version:active,rows:f.rows},f.key),source=f.rows.slice(0,2),remaining=f.rows.slice(2),staged=stageReencryptionBatch(started,source,remaining,f.plaintextHash,f.key);
 const committed=f.rows.map(row=>source.some(item=>item.identity===row.identity)?{...row,key_version:active,ciphertext:seal(open(row.ciphertext,row.aad,{active:old,keys:{[old]:f.ring.keys[old]!}}),row.aad,f.ring)}:row);
 const resumed=validateCheckpointResume(staged,committed,active,f.plaintextHash);assert.equal(resumed.stagedRows.every(row=>row.key_version===active),true);
 const next=completeReencryptionBatch(staged,{rewritten:2,already_current:0},committed,f.key);assert.equal(next.rewritten,2);assert.equal(validateCheckpointResume(next,committed,active,f.plaintextHash).remainingRows.length,1);
});

test('pre-commit crash remains retryable and altered or unauthenticated state blocks resume',()=>{
 const f=fixture(),started=startReencryptionCheckpoint({operation_id:randomUUID(),active_key_version:active,rows:f.rows},f.key),staged=stageReencryptionBatch(started,f.rows.slice(0,1),f.rows.slice(1),f.plaintextHash,f.key);
 assert.equal(validateCheckpointResume(staged,f.rows,active,f.plaintextHash).stagedRows[0]?.key_version,old);
 const changed=f.rows.map((row,index)=>index===2?{...row,ciphertext:seal('changed generated credential',row.aad,f.ring),key_version:active}:row);
 assert.throws(()=>validateCheckpointResume(staged,changed,active,f.plaintextHash),/Unprocessed envelopes changed/);
 const first=f.rows.slice(0,1),afterFirst=commitBatch(f.rows,first,f.ring),committedCheckpoint=completeReencryptionBatch(stageReencryptionBatch(started,first,f.rows.slice(1),f.plaintextHash,f.key),{rewritten:1,already_current:0},afterFirst,f.key),alteredProcessed=afterFirst.map(row=>row.identity===first[0]!.identity?{...row,ciphertext:seal('altered after committed batch',row.aad,f.ring)}:row);
 assert.throws(()=>validateCheckpointResume(committedCheckpoint,alteredProcessed,active,f.plaintextHash),/committed envelope changed/);
 const forged={...staged,remaining_hash:'f'.repeat(64)};assert.throws(()=>verifyReencryptionCheckpoint(forged,f.key,active),/authentication failed/);
 assert.throws(()=>verifyReencryptionCheckpoint(staged,f.key,old),/different active key version/);
});

test('completed checkpoint is explicit and cannot hide remaining old-key envelopes',()=>{
 const f=fixture(),started=startReencryptionCheckpoint({operation_id:randomUUID(),active_key_version:active,rows:[]},f.key);
 const complete=completeReencryptionOperation(started,[],f.key,'2026-10-14T00:03:00.000Z');assert.equal(complete.status,'complete');assert.equal(complete.completed_at,'2026-10-14T00:03:00.000Z');
 assert.equal(verifyReencryptionCheckpoint(complete,f.key,active).status,'complete');
 assert.throws(()=>completeReencryptionOperation(startReencryptionCheckpoint({operation_id:randomUUID(),active_key_version:active,rows:f.rows},f.key),f.rows,f.key),/exact inventory is exhausted/);
});
