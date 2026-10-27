import test10, {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign, randomUUID} from 'node:crypto';
import {zipStored} from '../../packages/core/src/reports/zip.ts';
import {readFaultlineArchive, verifyFaultlineExport} from './verify-export-lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assertDirectory, readRegular, verifyInventory, assertPublicArchivePath} from '../../scripts/release-integrity.mjs';

describe("export verifier", async () => {
  const hash = b => createHash('sha256').update(b).digest('hex'), canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x), keys = generateKeyPairSync('ed25519'), publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  
  function archive(extra = [], alterManifest = () => { }) { const report = { id: 'independent-report', input_manifest_hash: 'a'.repeat(64), claim: { attribution: { causal_effect: 'not_established' } } }, content = Buffer.from(JSON.stringify(report)), evidence = Buffer.from('[]'), manifest = { schema_version: 1, report_id: report.id, input_manifest_hash: report.input_manifest_hash, report_hash: hash(Buffer.from(canonical(report))), signer_key_id: hash(keys.publicKey.export({ type: 'spki', format: 'der' })), files: [{ path: 'report.json', sha256: hash(content), size_bytes: content.length }, { path: 'evidence.json', sha256: hash(evidence), size_bytes: evidence.length }] }; alterManifest(manifest); return zipStored([{ path: 'report.json', bytes: content }, { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) }, { path: 'signature.txt', bytes: Buffer.from(sign(null, Buffer.from(canonical(manifest)), keys.privateKey).toString('base64')) }, { path: 'evidence.json', bytes: evidence }, ...extra]); }
  
  test('independently authored archive verifies signer and every file with bounded portable output', () => { const result = verifyFaultlineExport(archive(), publicPem); assert.equal(result.status, 'passed'); assert.equal(result.files.length, 2); assert.match(result.limitations.join(' '), /Does not establish current freshness/); });
  
  test('wrong trusted signer, unsigned extras and duplicate archive names fail closed', () => { assert.throws(() => verifyFaultlineExport(archive(), generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))); assert.throws(() => verifyFaultlineExport(archive([{ path: 'extra.txt', bytes: Buffer.from('unsigned') }]), publicPem)); assert.throws(() => verifyFaultlineExport(archive([{ path: 'report.json', bytes: Buffer.from('{}') }]), publicPem)); });
  
  test('correctly signed but false file digest or report identity cannot pass', () => { assert.throws(() => verifyFaultlineExport(archive([], m => m.files[0].sha256 = '0'.repeat(64)), publicPem)); assert.throws(() => verifyFaultlineExport(archive([], m => m.report_id = 'different-report'), publicPem)); });
  
  test('truncated or tampered ZIP bytes and unsupported dialect are rejected without extraction', () => { const bytes = archive(); assert.throws(() => readFaultlineArchive(bytes.subarray(0, bytes.length - 1))); const changed = Buffer.from(bytes); changed[50] ^= 1; assert.throws(() => readFaultlineArchive(changed)); const flags = Buffer.from(bytes); flags.writeUInt16LE(1, 6); assert.throws(() => readFaultlineArchive(flags)); });
});

describe("release integrity", async () => {
  test10('release reads reject real outside, junction and hardlink input redirection', async () => {
      const base = path.resolve('.runtime/release-integrity', randomUUID()), root = path.join(base, 'workspace'), outside = path.join(base, 'outside');
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside);
      const inside = path.join(root, 'plain.txt'), secret = path.join(outside, 'dummy.txt');
      await fs.writeFile(inside, 'allowed fixture');
      await fs.writeFile(secret, 'outside dummy fixture');
      assert.equal((await readRegular(root, inside)).toString(), 'allowed fixture');
      assert.equal(await assertDirectory(root, root), root);
      await assert.rejects(readRegular(root, secret), /outside workspace/);
      const redirect = path.join(root, 'redirect');
      await fs.symlink(outside, redirect, 'junction');
      try {
          await assert.rejects(assertDirectory(root, redirect), /must be real|redirection/);
          await assert.rejects(readRegular(root, path.join(redirect, 'dummy.txt')), /redirection/);
      }
      finally {
          await fs.unlink(redirect);
      }
      const linked = path.join(root, 'linked.txt');
      await fs.link(secret, linked);
      await assert.rejects(readRegular(root, linked), /regular unlinked file/);
  });
  
  test10('inventory requires unique exact paths, independently fixed sizes and hashes', () => {
      const a = Buffer.from('A'), b = Buffer.from('B'), descriptor = (name, bytes) => ({ path: name, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      const entries = new Map([['a', a], ['b', b]]), da = descriptor('a', a), db = descriptor('b', b);
      verifyInventory(entries, [da, db]);
      assert.throws(() => verifyInventory(entries, [da, da]), /Duplicate inventory path/);
      assert.throws(() => verifyInventory(entries, [da]), /exact inventory/);
      assert.throws(() => verifyInventory(entries, [da, { ...db, sha256: da.sha256 }]));
      assert.throws(() => verifyInventory(entries, [da, { ...db, size_bytes: 2 }]));
  });
  
  test10('only exact reviewed environment examples can enter public archives', () => {
      for (const name of ['ops/.env.example', 'ops/.env.live.example', 'ops/.env.runner.example', 'apps/web/src/main.tsx', '.gitignore', '.github/workflows/ci.yml'])
          assert.equal(assertPublicArchivePath(name), name);
      for (const name of ['.env', '.env.local', 'ops/.env/secret', 'ops/.env.ops', 'apps/.env.example', '.runtime/key', 'node_modules/pkg', '.git/config', '../outside', 'a\\b', 'C:/secret'])
          assert.throws(() => assertPublicArchivePath(name));
  });
});
