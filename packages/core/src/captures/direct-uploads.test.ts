import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeUploadClaim,decodeUploadClaim,validateUploadInput,verifyUploadBytes} from './direct-uploads.js';
const wid='11111111-1111-4111-8111-111111111111',caseId='22222222-2222-4222-8222-222222222222',uploadId='33333333-3333-4333-8333-333333333333';
const bytes=Buffer.from('a synthetic source'),sha256=createHash('sha256').update(bytes).digest('hex');
const claim={version:1 as const,wid,pid:'synthetic-actor',caseId,uploadId,expires_at:2000,kind:'analytics' as const,name:'events.jsonl',size_bytes:bytes.length,sha256};
test('signed upload binds exact person, workspace, case and finite expiry',()=>{
 const token=encodeUploadClaim(claim);assert.deepEqual(decodeUploadClaim(token,wid,claim.pid,caseId,1000),claim);
 for(const [workspace,person,caseIdentity,time] of [[wid,'other',caseId,1000],['foreign',claim.pid,caseId,1000],[wid,claim.pid,'other',1000],[wid,claim.pid,caseId,2000]] as const)assert.throws(()=>decodeUploadClaim(token,workspace,person,caseIdentity,time));
 assert.throws(()=>decodeUploadClaim(token+'x',wid,claim.pid,caseId,1000));
 assert.deepEqual(decodeUploadClaim(token,wid,claim.pid,caseId,3000,true),claim,'expired authentic receipts can only be looked up; acceptance separately rejects new expired work');
});
test('direct upload rejects unknown fields, unsafe filenames, unsupported types and oversized bytes',()=>{
 const {kind,name,size_bytes,sha256}=claim,valid={kind,name,size_bytes,sha256};assert.deepEqual(validateUploadInput(valid),valid);
 for(const value of [{...valid,url:'https://attacker.invalid'},{...valid,name:'../events.json'},{...valid,name:'script.js'},{...valid,size_bytes:0},{...valid,size_bytes:52428801},{...valid,source_id:'foreign'}])assert.throws(()=>validateUploadInput(value));
});
test('independent expected hash and exact size must pass at EOF before upload publication',async()=>{
 async function* source(){yield bytes.subarray(0,3);yield bytes.subarray(3);}
 async function drain(hash:string,size:number){const output=[];for await(const part of verifyUploadBytes(source(),hash,size))output.push(part);return Buffer.concat(output);}
 assert.deepEqual(await drain(sha256,bytes.length),bytes);
 await assert.rejects(()=>drain('0'.repeat(64),bytes.length),{code:'UPLOAD_CONTENT_MISMATCH'});
 await assert.rejects(()=>drain(sha256,bytes.length-1),{code:'BYTE_LIMIT'});
 await assert.rejects(()=>drain(sha256,bytes.length+1),{code:'UPLOAD_CONTENT_MISMATCH'});
});
