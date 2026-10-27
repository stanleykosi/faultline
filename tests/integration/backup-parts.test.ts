import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import {encodeBackupPart,decodeBackupPart,partDescriptor,assertPartInventoryLimits,serializeBackupFrame,assertBackupFrameCapacity,MAX_RECOVERY_FRAME_BYTES,MAX_RECOVERY_PART_BYTES,MAX_RECOVERY_LOGICAL_BYTES} from '../../tools/ops/backup-parts.js';
import {DomainError} from '../../packages/core/src/errors.js';
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('compressed and legacy backup parts preserve independently authored binary and exact UTC6 UTF8 bytes',()=>{
 for(const bytes of [Buffer.alloc(0),Buffer.from([0,255,1,128]),Buffer.from('café🧭\n2026-01-01T00:00:00.000001Z\n'.repeat(1000))]){
  const part=encodeBackupPart('objects/fixture',bytes);assert.equal(part.sha256,digest(bytes));assert.equal(part.size_bytes,bytes.length);assert.equal(part.encoding,'gzip');assert.deepEqual(decodeBackupPart(part,2),bytes);assert.deepEqual(partDescriptor(part),{name:part.name,sha256:digest(bytes),size_bytes:bytes.length,encoding:'gzip'});
  const legacy={name:part.name,sha256:digest(bytes),size_bytes:bytes.length,bytes_base64:bytes.toString('base64')};assert.deepEqual(decodeBackupPart(legacy,1),bytes);assert.deepEqual(partDescriptor(legacy),{name:part.name,sha256:digest(bytes),size_bytes:bytes.length});
 }
});
test('compression cannot hide expansion, changed original hashes, unknown encodings or truncation',()=>{
 const bytes=Buffer.from('independent original'.repeat(4096)),part=encodeBackupPart('database.sql',bytes),reject=(value:typeof part,version:1|2=2)=>assert.throws(()=>decodeBackupPart(value,version),(e:unknown)=>e instanceof DomainError);
 reject({...part,size_bytes:1});reject({...part,sha256:'0'.repeat(64)});reject({...part,encoding:undefined});reject({...part,encoding:'brotli' as 'gzip'});reject(part,1);
 reject({...part,bytes_base64:part.bytes_base64+'!'});reject({...part,bytes_base64:Buffer.from(part.bytes_base64,'base64').subarray(0,10).toString('base64')});
 reject({...part,bytes_base64:gzipSync(Buffer.from('wrong bytes')).toString('base64')});
 for(const size_bytes of [-1,NaN,Infinity,MAX_RECOVERY_PART_BYTES+1])reject({...part,size_bytes});
});
test('whole inventory expansion is refused before decoding any compressed payload',()=>{
 const fake={name:'database.sql',sha256:'0'.repeat(64),size_bytes:MAX_RECOVERY_PART_BYTES,bytes_base64:'AA==',encoding:'gzip' as const};
 assertPartInventoryLimits([fake],2);assert.throws(()=>assertPartInventoryLimits(Array(5).fill(fake),2),(e:unknown)=>e instanceof DomainError&&e.code==='BACKUP_SIZE_LIMIT');
 assert.throws(()=>assertPartInventoryLimits([{...fake,size_bytes:MAX_RECOVERY_LOGICAL_BYTES+1}],1));assert.throws(()=>assertPartInventoryLimits([{...fake,size_bytes:NaN}],2));
 assert.throws(()=>assertPartInventoryLimits(Array(20001).fill({...fake,size_bytes:0}),2));
});
test('base64 plus UTF8 metadata must fit the installed frame limit before full serialization',()=>{
 assertBackupFrameCapacity(100,MAX_RECOVERY_FRAME_BYTES-100);
 for(const pair of [[100,MAX_RECOVERY_FRAME_BYTES-99],[NaN,0],[-1,1],[0,Infinity],[0,Number.MAX_SAFE_INTEGER+1]])assert.throws(()=>assertBackupFrameCapacity(pair[0]!,pair[1]!), (e:unknown)=>e instanceof DomainError&&e.code==='BACKUP_SIZE_LIMIT');
 const frame={description:'café🧭',parts:[encodeBackupPart('database.sql',Buffer.from('independent SQL bytes'))]};assert.equal(serializeBackupFrame(frame),JSON.stringify(frame));
});
