import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DomainError} from '../errors.js';
import {PrivateObjects} from '../storage/objects.js';
import {verifySnapshotBytes} from './snapshot-integrity.js';
import {withVerificationScope} from '../verification/scope.js';
import {snapshotRecordDigest} from './snapshot-digest.js';
import {canonicalArrayBytes, hashCanonicalArray} from '../canonical.js';

// snapshot integrity
type Manifest = Parameters<typeof verifySnapshotBytes>[1];
type Reader = NonNullable<Parameters<typeof verifySnapshotBytes>[3]>;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
function manifest(wid: string, key: string, bytes: number): Manifest {
  return {workspace_id: wid, files: [{path: `canonical/${key}.json`, sha256: key, size_bytes: bytes, media_type: 'application/json'}]};
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settled => {resolve = settled;});
  return {promise, resolve};
}
async function fixture() {
  const workspace = await fs.realpath(process.cwd());
  let root = workspace;
  for (const segment of ['.runtime', 'acceptance', 'snapshot-integrity-' + randomUUID()]) {
    root = path.join(root, segment); await fs.mkdir(root, {recursive: true, mode: 0o700});
    const info = await fs.lstat(root), actual = await fs.realpath(root), relative = path.relative(workspace, actual);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(path.resolve(actual), path.resolve(root));
  }
  return {root, wid: randomUUID(), objects: new PrivateObjects(root)};
}

test("private snapshot bytes verify at EOF and reject missing, changed or truncated objects", async () => {
 // actual private canonical UTF8 bytes verify across multiple chunks and only after complete iterator settlement
 {
  const {wid, objects} = await fixture();
     // Independently authored canonical property ordering; no production serializer
     // supplies this expectation. Its UTF8 payload crosses the 64KiB read boundary.
     const bytes = Buffer.from('[' + Array.from({length: 2400}, (_, index) => `{"event_id":"event-${index}","session_id":"opaque-${index}","text":"café 成功"}`).join(',') + ']');
     const stored = await objects.put(wid, bytes);
     assert.equal(stored.key, sha256(bytes)); assert.equal(stored.size_bytes, bytes.length);
     const eof = deferred(), release = deferred(); let count = 0, total = 0, closed = false, settled = false;
     const reader: Reader = {readStream: async function* (workspaceId, key, limit) {
       assert.equal(workspaceId, wid); assert.equal(key, sha256(bytes)); assert.equal(limit, bytes.length);
       try {for await (const chunk of objects.readStream(workspaceId, key, limit)) {count++; total += chunk.length; yield chunk;}
         eof.resolve(); await release.promise;
       } finally {closed = true;}
     }};
     const verifying = verifySnapshotBytes(wid, manifest(wid, stored.key, bytes.length), stored.key, reader).then(() => {settled = true;});
     try {
       await eof.promise; assert.ok(count > 1); assert.equal(total, bytes.length); assert.equal(settled, false); assert.equal(closed, false);
     } finally {release.resolve();}
     await verifying; assert.equal(settled, true); assert.equal(closed, true);
     assert.deepEqual(await objects.read(wid, stored.key), bytes);
 }
 // actual same-size mutation and truncation reject, then exact restoration verifies the original object
 {
  const {root, wid, objects} = await fixture(), bytes = Buffer.from('[{"event_id":"entry","session_id":"opaque","text":"independent"}]');
     const stored = await objects.put(wid, bytes), file = path.join(root, wid, stored.key), expected = manifest(wid, stored.key, bytes.length);
     await verifySnapshotBytes(wid, expected, stored.key, objects);
     const changed = Buffer.from(bytes); changed[changed.indexOf('independent')] = 'I'.charCodeAt(0);
     assert.equal(changed.length, bytes.length); assert.notEqual(sha256(changed), stored.key);
     try {
       await fs.writeFile(file, changed);
       await assert.rejects(verifySnapshotBytes(wid, expected, stored.key, objects), code('ARTIFACT_CORRUPT'));
       await fs.writeFile(file, bytes.subarray(0, bytes.length - 1));
       await assert.rejects(verifySnapshotBytes(wid, expected, stored.key, objects), code('ARTIFACT_CORRUPT'));
     } finally {await fs.writeFile(file, bytes); assert.equal(sha256(await fs.readFile(file)), stored.key);}
     await verifySnapshotBytes(wid, expected, stored.key, objects);
 }
 // actual missing canonical object is unavailable; wrong declared sizes cannot pass real bytes
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes);
     const absent = sha256(Buffer.from('independent object that was never stored'));
     await assert.rejects(verifySnapshotBytes(wid, manifest(wid, absent, 2), absent, objects), code('ARTIFACT_UNAVAILABLE'));
     for (const size of [1, 3]) await assert.rejects(verifySnapshotBytes(wid, manifest(wid, stored.key, size), stored.key, objects), code('ARTIFACT_CORRUPT'));
     await verifySnapshotBytes(wid, manifest(wid, stored.key, bytes.length), stored.key, objects);
 }
});

test("snapshot manifests bind exact provenance and require complete authenticated reads", async () => {
 // finite manifest identity and descriptor negatives reject before any injected reader access
 {
  const wid = randomUUID(), key = sha256(Buffer.from('[]')), valid = manifest(wid, key, 2), file = valid.files[0]!;
     let calls = 0;
     const reader: Reader = {readStream: async function* () {calls++; yield Buffer.from('[]');}};
     const invalid: Manifest[] = [
       {...valid, workspace_id: randomUUID()},
       // Deliberately malformed runtime metadata violates the generated minItems1
       // tuple; this cast is confined to the independent rejection expectation.
       {...valid, files: []} as unknown as Manifest, {...valid, files: [file, {...file}]},
       {...valid, files: [{...file, path: '../canonical/' + key + '.json'}]},
       {...valid, files: [{...file, path: 'canonical/' + 'a'.repeat(64) + '.json'}]},
       {...valid, files: [{...file, sha256: 'b'.repeat(64)}]},
       {...valid, files: [{...file, media_type: 'text/html'}]},
       ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 268_435_457].map((size_bytes): Manifest => ({...valid, files: [{...file, size_bytes}]})),
     ];
     for (const value of invalid) await assert.rejects(verifySnapshotBytes(wid, value, key, reader), code('ARTIFACT_CORRUPT'));
     for (const objectKey of ['../escape', 'g'.repeat(64), key.toUpperCase()]) await assert.rejects(verifySnapshotBytes(wid, valid, objectKey, reader), code('ARTIFACT_CORRUPT'));
     assert.equal(calls, 0);
     let maximum = 0;
     const maximumReader: Reader = {readStream: async function* (_wid, _key, limit) {calls++; maximum = limit!;}};
     await assert.rejects(verifySnapshotBytes(wid, manifest(wid, key, 268_435_456), key, maximumReader), code('ARTIFACT_CORRUPT'));
     assert.equal(calls, 1); assert.equal(maximum, 268_435_456); // Metadata ceiling, not a 256MiB disk workload.
 }
 // a valid prefix with a delayed final checksum failure never resolves successful verification
 {
  const wid = randomUUID(), bytes = Buffer.from('[]'), key = sha256(bytes), entered = deferred(), release = deferred();
     let successful = false, closed = false;
     // Explicit injected late integrity failure, not an actual storage/DB success.
     const reader: Reader = {readStream: async function* () {
       try {yield bytes; entered.resolve(); await release.promise; throw new DomainError('ARTIFACT_CORRUPT', 'Injected final checksum mismatch.', 409);}
       finally {closed = true;}
     }};
     const verifying = verifySnapshotBytes(wid, manifest(wid, key, bytes.length), key, reader);
     verifying.then(() => {successful = true;}, () => {});
     try {await entered.promise; assert.equal(successful, false); assert.equal(closed, false);} finally {release.resolve();}
     await assert.rejects(verifying, code('ARTIFACT_CORRUPT')); assert.equal(successful, false); assert.equal(closed, true);
 }
 // full frozen snapshot hash binds independently authored array bytes, source, coverage, raw and mapping identities
 {
  const {wid, objects} = await fixture();
     const source = '55555555-5555-4555-8555-555555555555', mapping = 'a'.repeat(64), raw = 'b'.repeat(64);
     const bytes = Buffer.from('[{"event_id":"event-1","session_id":"opaque","text":"é"}]');
     const coverage = {basis: 'none', extraction_status: 'complete'};
     // Exact independent canonical snapshot serialization: neither the production
     // serializer nor snapshotRecordDigest supplies the expected full content hash.
     const canonicalSnapshot = '{"coverage":{"basis":"none","extraction_status":"complete"},"mapping_hash":"' + mapping + '","raw_hash":"' + raw + '","records":[{"event_id":"event-1","session_id":"opaque","text":"é"}],"source_id":"' + source + '"}';
     const binding = {source_id: source, coverage, mapping_hash: mapping, raw_hash: raw, content_hash: sha256(Buffer.from(canonicalSnapshot))};
     const stored = await objects.put(wid, bytes), expected = manifest(wid, stored.key, bytes.length);
     await verifySnapshotBytes(wid, expected, stored.key, objects, binding);
     for (const changed of [
       {...binding, content_hash: 'c'.repeat(64)},
       {...binding, coverage: {basis: 'operator_attestation', extraction_status: 'complete'}},
       {...binding, raw_hash: 'c'.repeat(64)},
       {...binding, mapping_hash: 'd'.repeat(64)},
       {...binding, source_id: '66666666-6666-4666-8666-666666666666'},
     ]) await assert.rejects(verifySnapshotBytes(wid, expected, stored.key, objects, changed), code('ARTIFACT_CORRUPT'));
     assert.deepEqual(await objects.read(wid, stored.key), bytes);
     await verifySnapshotBytes(wid, expected, stored.key, objects, binding);
 }
});

function emptyBinding() {
  const mapping = 'a'.repeat(64), raw = 'b'.repeat(64);
  const text = '{"coverage":{"basis":"none","extraction_status":"complete"},"mapping_hash":"' + mapping + '","raw_hash":"' + raw + '","records":[],"source_id":"scope-source"}';
  return {source_id: 'scope-source', coverage: {basis: 'none', extraction_status: 'complete'}, mapping_hash: mapping, raw_hash: raw, content_hash: sha256(Buffer.from(text))};
}

function countedReader(objects: PrivateObjects, onRead: () => void): Reader {
  return {readStream: async function* (wid, key, limit) {onRead(); yield* objects.readStream(wid, key, limit);}};
}

test("verification scopes coalesce only exact immutable identities and retry failures", async () => {
 // one scope coalesces exact immutable verifications only after the full reader and provenance check settle
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes);
     const expected = manifest(wid, stored.key, bytes.length), binding = emptyBinding(), eof = deferred(), release = deferred();
     let reads = 0, settled = 0, closed = false;
     const reader: Reader = {readStream: async function* (workspaceId, key, limit) {
       reads++;
       try {yield* objects.readStream(workspaceId, key, limit); eof.resolve(); await release.promise;}
       finally {closed = true;}
     }};
     await withVerificationScope(async () => {
       const first = verifySnapshotBytes(wid, expected, stored.key, reader, binding).then(() => {settled++;});
       const second = verifySnapshotBytes(wid, structuredClone(expected), stored.key, reader, structuredClone(binding)).then(() => {settled++;});
       try {await eof.promise; assert.equal(reads, 1); assert.equal(settled, 0); assert.equal(closed, false);}
       finally {release.resolve();}
       await Promise.all([first, second]); assert.equal(settled, 2); assert.equal(closed, true);
       await verifySnapshotBytes(wid, structuredClone(expected), stored.key, reader, structuredClone(binding));
       assert.equal(reads, 1);
     });
 }
 // scope identity binds the entire manifest, digest inputs, workspace, object key and reader object
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes), binding = emptyBinding();
     const expected = {...manifest(wid, stored.key, bytes.length), revision_id: 'revision-one'};
     const otherWid = randomUUID(), otherBytes = Buffer.from('[0]'), otherStored = await objects.put(wid, otherBytes);
     await objects.put(otherWid, bytes);
     let reads = 0;
     const reader = countedReader(objects, () => {reads++;});
     await withVerificationScope(async () => {
       await verifySnapshotBytes(wid, expected, stored.key, reader, binding); assert.equal(reads, 1);
       const revised = {...expected, revision_id: 'revision-two'};
       await verifySnapshotBytes(wid, revised, stored.key, reader, binding); assert.equal(reads, 2);
       const wrongSize = {...expected, files: [{...expected.files[0]!, size_bytes: bytes.length + 1}]} as Manifest;
       await assert.rejects(verifySnapshotBytes(wid, wrongSize, stored.key, reader, binding), code('ARTIFACT_CORRUPT')); assert.equal(reads, 3);
       for (const changed of [
         {...binding, source_id: 'another-source'}, {...binding, coverage: {...binding.coverage, basis: 'operator_attestation'}},
         {...binding, mapping_hash: 'c'.repeat(64)}, {...binding, raw_hash: 'd'.repeat(64)}, {...binding, content_hash: 'e'.repeat(64)},
       ]) {
         const before:number = reads;
         await assert.rejects(verifySnapshotBytes(wid, expected, stored.key, reader, changed), code('ARTIFACT_CORRUPT'));
         assert.equal(reads, before + 1);
       }
       let before:number = reads;
       await verifySnapshotBytes(wid, expected, stored.key, reader); assert.equal(reads, before + 1); // Absent provenance is a different verification.
       before = reads;
       await verifySnapshotBytes(otherWid, manifest(otherWid, stored.key, bytes.length), stored.key, reader, binding); assert.equal(reads, before + 1);
       before = reads;
       await verifySnapshotBytes(wid, manifest(wid, otherStored.key, otherBytes.length), otherStored.key, reader); assert.equal(reads, before + 1);
       before = reads;
       await verifySnapshotBytes(wid, expected, stored.key, {readStream: reader.readStream}, binding); assert.equal(reads, before + 1);
       await verifySnapshotBytes(wid, expected, stored.key, reader, binding); assert.equal(reads, before + 1); // Original success remains bound to its exact inputs.
     });
 }
 // coalesced failed reads reject every waiter and are retried before any successful result can be reused
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes), expected = manifest(wid, stored.key, bytes.length);
     let reads = 0;
     const reader: Reader = {readStream: async function* (workspaceId, key, limit) {
       reads++;
       if (reads === 1) throw new DomainError('STORAGE_UNAVAILABLE', 'Explicit unit read failure.', 503);
       yield* objects.readStream(workspaceId, key, limit);
     }};
     await withVerificationScope(async () => {
       const outcomes = await Promise.allSettled([verifySnapshotBytes(wid, expected, stored.key, reader), verifySnapshotBytes(wid, expected, stored.key, reader)]);
       assert.equal(reads, 1); assert.equal(outcomes.length, 2);
       for (const outcome of outcomes) {assert.equal(outcome.status, 'rejected'); if (outcome.status === 'rejected') assert.ok(code('STORAGE_UNAVAILABLE')(outcome.reason));}
       await verifySnapshotBytes(wid, expected, stored.key, reader); assert.equal(reads, 2);
       await verifySnapshotBytes(wid, expected, stored.key, reader); assert.equal(reads, 2);
     });
 }
});

test("corruption is rechecked across verification scopes and outside transactions", async () => {
 // actual corruption is never a scoped success and exact restoration is rechecked
 {
  const {root, wid, objects} = await fixture(), bytes = Buffer.from('[1]'), stored = await objects.put(wid, bytes);
     const file = path.join(root, wid, stored.key), expected = manifest(wid, stored.key, bytes.length);
     let reads = 0;
     const reader = countedReader(objects, () => {reads++;});
     try {
       await fs.writeFile(file, Buffer.from('[2]'));
       await withVerificationScope(async () => {
         await assert.rejects(verifySnapshotBytes(wid, expected, stored.key, reader), code('ARTIFACT_CORRUPT')); assert.equal(reads, 1);
         await fs.writeFile(file, bytes);
         await verifySnapshotBytes(wid, expected, stored.key, reader); assert.equal(reads, 2);
         await verifySnapshotBytes(wid, expected, stored.key, reader); assert.equal(reads, 2);
       });
     } finally {await fs.writeFile(file, bytes);}
 }
 // separate transaction invocations and calls outside a scope reread changed bytes with the same reused reader/client
 {
  const {root, wid, objects} = await fixture(), bytes = Buffer.from('[1]'), stored = await objects.put(wid, bytes);
     const file = path.join(root, wid, stored.key), expected = manifest(wid, stored.key, bytes.length);
     let reads = 0;
     const reader = countedReader(objects, () => {reads++;});
     // This stable wrapper represents a reused PoolClient; scope ownership belongs to each invocation.
     const reusedClient = {verify: () => verifySnapshotBytes(wid, expected, stored.key, reader)};
     try {
       await withVerificationScope(async () => {await reusedClient.verify(); await reusedClient.verify();}); assert.equal(reads, 1);
       await fs.writeFile(file, Buffer.from('[2]'));
       await assert.rejects(withVerificationScope(reusedClient.verify), code('ARTIFACT_CORRUPT')); assert.equal(reads, 2);
       await fs.writeFile(file, bytes);
       await reusedClient.verify(); assert.equal(reads, 3);
       await fs.writeFile(file, Buffer.from('[2]'));
       await assert.rejects(reusedClient.verify(), code('ARTIFACT_CORRUPT')); assert.equal(reads, 4);
     } finally {await fs.writeFile(file, bytes);}
 }
});

test("verification caches isolate nested scopes and cannot outlive or change their binding", async () => {
 // nested and concurrent scopes are isolated while the outer scope resumes its own exact success
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes), expected = manifest(wid, stored.key, bytes.length);
     let reads = 0;
     const reader = countedReader(objects, () => {reads++;}), verify = () => verifySnapshotBytes(wid, expected, stored.key, reader);
     const returned = await withVerificationScope(async () => {
       await verify(); assert.equal(reads, 1);
       await withVerificationScope(async () => {await verify(); await verify();}); assert.equal(reads, 2);
       await verify(); assert.equal(reads, 2);
       return 'outer result';
     });
     assert.equal(returned, 'outer result');
     await Promise.all([withVerificationScope(verify), withVerificationScope(verify)]); assert.equal(reads, 4);
 }
 // completed and rejected scopes do not keep a cache alive for inherited background work
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes), expected = manifest(wid, stored.key, bytes.length);
     let reads = 0;
     const reader = countedReader(objects, () => {reads++;}), verify = () => verifySnapshotBytes(wid, expected, stored.key, reader);
     for (const reject of [false, true]) {
       const gate = deferred(); let background!: Promise<void>;
       const sentinel = Error('Explicit callback failure.');
       const callback = async () => {
         await verify();
         background = gate.promise.then(async () => {await verify(); await verify();});
         if (reject) throw sentinel;
       };
       if (reject) await assert.rejects(withVerificationScope(callback), error => error === sentinel);
       else await withVerificationScope(callback);
       const before = reads; gate.resolve(); await background;
       assert.equal(reads, before + 2);
     }
 }
 // a manifest changed during a read cannot leave success cached under its earlier identity
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes);
     const expected = {...manifest(wid, stored.key, bytes.length), revision_id: 'earlier'}, eof = deferred(), release = deferred();
     let reads = 0;
     const reader: Reader = {readStream: async function* (workspaceId, key, limit) {
       reads++; yield* objects.readStream(workspaceId, key, limit);
       if (reads === 1) {eof.resolve(); await release.promise;}
     }};
     await withVerificationScope(async () => {
       const first = verifySnapshotBytes(wid, expected, stored.key, reader);
       try {await eof.promise; expected.revision_id = 'changed-during-read';} finally {release.resolve();}
       await first; expected.revision_id = 'earlier';
       await verifySnapshotBytes(wid, expected, stored.key, reader); assert.equal(reads, 2);
     });
 }
 // runtime metadata that cannot be canonically bound is verified without caching or new rejection behavior
 {
  const {wid, objects} = await fixture(), bytes = Buffer.from('[]'), stored = await objects.put(wid, bytes);
     const expected = {...manifest(wid, stored.key, bytes.length), unsupported_extra: undefined};
     let reads = 0;
     const reader = countedReader(objects, () => {reads++;});
     await withVerificationScope(async () => {
       await verifySnapshotBytes(wid, expected, stored.key, reader);
       await verifySnapshotBytes(wid, expected, stored.key, reader);
       assert.equal(reads, 2);
     });
 }
});

// snapshot digest
test("snapshot digest preserves frozen canonical bytes and rejects unsafe values", () => {
 // bounded snapshot digest preserves exact frozen canonical UTF8 bytes and property ordering
 {
  const expected='{"coverage":{"basis":"none"},"mapping_hash":"m","raw_hash":"r","records":[{"a":"é","z":2},null],"source_id":"s"}',digest=snapshotRecordDigest({source_id:'s',records:[{z:2,a:'é'},null],coverage:{basis:'none'},mapping_hash:'m',raw_hash:'r'});assert.equal(digest.content_hash,createHash('sha256').update(expected).digest('hex'));assert.equal(digest.canonical_bytes,23);assert.deepEqual(snapshotRecordDigest({source_id:'s',records:[{a:'é',z:2},null],coverage:{basis:'none'},mapping_hash:'m',raw_hash:'r'}),digest);
 }
 // snapshot hashing does not accept unsafe/nonfinite records as an optimization shortcut
 {
  for(const record of[{value:Infinity},JSON.parse('{"__proto__":2}')])assert.throws(()=>snapshotRecordDigest({source_id:'s',records:[record],coverage:{basis:'none'},mapping_hash:'m',raw_hash:'r'}));
 }
});

// canonical array
test("canonical arrays preserve independent UTF8 digests and reject unsafe values", () => {
 // bounded canonical array output preserves independently specified UTF8 bytes and digest
 {
  const input=[{z:'café',a:[true,null,-1]},{b:'\\"',a:'λ'}];
    const expected=Buffer.from('[{"a":[true,null,-1],"z":"café"},{"a":"λ","b":"\\\\\\\""}]');
    assert.deepEqual(canonicalArrayBytes(input),expected);
    assert.equal(hashCanonicalArray(input),createHash('sha256').update(expected).digest('hex'));
    assert.equal(hashCanonicalArray([]),createHash('sha256').update('[]').digest('hex'));
    assert.deepEqual(canonicalArrayBytes([]),Buffer.from('[]'));
    const many=Array.from({length:1000},(_,i)=>({i,text:'é'.repeat(160)}));
    const explicit='['+many.map(v=>'{'+'"i":'+v.i+',"text":'+JSON.stringify(v.text)+'}').join(',')+']';
    assert.deepEqual(canonicalArrayBytes(many),Buffer.from(explicit));
    assert.equal(hashCanonicalArray(many),createHash('sha256').update(explicit).digest('hex'));
 }
 // bounded canonical array helpers preserve unsafe/nonfinite rejection
 {
  for(const value of [Infinity,NaN,undefined,JSON.parse('{"__proto__":{"elevated":true}}')]){
     assert.throws(()=>canonicalArrayBytes([value]));assert.throws(()=>hashCanonicalArray([value]));
    }
 }
});
