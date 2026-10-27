import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn, setTimeout as delay} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {bufferedJsonNamespace, sniffSourceNamespace} from './import-stream.js';
import {DEFAULT_IMPORT_LIMITS} from '../imports/parser.js';

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
