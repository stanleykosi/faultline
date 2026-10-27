import test, {describe, test as test36} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPairSync, randomBytes, randomUUID, createCipheriv, sign, createHash} from 'node:crypto';
import {canonical, hash, byteHash} from '../../packages/core/src/canonical.js';
import {readBundle, type BackupManifest, type BackupBundle} from './backup.js';
import {encodeBackupPart, partDescriptor, decodeBackupPart, assertPartInventoryLimits, serializeBackupFrame, assertBackupFrameCapacity, MAX_RECOVERY_FRAME_BYTES, MAX_RECOVERY_PART_BYTES, MAX_RECOVERY_LOGICAL_BYTES, type BackupPart} from './backup-parts.js';
import {DomainError} from '../../packages/core/src/errors.js';
import {gzipSync} from 'node:zlib';
import {encodeDatabaseDump, decodeDatabaseDump, DEFAULT_SQL_CHUNK_BYTES, type DatabaseDumpDescriptor} from './backup-sql.js';
import {assertRecoveryCapacity, MIN_RECOVERY_FREE_BYTES} from './recovery-capacity.js';
import {createIsolatedDatabaseSql} from './restore.js';
import Fastify from 'fastify';
import {installExportMetadataDiagnostics} from '../../apps/api/src/export-diagnostics.js';

describe("backup envelope", async () => {
  test('real authenticated envelope verifies original compressed bytes and refuses unsigned descriptors before decoding', { timeout: 15000 }, async () => {
      const root = path.resolve('.runtime/backup-codec-acceptance', randomUUID());
      await fs.mkdir(root, { recursive: true });
      const pair = generateKeyPairSync('ed25519'), wrapping = randomBytes(32), wrap = path.join(root, 'wrap.key'), publicPath = path.join(root, 'trusted-public.pem');
      await fs.writeFile(wrap, wrapping, { flag: 'wx' });
      await fs.writeFile(publicPath, pair.publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx' });
      const names = ['database.sql', 'keys/keyring.json', 'keys/report-private.pem', 'keys/report-public.pem', 'keys/recovery-secrets.json'], raw = names.map((name, i) => Buffer.from('independent fixture ' + i + ' ' + name + '\n'.repeat(50))), parts = names.map((name, i) => encodeBackupPart(name, raw[i]!));
      const manifest = { schema_version: 2, id: randomUUID(), created_at: '2026-10-11T00:00:00.000Z', application_version: '0.1.0', snapshot_method: 'exported_repeatable_read', offline: true, source_database: 'codec_fixture', database: { inventory_version: 2 }, object_count: 0, key_versions: ['test'], report_signing_key_versions: [], parts: parts.map(partDescriptor), signer_sha256: byteHash(pair.publicKey.export({ format: 'der', type: 'spki' })), completion: 'complete', external_effects: 'paused' } as unknown as BackupManifest;
      const signed = (m: BackupManifest, p: typeof parts): BackupBundle => ({ manifest: m, manifest_hash: hash(m), signature: sign(null, Buffer.from(canonical(m)), pair.privateKey).toString('base64'), parts: p });
      const write = async (bundle: BackupBundle, flip = false) => { const magic = Buffer.from('FAULTLINE_BACKUP_V1\n'), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrapping, iv); cipher.setAAD(magic); const body = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]), bytes = Buffer.concat([magic, iv, cipher.getAuthTag(), body]); if (flip)
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; const file = path.join(root, randomUUID() + '.flbackup'); await fs.writeFile(file, bytes, { flag: 'wx' }); return file; };
      const current = signed(manifest, parts), file = await write(current);
      assert.equal((await readBundle(file, wrap, publicPath)).manifest_hash, hash(manifest));
      const rejected = async (bundle: BackupBundle, code: string, flip = false) => { const candidate = await write(bundle, flip); await assert.rejects(readBundle(candidate, wrap, publicPath), (e: unknown) => e instanceof DomainError && e.code === code); };
      await rejected({ ...current, parts: parts.map((p, i) => i ? p : { ...p, size_bytes: 256 * 1024 * 1024, bytes_base64: 'not a compressed payload' }) }, 'BACKUP_MANIFEST_MISMATCH');
      await rejected({ ...current, parts: parts.map((p, i) => i ? p : { ...p, bytes_base64: 'AA==' }) }, 'BACKUP_DECOMPRESSION_FAILED');
      await rejected({ ...current, manifest: { ...manifest, object_count: 1 } }, 'BACKUP_SIGNATURE_FAILED');
      await rejected(current, 'BACKUP_AUTHENTICATION_FAILED', true);
      const chunk = encodeBackupPart('database/000001.sql', raw[0]!), chunkParts = [chunk, ...parts.slice(1)], chunkManifest: BackupManifest = { ...manifest, schema_version: 3, database_dump: { format: 'plain_sql_chunks', size_bytes: raw[0]!.length, sha256: byteHash(raw[0]!), parts: [chunk.name] }, parts: chunkParts.map(partDescriptor) };
      assert.equal((await readBundle(await write(signed(chunkManifest, chunkParts)), wrap, publicPath)).manifest.schema_version, 3);
      await rejected(signed({ ...chunkManifest, database_dump: { ...chunkManifest.database_dump!, sha256: '0'.repeat(64) } }, chunkParts), 'BACKUP_CHECKSUM_FAILED');
      const { database_dump: omittedDump, ...missingDump } = chunkManifest;
      void omittedDump;
      await rejected(signed(missingDump, chunkParts), 'BACKUP_MANIFEST_MISMATCH');
      const mixed = [parts[0]!, ...chunkParts];
      await rejected(signed({ ...chunkManifest, parts: mixed.map(partDescriptor) }, mixed), 'BACKUP_MANIFEST_MISMATCH');
      await rejected(signed({ ...manifest, database_dump: chunkManifest.database_dump }, parts), 'BACKUP_MANIFEST_MISMATCH');
      const gap = [{ ...chunk, name: 'database/000002.sql' }, ...parts.slice(1)];
      await rejected(signed({ ...chunkManifest, database_dump: { ...chunkManifest.database_dump!, parts: ['database/000002.sql'] }, parts: gap.map(partDescriptor) }, gap), 'BACKUP_MANIFEST_MISMATCH');
      const legacyParts = parts.map((p, i) => ({ name: p.name, sha256: byteHash(raw[i]!), size_bytes: raw[i]!.length, bytes_base64: raw[i]!.toString('base64') })), legacyManifest = { ...manifest, schema_version: 1 as const, parts: legacyParts.map(partDescriptor) };
      assert.equal((await readBundle(await write(signed(legacyManifest, legacyParts)), wrap, publicPath)).manifest.schema_version, 1);
  });
});

describe("backup parts", async () => {
  const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  
  test('compressed and legacy backup parts preserve independently authored binary and exact UTC6 UTF8 bytes', () => {
      for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 1, 128]), Buffer.from('café🧭\n2026-01-01T00:00:00.000001Z\n'.repeat(1000))]) {
          const part = encodeBackupPart('objects/fixture', bytes);
          assert.equal(part.sha256, digest(bytes));
          assert.equal(part.size_bytes, bytes.length);
          assert.equal(part.encoding, 'gzip');
          assert.deepEqual(decodeBackupPart(part, 2), bytes);
          assert.deepEqual(partDescriptor(part), { name: part.name, sha256: digest(bytes), size_bytes: bytes.length, encoding: 'gzip' });
          const legacy = { name: part.name, sha256: digest(bytes), size_bytes: bytes.length, bytes_base64: bytes.toString('base64') };
          assert.deepEqual(decodeBackupPart(legacy, 1), bytes);
          assert.deepEqual(partDescriptor(legacy), { name: part.name, sha256: digest(bytes), size_bytes: bytes.length });
      }
  });
  
  test('compression cannot hide expansion, changed original hashes, unknown encodings or truncation', () => {
      const bytes = Buffer.from('independent original'.repeat(4096)), part = encodeBackupPart('database.sql', bytes), reject = (value: typeof part, version: 1 | 2 = 2) => assert.throws(() => decodeBackupPart(value, version), (e: unknown) => e instanceof DomainError);
      reject({ ...part, size_bytes: 1 });
      reject({ ...part, sha256: '0'.repeat(64) });
      reject({ ...part, encoding: undefined });
      reject({ ...part, encoding: 'brotli' as 'gzip' });
      reject(part, 1);
      reject({ ...part, bytes_base64: part.bytes_base64 + '!' });
      reject({ ...part, bytes_base64: Buffer.from(part.bytes_base64, 'base64').subarray(0, 10).toString('base64') });
      reject({ ...part, bytes_base64: gzipSync(Buffer.from('wrong bytes')).toString('base64') });
      for (const size_bytes of [-1, NaN, Infinity, MAX_RECOVERY_PART_BYTES + 1])
          reject({ ...part, size_bytes });
  });
  
  test('whole inventory expansion is refused before decoding any compressed payload', () => {
      const fake = { name: 'database.sql', sha256: '0'.repeat(64), size_bytes: MAX_RECOVERY_PART_BYTES, bytes_base64: 'AA==', encoding: 'gzip' as const };
      assertPartInventoryLimits([fake], 2);
      assert.throws(() => assertPartInventoryLimits(Array(5).fill(fake), 2), (e: unknown) => e instanceof DomainError && e.code === 'BACKUP_SIZE_LIMIT');
      assert.throws(() => assertPartInventoryLimits([{ ...fake, size_bytes: MAX_RECOVERY_LOGICAL_BYTES + 1 }], 1));
      assert.throws(() => assertPartInventoryLimits([{ ...fake, size_bytes: NaN }], 2));
      assert.throws(() => assertPartInventoryLimits(Array(20001).fill({ ...fake, size_bytes: 0 }), 2));
  });
  
  test('base64 plus UTF8 metadata must fit the installed frame limit before full serialization', () => {
      assertBackupFrameCapacity(100, MAX_RECOVERY_FRAME_BYTES - 100);
      for (const pair of [[100, MAX_RECOVERY_FRAME_BYTES - 99], [NaN, 0], [-1, 1], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1]])
          assert.throws(() => assertBackupFrameCapacity(pair[0]!, pair[1]!), (e: unknown) => e instanceof DomainError && e.code === 'BACKUP_SIZE_LIMIT');
      const frame = { description: 'café🧭', parts: [encodeBackupPart('database.sql', Buffer.from('independent SQL bytes'))] };
      assert.equal(serializeBackupFrame(frame), JSON.stringify(frame));
  });
});

describe("backup sql", async () => {
  // Independently authored byte fixtures only; no PostgreSQL or restore execution.
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  
  async function* source(bytes: Buffer, inputBytes = 3) { for (let offset = 0; offset < bytes.length; offset += inputBytes)
      yield bytes.subarray(offset, offset + inputBytes); }
  
  async function encoded(bytes: Buffer, chunkBytes: number) { const generator = encodeDatabaseDump(source(bytes), { chunkBytes }), parts: BackupPart[] = []; let step = await generator.next(); while (!step.done) {
      parts.push(step.value);
      step = await generator.next();
  } return { parts, descriptor: step.value }; }
  
  const rejectsBeforeYield = (descriptor: DatabaseDumpDescriptor, parts: BackupPart[], chunkBytes: number, code?: string) => assert.throws(() => decodeDatabaseDump(descriptor, parts, { chunkBytes }).next(), (error: unknown) => error instanceof DomainError && (!code || error.code === code));
  
  test('byte chunks preserve binary, UTF8 and COPY lines across input/chunk boundaries, with full independent size/SHA and early bounded emission', async () => {
      assert.equal(DEFAULT_SQL_CHUNK_BYTES, 134217728);
      const bytes = Buffer.concat([Buffer.from([0, 255, 128, 1]), Buffer.from("COPY public.fixture (text_value) FROM stdin;\n1\tcafé🧭東京\n2\t" + 'long-COPY-line-🧭'.repeat(20) + '\n\\.\n', 'utf8')]), size = 5;
      const result = await encoded(bytes, size);
      assert.equal(result.descriptor.format, 'plain_sql_chunks');
      assert.equal(result.descriptor.size_bytes, bytes.length);
      assert.equal(result.descriptor.sha256, hash(bytes));
      assert.equal(result.parts.length, Math.ceil(bytes.length / size));
      assert.deepEqual(result.descriptor.parts, result.parts.map((part, index) => { assert.equal(part.name, 'database/' + String(index + 1).padStart(6, '0') + '.sql'); assert.equal(part.size_bytes, Math.min(size, bytes.length - index * size)); return part.name; }));
      // Individual boundaries deliberately cut multibyte UTF8 and a SQL COPY line.
      assert.ok(result.parts.length > 2);
      assert.deepEqual(Buffer.concat([...decodeDatabaseDump(result.descriptor, [...result.parts, encodeBackupPart('keys/fixture', Buffer.from('key fixture'))], { chunkBytes: size })]), bytes);
      let consumed = 0;
      async function* boundedSource() { for (const value of ['abcd', 'efgh', 'ijkl']) {
          consumed++;
          yield Buffer.from(value);
      } }
      const stream = encodeDatabaseDump(boundedSource(), { chunkBytes: 4 }), first = await stream.next();
      assert.equal(first.done, false);
      assert.equal(consumed, 1, 'The first part emits without consuming or buffering the full dump.');
      const second = await stream.next();
      assert.equal(second.done, false);
      assert.equal(consumed, 2);
      const third = await stream.next();
      assert.equal(third.done, false);
      const done = await stream.next();
      assert.equal(done.done, true);
      if (done.done) {
          assert.equal(done.value.size_bytes, 12);
          assert.equal(done.value.sha256, hash(Buffer.from('abcdefghijkl')));
      }
  });
  
  test('ordered inventory and every checksum validate before any SQL is yielded; swapped/missing/duplicate/gap/legacy/fullhash/size tampering cannot publish', async () => {
      const original = Buffer.from('COPY x FROM stdin;\ncafé🧭\n\\.\n'), chunkBytes = 8, result = await encoded(original, chunkBytes), clone = () => result.parts.map(part => ({ ...part }));
      const swapped = clone();
      [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
      rejectsBeforeYield(result.descriptor, swapped, chunkBytes, 'BACKUP_MANIFEST_MISMATCH');
      rejectsBeforeYield(result.descriptor, clone().slice(1), chunkBytes, 'BACKUP_MANIFEST_MISMATCH');
      const duplicated = clone();
      duplicated[1] = { ...duplicated[0]! };
      rejectsBeforeYield(result.descriptor, duplicated, chunkBytes, 'BACKUP_MANIFEST_MISMATCH');
      rejectsBeforeYield({ ...result.descriptor, parts: result.descriptor.parts.map((name, index) => index === 1 ? 'database/000003.sql' : name) }, clone(), chunkBytes, 'BACKUP_MANIFEST_MISMATCH');
      rejectsBeforeYield(result.descriptor, [...clone(), encodeBackupPart('database.sql', original)], chunkBytes, 'BACKUP_MANIFEST_MISMATCH');
      rejectsBeforeYield({ ...result.descriptor, sha256: '0'.repeat(64) }, clone(), chunkBytes, 'BACKUP_CHECKSUM_FAILED');
      rejectsBeforeYield({ ...result.descriptor, size_bytes: result.descriptor.size_bytes + 1 }, clone(), chunkBytes, 'BACKUP_MANIFEST_MISMATCH');
      const changedOriginal = Buffer.from(original), lastIndex = changedOriginal.length - 1, lastByte = changedOriginal[lastIndex];
      assert.ok(lastByte !== undefined);
      changedOriginal[lastIndex] = lastByte ^ 1;
      const validIndividualTamper = await encoded(changedOriginal, chunkBytes);
      rejectsBeforeYield(result.descriptor, validIndividualTamper.parts, chunkBytes, 'BACKUP_CHECKSUM_FAILED');
      const brokenFinal = clone();
      brokenFinal[brokenFinal.length - 1] = { ...brokenFinal.at(-1)!, sha256: 'f'.repeat(64) };
      rejectsBeforeYield(result.descriptor, brokenFinal, chunkBytes, 'BACKUP_CHECKSUM_FAILED');
      const immutable = clone(), decoder = decodeDatabaseDump(result.descriptor, immutable, { chunkBytes }), first = decoder.next();
      assert.ok(!first.done);
      immutable[1]!.bytes_base64 = 'AA==';
      immutable[1]!.sha256 = '0'.repeat(64);
      result.descriptor.parts[1] = 'database/999999.sql';
      assert.deepEqual(Buffer.concat([first.value, ...decoder]), original, 'Validated metadata snapshots cannot be changed between yielded chunks.');
  });
  
  test('invalid chunk configuration, declared logical overflow, empty input and20,001 tiny SQL parts are refused honestly', async () => {
      for (const chunkBytes of [0, -1, NaN, Infinity, 1.5, DEFAULT_SQL_CHUNK_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
          await assert.rejects(encodeDatabaseDump(source(Buffer.from('sql')), { chunkBytes }).next(), (error: unknown) => error instanceof DomainError && error.code === 'BACKUP_SIZE_LIMIT');
      }
      await assert.rejects(encodeDatabaseDump(source(Buffer.alloc(0)), { chunkBytes: 1 }).next(), (error: unknown) => error instanceof DomainError && error.code === 'BACKUP_FORMAT');
      rejectsBeforeYield({ format: 'plain_sql_chunks', size_bytes: MAX_RECOVERY_LOGICAL_BYTES + 1, sha256: 'a'.repeat(64), parts: ['database/000001.sql'] }, [], DEFAULT_SQL_CHUNK_BYTES, 'BACKUP_SIZE_LIMIT');
      rejectsBeforeYield({ format: 'plain_sql_chunks', size_bytes: NaN, sha256: 'a'.repeat(64), parts: ['database/000001.sql'] }, [], 1, 'BACKUP_SIZE_LIMIT');
      const tooMany = encodeDatabaseDump(source(Buffer.alloc(20001, 42), 1000), { chunkBytes: 1 });
      await assert.rejects(async () => { for await (const ignored of tooMany)
          void ignored; }, (error: unknown) => error instanceof DomainError && error.code === 'BACKUP_SIZE_LIMIT');
  });
});

describe("recovery capacity", async () => {
  test('recovery capacity rejects unknown and insufficient storage before any database or object work', () => {
      for (const bytes of [NaN, Infinity, -1, 0, MIN_RECOVERY_FREE_BYTES - 1, Number.MAX_SAFE_INTEGER + 1])
          assert.throws(() => assertRecoveryCapacity(bytes), (error: unknown) => error instanceof DomainError && error.code === 'RECOVERY_STORAGE_CAPACITY' && error.status === 503);
      assertRecoveryCapacity(MIN_RECOVERY_FREE_BYTES);
      assertRecoveryCapacity(MIN_RECOVERY_FREE_BYTES + 1);
  });
});

describe("restore database config", async () => {
  test36('isolated restore creates a database with the signed source encoding and locale', () => {
      assert.equal(createIsolatedDatabaseSql('faultline_restore_1791904293614_7389be3d', { encoding: 'UTF8', collation: 'C', ctype: 'C' }), 'CREATE DATABASE "faultline_restore_1791904293614_7389be3d" TEMPLATE template0 ENCODING \'UTF8\' LC_COLLATE \'C\' LC_CTYPE \'C\'');
      assert.match(createIsolatedDatabaseSql('faultline_restore_1791904293614_7389be3d', { encoding: 'WIN1252', collation: 'English_United States.1252', ctype: 'English_United States.1252' }), /LC_COLLATE 'English_United States\.1252'/);
  });
  
  test36('isolated restore refuses malformed database identities and locale SQL', () => {
      const database = 'faultline_restore_1791904293614_7389be3d';
      const configuration = { encoding: 'UTF8', collation: 'C', ctype: 'C' };
      for (const name of ['faultline', 'faultline_restore_1_bad', 'faultline_restore_1791904293614_7389be3d; DROP DATABASE faultline']) {
          assert.throws(() => createIsolatedDatabaseSql(name, configuration));
      }
      for (const locale of ["C'; DROP DATABASE faultline; --", 'C\\u0000']) {
          assert.throws(() => createIsolatedDatabaseSql(database, { ...configuration, collation: locale }));
      }
  });
});

describe("export diagnostics", async () => {
  test('opt-in export metadata preserves exact response bytes and omits credentials, private paths and body', async () => {
      const app = Fastify({ requestIdHeader: false, genReqId: () => 'independent-server-id' }), records: object[] = [];
      installExportMetadataDiagnostics(app, true, value => records.push(value));
      const bytes = Buffer.from([0, 255, 80, 75, 1]);
      app.get('/exports/:exportId', async (_r, reply) => { reply.type('application/zip').header('content-disposition', 'attachment; filename="fixture.zip"'); return bytes; });
      app.get('/health', async () => ({ status: 'alive' }));
      try {
          const attempt = '123e4567-e89b-12d3-a456-426614174000', response = await app.inject({ url: '/exports/generated', headers: { cookie: 'private-cookie', authorization: 'private-token', 'x-faultline-download-attempt': attempt } });
          assert.equal(response.statusCode, 200);
          assert.deepEqual(response.rawPayload, bytes);
          assert.equal(response.headers['x-request-id'], 'independent-server-id');
          assert.equal(records.length, 2);
          assert.equal((records[0] as {
              byte_length: number;
          }).byte_length, 5);
          assert.equal((records[0] as {
              download_attempt: string;
          }).download_attempt, attempt);
          assert.equal((records[1] as {
              phase: string;
              download_attempt: string;
          }).phase, 'response_finished');
          assert.equal((records[1] as {
              download_attempt: string;
          }).download_attempt, attempt);
          for (const secret of ['private-cookie', 'private-token', 'generated', 'filename', 'body', 'signature'])
              assert(!JSON.stringify(records).includes(secret));
          await app.inject('/health');
          assert.equal(records.length, 2);
      }
      finally {
          await app.close();
      }
  });
  
  test('disabled diagnostics produce no metadata or diagnostic response header', async () => {
      const app = Fastify(), records: object[] = [];
      installExportMetadataDiagnostics(app, false, value => records.push(value));
      app.get('/exports/:exportId', async () => Buffer.from('fixture'));
      try {
          const response = await app.inject('/exports/generated');
          assert.equal(response.headers['x-request-id'], undefined);
          assert.deepEqual(records, []);
          assert.equal(response.payload, 'fixture');
      }
      finally {
          await app.close();
      }
  });
});
