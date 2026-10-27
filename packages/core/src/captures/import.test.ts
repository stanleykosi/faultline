import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeUploadClaim, decodeUploadClaim, validateUploadInput, verifyUploadBytes} from './direct-uploads.js';
import {requireDiscardableImport, requireVisibleImport} from './discard-policy.js';
import {expected} from '../workspaces/service.js';
import {setImmediate as nextTurn, setTimeout as delay} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {bufferedJsonNamespace, sniffSourceNamespace} from './import-stream.js';
import {DEFAULT_IMPORT_LIMITS} from '../imports/parser.js';

// direct uploads
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

// discard policy
const deps={snapshot:false,activeJob:false};
const fails=(action:()=>unknown,code:string)=>assert.throws(action,(error:unknown)=>error instanceof Error&&'code'in error&&error.code===code);

test("discard is limited to visible unbound staged imports under current revision", () => {
 // only reviewed pre-capture stages can be logically discarded
 {
  for(const stage of ['staged','mapped','review_ready','blocked'])assert.doesNotThrow(()=>requireDiscardableImport({stage,snapshot_id:null,job_id:null},deps));
 }
 // queued, accepted, unknown and discarded imports cannot be discarded
 {
  for(const stage of ['queued','accepted','running','cancelled','unknown'])fails(()=>requireDiscardableImport({stage},deps),'IMPORT_IMMUTABLE');
    fails(()=>requireDiscardableImport({stage:'discarded'},deps),'NOT_FOUND');
 }
 // snapshot and any durable job binding protect otherwise staged imports
 {
  fails(()=>requireDiscardableImport({stage:'staged',snapshot_id:'snapshot'},deps),'IMPORT_IMMUTABLE');
    fails(()=>requireDiscardableImport({stage:'mapped',job_id:'completed-job'},deps),'IMPORT_IMMUTABLE');
    fails(()=>requireDiscardableImport({stage:'review_ready'},{...deps,snapshot:true}),'IMPORT_IMMUTABLE');
    fails(()=>requireDiscardableImport({stage:'blocked'},{...deps,activeJob:true}),'IMPORT_IMMUTABLE');
 }
 // discarded and absent imports have the same unavailable lookup outcome
 {
  for(const record of [null,undefined,{stage:'discarded'}])fails(()=>requireVisibleImport(record),'NOT_FOUND');
    for(const stage of ['staged','queued','accepted'])assert.doesNotThrow(()=>requireVisibleImport({stage}));
 }
 // the installed parent-resource revision guard rejects stale review before discard
 {
  assert.doesNotThrow(()=>expected('7',7));
    fails(()=>expected('6',7),'STALE_INPUTS');
 }
});

// import stream
async function* pieces(bytes: Buffer, size = 1) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
function tracked(bytes: Buffer, fail?: Error) {
  const state = {closed: false};
  const input = (async function* () {
    try {if (bytes.length) yield bytes; if (fail) throw fail;}
    finally {state.closed = true;}
  })();
  return {input, state};
}
async function eventuallyClosed(state: {closed: boolean}) {
  const end = Date.now() + 1_000;
  while (!state.closed && Date.now() < end) await nextTurn();
  assert.equal(state.closed, true, 'The owned upstream iterator must actually close.');
}

test('CSV hints use the pinned strict parser with split UTF8 BOM, quoted multiline fields and exact string namespaces', async () => {
  const bytes = Buffer.from('\uFEFFsource_id,note,event_id\r\n001,"naïve,\n""quoted sample""",000001\r\n');
  assert.equal(await sniffSourceNamespace(pieces(bytes), 'csv'), '001');
  for (const csv of [
    'source_id,source_id\nfirst,second\n', 'source_id,\nfirst,second\n',
    'source_id,__proto__\nfirst,value\n', 'source_id,constructor\nfirst,value\n',
    'source_id,prototype\nfirst,value\n', 'source_id,note\nfirst,extra,third\n',
    'source_id,note\nfirst,"unclosed',
  ]) assert.equal(await sniffSourceNamespace(pieces(Buffer.from(csv), 7), 'csv'), null);
});

test('JSONL/gzip and bounded JSON collection hints preserve first-record semantics and reject escaped duplicate or invalid keys/namespaces', async () => {
  const first = Buffer.from('\uFEFF\n\r\n{"source_id":"JSON-source:007","note":"entrée🧭: \\\"source_id\\\""}\r\n{"source_id":"another"}\n');
  assert.equal(await sniffSourceNamespace(pieces(first), 'jsonl'), 'JSON-source:007');
  assert.equal(await sniffSourceNamespace(pieces(gzipSync(first), 3), 'gzip_jsonl'), 'JSON-source:007');
  assert.equal(bufferedJsonNamespace(Buffer.from('[{"source_id":"JSON-source:007","note":"source_id: repeated text"},{"source_id":"another"}]')), 'JSON-source:007');
  for (const text of [
    '{"source_id":"first","source_id":"second"}', '{"source_id":"first","source\\u005fid":"second"}',
    '{"source_id":"first","nested":{"key":1,"k\\u0065y":2}}', '{source_id:"first"}',
    '{"source\\xid":"first"}', '{"source_id":1}', '{"source_id":""}',
    '{"source_id":"_invalid"}', '{"source_id":"'+ 'x'.repeat(129) +'"}',
  ]) {
    assert.equal(await sniffSourceNamespace(pieces(Buffer.from(text+'\n'), 2), 'jsonl'), null);
    assert.equal(await sniffSourceNamespace(pieces(gzipSync(Buffer.from(text+'\n')), 3), 'gzip_jsonl'), null);
    assert.equal(bufferedJsonNamespace(Buffer.from('['+text+']')), null);
  }
  // The streaming hint deliberately stops at the first record. It is not an
  // attestation that trailing content passed normalization/object SHA checks.
  assert.equal(await sniffSourceNamespace(pieces(Buffer.from('{"source_id":"first"}\nmalformed later content\n')), 'jsonl'), 'first');
  assert.equal(bufferedJsonNamespace(Buffer.from('[{"source_id":"first"},{"source_id":"second","source_id":"third"}]')), null);
});

test('namespace hints refuse invalid UTF8, truncated first records and finite input/record/depth/expansion breaches', async () => {
  const invalidJson = Buffer.concat([Buffer.from('{"source_id":"first","note":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const invalidCsv = Buffer.concat([Buffer.from('source_id\nfirst'), Buffer.from([0xff]), Buffer.from('\n')]);
  assert.equal(await sniffSourceNamespace(pieces(invalidJson), 'jsonl'), null);
  assert.equal(await sniffSourceNamespace(pieces(invalidCsv), 'csv'), null);
  assert.equal(bufferedJsonNamespace(Buffer.concat([Buffer.from('['), invalidJson, Buffer.from(']')])), null);
  assert.equal(await sniffSourceNamespace(pieces(Buffer.from('{"source_id":"first"')), 'jsonl'), null);
  assert.equal(await sniffSourceNamespace(pieces(gzipSync(Buffer.from('{"source_id":"first"}\n')).subarray(0, 9)), 'gzip_jsonl'), null);
  const longJson = Buffer.from('{"source_id":"first","note":"'+'x'.repeat(DEFAULT_IMPORT_LIMITS.recordBytes)+'"}\n');
  assert.equal(await sniffSourceNamespace(pieces(longJson, 65_536), 'jsonl'), null);
  assert.equal(await sniffSourceNamespace(pieces(Buffer.from('source_id,note\nfirst,'+'x'.repeat(DEFAULT_IMPORT_LIMITS.recordBytes)+'\n'), 65_536), 'csv'), null);
  const deep = Buffer.from('{"source_id":"first","nested":'+'['.repeat(DEFAULT_IMPORT_LIMITS.depth+1)+'null'+']'.repeat(DEFAULT_IMPORT_LIMITS.depth+1)+'}\n');
  assert.equal(await sniffSourceNamespace(pieces(deep, 7), 'jsonl'), null);
  const expanded = Buffer.from('{"source_id":"first","note":"'+'x'.repeat(20_000)+'"}\n'), compressed = gzipSync(expanded);
  assert.ok(expanded.length > compressed.length * DEFAULT_IMPORT_LIMITS.expansionRatio, 'Independent fixture must exceed the configured gzip ratio.');
  assert.equal(await sniffSourceNamespace(pieces(compressed, 3), 'gzip_jsonl'), null);
  const overflow = tracked(Buffer.alloc(1024*1024+1, 0x20));
  assert.equal(await sniffSourceNamespace(overflow.input, 'jsonl'), null); await eventuallyClosed(overflow.state);
});

test('upstream faults return no hint without uncaught stream errors, and successful first-record hints close the owned iterator early', async () => {
  for (const format of ['csv','jsonl','gzip_jsonl'] as const) {
    const prefix = format==='csv' ? Buffer.from('source_id,note\nfirst,"unfinished') : format==='jsonl' ? Buffer.from('{"source_id":') : Buffer.from([0x1f,0x8b]);
    const failed = tracked(prefix, new Error('Explicit read-only fixture upstream failure'));
    assert.equal(await sniffSourceNamespace(failed.input, format), null); await eventuallyClosed(failed.state);
  }
  for (const format of ['csv','jsonl','gzip_jsonl'] as const) {
    const state = {closed:false,ended:false,reads:0};
    const first = format==='csv' ? Buffer.from('source_id,note\nfirst,valid\n') : format==='jsonl' ? Buffer.from('{"source_id":"first"}\n') : gzipSync(Buffer.from('{"source_id":"first"}\n'));
    const input = (async function* () {
      try {
        state.reads++; yield first;
        for (let index=0;index<100;index++) {await delay(5); state.reads++; yield Buffer.from('\n');}
        state.ended=true;
      } finally {state.closed=true;}
    })();
    assert.equal(await sniffSourceNamespace(input, format), 'first'); await eventuallyClosed(state);
    assert.equal(state.ended,false,'First-record hint cannot require consuming the entire source.');
    assert.ok(state.reads < 101,'At least one unread chunk must remain when the iterator closes.');
  }
  await nextTurn(); // Surface native stream errors scheduled after destruction.
});

test('hint resolution awaits delayed upstream finally cleanup and rejects a one-MiB blank prefix within the larger import ceiling', {timeout:3_000}, async () => {
  for(const format of ['csv','jsonl','gzip_jsonl'] as const) {
    const state={finallyEntered:false,finallyCompleted:false};
    const first=format==='csv'?Buffer.from('source_id,note\nfirst,valid\n'):format==='jsonl'?Buffer.from('{"source_id":"first"}\n'):gzipSync(Buffer.from('{"source_id":"first"}\n'));
    const input=(async function*(){
      try {yield first;await delay(5);yield Buffer.from('\n');}
      finally {state.finallyEntered=true;await delay(25);state.finallyCompleted=true;}
    })();
    assert.equal(await sniffSourceNamespace(input,format),'first');
    assert.equal(state.finallyEntered,true);assert.equal(state.finallyCompleted,true,'Returning a hint must await owned async-generator cleanup, not merely request destruction.');
  }
  const bytes=Buffer.from('\n'.repeat(1024*1024)+'{"source_id":"later-valid-record"}\n');
  assert.ok(bytes.length < DEFAULT_IMPORT_LIMITS.inputBytes,'The explicit hint ceiling is separate from the full import byte ceiling.');
  const source=tracked(bytes);assert.equal(await sniffSourceNamespace(source.input,'jsonl'),null);assert.equal(source.state.closed,true);
});
