import {createHash} from 'node:crypto';
import {encodeBackupPart,decodeBackupPart,assertPartMetadata,MAX_RECOVERY_PART_BYTES,MAX_RECOVERY_LOGICAL_BYTES,MAX_RECOVERY_STORED_BYTES,type BackupPart} from './backup-parts.js';
import {demand} from '../../packages/core/src/errors.js';

export const DEFAULT_SQL_CHUNK_BYTES = 128 * 1024 * 1024;
const MAX_SQL_PARTS = 20_000;
export interface DatabaseDumpDescriptor {format: 'plain_sql_chunks'; size_bytes: number; sha256: string; parts: string[];}
/** Smaller values are for codec acceptance only; operators use the fixed default. */
export interface DatabaseDumpCodecOptions {chunkBytes?: number;}

function chunkSize(options: DatabaseDumpCodecOptions): number {
 const value = options.chunkBytes ?? DEFAULT_SQL_CHUNK_BYTES;
 demand(Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_SQL_CHUNK_BYTES && value <= MAX_RECOVERY_PART_BYTES, 'BACKUP_SIZE_LIMIT', 'SQL chunks must use a positive bounded byte size of at most 128 MiB.');
 return value;
}
const partName = (index: number): string => 'database/' + String(index).padStart(6, '0') + '.sql';

/**
 * Each allocation/concatenation is one bounded SQL part, never the whole dump.
 * Consumers must drain next() to its final descriptor before signing/publishing.
 * Input and COPY/UTF8 boundaries have no meaning here: original bytes are truth.
 */
export async function* encodeDatabaseDump(source: AsyncIterable<Buffer>, options: DatabaseDumpCodecOptions = {}): AsyncGenerator<BackupPart, DatabaseDumpDescriptor, void> {
 const ceiling = chunkSize(options), digest = createHash('sha256'), names: string[] = [];
 demand(source && typeof source[Symbol.asyncIterator] === 'function', 'BACKUP_FORMAT', 'SQL encoder requires a byte stream.');
 let total = 0, stored = 0, pendingBytes = 0;
 // One fixed accumulator bounds both original bytes and allocation metadata,
 // even if the upstream stream emits one-byte input buffers.
 const pending = Buffer.allocUnsafe(ceiling);
 const encode = (): BackupPart => {
  demand(pendingBytes > 0 && pendingBytes <= ceiling && names.length < MAX_SQL_PARTS, 'BACKUP_SIZE_LIMIT', 'SQL part inventory exceeds its bounded byte or count limit.');
  const bytes = pending.subarray(0, pendingBytes), name = partName(names.length + 1);
  pendingBytes = 0;
  const part = encodeBackupPart(name, bytes);
  stored += Buffer.byteLength(part.bytes_base64, 'base64');
  demand(Number.isSafeInteger(stored) && stored <= MAX_RECOVERY_STORED_BYTES, 'BACKUP_SIZE_LIMIT', 'Stored SQL bytes exceed the 512 MiB archive ceiling.');
  names.push(name); return part;
 };
 for await (const bytes of source) {
  demand(Buffer.isBuffer(bytes), 'BACKUP_FORMAT', 'SQL stream entries must be bytes; implicit text encoding is forbidden.');
  total += bytes.length;
  demand(Number.isSafeInteger(total) && total <= MAX_RECOVERY_LOGICAL_BYTES, 'BACKUP_SIZE_LIMIT', 'SQL bytes exceed the 1 GiB logical archive ceiling.');
  digest.update(bytes);
  // Copy each slice: a producer may reuse its input buffer after yielding it.
  // References to a large source buffer never become the pending part inventory.
  for (let offset = 0; offset < bytes.length;) {
   const size = Math.min(ceiling - pendingBytes, bytes.length - offset);
   bytes.copy(pending, pendingBytes, offset, offset + size); pendingBytes += size; offset += size;
   if (pendingBytes === ceiling) yield encode();
  }
 }
 demand(total > 0, 'BACKUP_FORMAT', 'A successful plain SQL dump cannot be empty.');
 if (pendingBytes) yield encode();
 return {format: 'plain_sql_chunks', size_bytes: total, sha256: digest.digest('hex'), parts: names};
}

function databaseInventory(descriptor: DatabaseDumpDescriptor, archiveParts: readonly BackupPart[], ceiling: number): BackupPart[] {
 demand(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) && Object.keys(descriptor).sort().join(',') === 'format,parts,sha256,size_bytes' && descriptor.format === 'plain_sql_chunks', 'BACKUP_FORMAT', 'SQL dump descriptor must use the finite chunk format.');
 demand(Number.isSafeInteger(descriptor.size_bytes) && descriptor.size_bytes > 0 && descriptor.size_bytes <= MAX_RECOVERY_LOGICAL_BYTES, 'BACKUP_SIZE_LIMIT', 'SQL descriptor exceeds the 1 GiB logical ceiling or has an invalid size.');
 demand(typeof descriptor.sha256 === 'string' && /^[a-f0-9]{64}$/.test(descriptor.sha256) && Array.isArray(descriptor.parts) && descriptor.parts.length > 0 && descriptor.parts.length <= MAX_SQL_PARTS, 'BACKUP_FORMAT', 'SQL descriptor requires a checksum and finite ordered part names.');
 demand(Array.isArray(archiveParts) && archiveParts.length <= MAX_SQL_PARTS, 'BACKUP_SIZE_LIMIT', 'Recovery inventory exceeds 20,000 parts.');
 demand(descriptor.parts.length === Math.ceil(descriptor.size_bytes / ceiling), 'BACKUP_MANIFEST_MISMATCH', 'SQL part count differs from its declared byte size and chunk format.');
 for (let index = 0; index < descriptor.parts.length; index++) demand(descriptor.parts[index] === partName(index + 1), 'BACKUP_MANIFEST_MISMATCH', 'SQL part names must be ordered, contiguous and unique.');
 const sql: BackupPart[] = [];
 for (const part of archiveParts) {
  demand(part && typeof part.name === 'string', 'BACKUP_FORMAT', 'Every archive part needs a finite name.');
  demand(part.name !== 'database.sql', 'BACKUP_MANIFEST_MISMATCH', 'Legacy and chunked SQL cannot be mixed.');
  if (part.name.startsWith('database/')) sql.push({name: part.name, sha256: part.sha256, size_bytes: part.size_bytes, bytes_base64: part.bytes_base64, ...(part.encoding === undefined ? {} : {encoding: part.encoding})});
 }
 demand(sql.length === descriptor.parts.length, 'BACKUP_MANIFEST_MISMATCH', 'SQL parts must exactly match the signed descriptor inventory.');
 let stored = 0;
 for (let index = 0; index < sql.length; index++) {
  const part = sql[index]!; demand(part.name === descriptor.parts[index], 'BACKUP_MANIFEST_MISMATCH', 'Stored SQL parts differ from their exact signed ordering.');
  assertPartMetadata(part, 2);
  const expectedSize = index === sql.length - 1 ? descriptor.size_bytes - index * ceiling : ceiling;
  demand(part.size_bytes === expectedSize && part.size_bytes > 0 && part.size_bytes <= ceiling, 'BACKUP_MANIFEST_MISMATCH', 'SQL chunk size differs from the fixed byte-boundary format.');
  stored += Buffer.byteLength(part.bytes_base64, 'base64');
  demand(Number.isSafeInteger(stored) && stored <= MAX_RECOVERY_STORED_BYTES, 'BACKUP_SIZE_LIMIT', 'Stored SQL bytes exceed the 512 MiB archive ceiling.');
 }
 return sql;
}

/**
 * Validate every original SQL byte before the first yield, then decode the
 * snapshotted scalar part metadata again one part at a time. A caller changing
 * archive metadata between next() calls cannot change the validated stream.
 * Root verifies/signs the full envelope and other parts before creating a DB.
 */
export function* decodeDatabaseDump(descriptor: DatabaseDumpDescriptor, archiveParts: readonly BackupPart[], options: DatabaseDumpCodecOptions = {}): Generator<Buffer, void, void> {
 const ceiling = chunkSize(options), parts = databaseInventory(descriptor, archiveParts, ceiling), digest = createHash('sha256');
 let total = 0;
 for (const part of parts) {const bytes = decodeBackupPart(part, 2); total += bytes.length; demand(Number.isSafeInteger(total) && total <= MAX_RECOVERY_LOGICAL_BYTES, 'BACKUP_SIZE_LIMIT', 'Decoded SQL exceeds the logical archive ceiling.'); digest.update(bytes);}
 demand(total === descriptor.size_bytes && digest.digest('hex') === descriptor.sha256, 'BACKUP_CHECKSUM_FAILED', 'Full original SQL size/checksum differs; no SQL bytes were published.');
 for (const part of parts) yield decodeBackupPart(part, 2);
}
