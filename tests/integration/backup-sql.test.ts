import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeDatabaseDump,decodeDatabaseDump,DEFAULT_SQL_CHUNK_BYTES,type DatabaseDumpDescriptor} from '../../tools/ops/backup-sql.js';
import {encodeBackupPart,MAX_RECOVERY_LOGICAL_BYTES,type BackupPart} from '../../tools/ops/backup-parts.js';
import {DomainError} from '../../packages/core/src/errors.js';

// Independently authored byte fixtures only; no PostgreSQL or restore execution.
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function* source(bytes: Buffer, inputBytes = 3) {for (let offset = 0; offset < bytes.length; offset += inputBytes) yield bytes.subarray(offset, offset + inputBytes);}
async function encoded(bytes: Buffer, chunkBytes: number) {const generator = encodeDatabaseDump(source(bytes), {chunkBytes}), parts: BackupPart[] = []; let step = await generator.next(); while (!step.done) {parts.push(step.value); step = await generator.next();} return {parts, descriptor: step.value};}
const rejectsBeforeYield = (descriptor: DatabaseDumpDescriptor, parts: BackupPart[], chunkBytes: number, code?: string) => assert.throws(() => decodeDatabaseDump(descriptor, parts, {chunkBytes}).next(), (error: unknown) => error instanceof DomainError && (!code || error.code === code));

test('byte chunks preserve binary, UTF8 and COPY lines across input/chunk boundaries, with full independent size/SHA and early bounded emission', async () => {
 assert.equal(DEFAULT_SQL_CHUNK_BYTES, 134217728);
 const bytes = Buffer.concat([Buffer.from([0,255,128,1]), Buffer.from("COPY public.fixture (text_value) FROM stdin;\n1\tcafé🧭東京\n2\t" + 'long-COPY-line-🧭'.repeat(20) + '\n\\.\n', 'utf8')]), size = 5;
 const result = await encoded(bytes, size); assert.equal(result.descriptor.format, 'plain_sql_chunks'); assert.equal(result.descriptor.size_bytes, bytes.length); assert.equal(result.descriptor.sha256, hash(bytes)); assert.equal(result.parts.length, Math.ceil(bytes.length / size)); assert.deepEqual(result.descriptor.parts, result.parts.map((part,index) => {assert.equal(part.name, 'database/' + String(index + 1).padStart(6,'0') + '.sql'); assert.equal(part.size_bytes, Math.min(size, bytes.length - index * size)); return part.name;}));
 // Individual boundaries deliberately cut multibyte UTF8 and a SQL COPY line.
 assert.ok(result.parts.length > 2); assert.deepEqual(Buffer.concat([...decodeDatabaseDump(result.descriptor, [...result.parts, encodeBackupPart('keys/fixture', Buffer.from('key fixture'))], {chunkBytes:size})]), bytes);
 let consumed = 0; async function* boundedSource() {for (const value of ['abcd','efgh','ijkl']) {consumed++; yield Buffer.from(value);}}
 const stream = encodeDatabaseDump(boundedSource(), {chunkBytes:4}), first = await stream.next(); assert.equal(first.done,false); assert.equal(consumed,1,'The first part emits without consuming or buffering the full dump.'); const second = await stream.next(); assert.equal(second.done,false); assert.equal(consumed,2); const third = await stream.next(); assert.equal(third.done,false); const done = await stream.next(); assert.equal(done.done,true); if (done.done) {assert.equal(done.value.size_bytes,12); assert.equal(done.value.sha256,hash(Buffer.from('abcdefghijkl')));}
});
test('ordered inventory and every checksum validate before any SQL is yielded; swapped/missing/duplicate/gap/legacy/fullhash/size tampering cannot publish', async () => {
 const original = Buffer.from('COPY x FROM stdin;\ncafé🧭\n\\.\n'), chunkBytes = 8, result = await encoded(original,chunkBytes), clone = () => result.parts.map(part=>({...part}));
 const swapped=clone(); [swapped[0],swapped[1]]=[swapped[1]!,swapped[0]!]; rejectsBeforeYield(result.descriptor,swapped,chunkBytes,'BACKUP_MANIFEST_MISMATCH');
 rejectsBeforeYield(result.descriptor,clone().slice(1),chunkBytes,'BACKUP_MANIFEST_MISMATCH');
 const duplicated=clone(); duplicated[1]={...duplicated[0]!}; rejectsBeforeYield(result.descriptor,duplicated,chunkBytes,'BACKUP_MANIFEST_MISMATCH');
 rejectsBeforeYield({...result.descriptor,parts:result.descriptor.parts.map((name,index)=>index===1?'database/000003.sql':name)},clone(),chunkBytes,'BACKUP_MANIFEST_MISMATCH');
 rejectsBeforeYield(result.descriptor,[...clone(),encodeBackupPart('database.sql',original)],chunkBytes,'BACKUP_MANIFEST_MISMATCH');
 rejectsBeforeYield({...result.descriptor,sha256:'0'.repeat(64)},clone(),chunkBytes,'BACKUP_CHECKSUM_FAILED');
 rejectsBeforeYield({...result.descriptor,size_bytes:result.descriptor.size_bytes+1},clone(),chunkBytes,'BACKUP_MANIFEST_MISMATCH');
 const changedOriginal=Buffer.from(original), lastIndex=changedOriginal.length-1, lastByte=changedOriginal[lastIndex]; assert.ok(lastByte!==undefined); changedOriginal[lastIndex]=lastByte^1; const validIndividualTamper=await encoded(changedOriginal,chunkBytes); rejectsBeforeYield(result.descriptor,validIndividualTamper.parts,chunkBytes,'BACKUP_CHECKSUM_FAILED');
 const brokenFinal=clone(); brokenFinal[brokenFinal.length-1]={...brokenFinal.at(-1)!,sha256:'f'.repeat(64)}; rejectsBeforeYield(result.descriptor,brokenFinal,chunkBytes,'BACKUP_CHECKSUM_FAILED');
 const immutable=clone(), decoder=decodeDatabaseDump(result.descriptor,immutable,{chunkBytes}), first=decoder.next(); assert.ok(!first.done); immutable[1]!.bytes_base64='AA=='; immutable[1]!.sha256='0'.repeat(64); result.descriptor.parts[1]='database/999999.sql'; assert.deepEqual(Buffer.concat([first.value,...decoder]),original,'Validated metadata snapshots cannot be changed between yielded chunks.');
});
test('invalid chunk configuration, declared logical overflow, empty input and20,001 tiny SQL parts are refused honestly', async () => {
 for (const chunkBytes of [0,-1,NaN,Infinity,1.5,DEFAULT_SQL_CHUNK_BYTES+1,Number.MAX_SAFE_INTEGER+1]) {await assert.rejects(encodeDatabaseDump(source(Buffer.from('sql')),{chunkBytes}).next(),(error:unknown)=>error instanceof DomainError&&error.code==='BACKUP_SIZE_LIMIT');}
 await assert.rejects(encodeDatabaseDump(source(Buffer.alloc(0)),{chunkBytes:1}).next(),(error:unknown)=>error instanceof DomainError&&error.code==='BACKUP_FORMAT');
 rejectsBeforeYield({format:'plain_sql_chunks',size_bytes:MAX_RECOVERY_LOGICAL_BYTES+1,sha256:'a'.repeat(64),parts:['database/000001.sql']},[],DEFAULT_SQL_CHUNK_BYTES,'BACKUP_SIZE_LIMIT');
 rejectsBeforeYield({format:'plain_sql_chunks',size_bytes:NaN,sha256:'a'.repeat(64),parts:['database/000001.sql']},[],1,'BACKUP_SIZE_LIMIT');
 const tooMany = encodeDatabaseDump(source(Buffer.alloc(20_001,42),1000),{chunkBytes:1}); await assert.rejects(async()=>{for await(const ignored of tooMany) void ignored;},(error:unknown)=>error instanceof DomainError&&error.code==='BACKUP_SIZE_LIMIT');
});
