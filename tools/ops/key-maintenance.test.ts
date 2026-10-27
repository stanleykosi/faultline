import test, {describe, test as test22} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {open, seal} from '../../packages/core/src/secrets/keyring.js';
import {keyRetirementBlockers, reencryptEnvelope, verifiedKeyRetirementBasis} from './key-maintenance.js';
import {type RecoveryStatus} from '../../packages/core/src/retention/recovery-receipts.js';
import {byteHash} from '../../packages/core/src/canonical.js';
import {completeReencryptionBatch, completeReencryptionOperation, stageReencryptionBatch, startReencryptionCheckpoint, validateCheckpointResume, verifyReencryptionCheckpoint, type CheckpointEnvelope} from './key-maintenance-checkpoint.js';
import {retainedKeyring} from './rotate-keys.js';
import {sessionPseudonym} from '../../packages/core/src/privacy/identity.js';
import {verifyRecoveryEnvelopes} from './recovery-ciphertexts.js';

describe("key maintenance", async () => {
  test('synthetic ciphertext re-encryption authenticates scope and is idempotent at the active version', () => {
      const ring = { active: 'new', keys: { old: randomBytes(32).toString('base64'), new: randomBytes(32).toString('base64') } }, aad = 'generated-workspace:generated-secret:4';
      const before = seal('synthetic test credential only', aad, { active: 'old', keys: { old: ring.keys.old! } }), first = reencryptEnvelope(before, aad, ring);
      assert.equal(first.changed, true);
      assert.notEqual(first.ciphertext, before);
      assert.equal(open(first.ciphertext, aad, ring), 'synthetic test credential only');
      const retry = reencryptEnvelope(first.ciphertext, aad, ring);
      assert.deepEqual(retry, { ciphertext: first.ciphertext, changed: false });
      assert.throws(() => open(first.ciphertext, 'another-workspace:generated-secret:4', ring));
  });
  
  test('unknown or unauthenticated synthetic envelopes fail closed before updates', () => {
      const ring = { active: 'new', keys: { new: randomBytes(32).toString('base64') } }, aad = 'generated:secret:1';
      assert.throws(() => reencryptEnvelope(JSON.stringify({ version: 1, key_version: 'missing' }), aad, ring));
      const wrong = seal('synthetic payload', aad, { active: 'new', keys: ring.keys });
      assert.throws(() => reencryptEnvelope(wrong, 'wrong:secret:1', ring));
  });
  
  test('key retirement stays blocked by any ciphertext or pinned pseudonym policy', () => {
      assert.deepEqual(keyRetirementBlockers('old', ['new', 'old'], []), { ciphertexts: 1, pinned_policies: 0 });
      assert.deepEqual(keyRetirementBlockers('old', [], ['old']), { ciphertexts: 0, pinned_policies: 1 });
      assert.deepEqual(keyRetirementBlockers('old', ['new'], ['new']), { ciphertexts: 0, pinned_policies: 0 });
      assert.throws(() => keyRetirementBlockers('../old', [], []));
  });
  
  test('old-key retirement needs one signed archive and later isolated restore preserving both key versions', () => {
      const backup: RecoveryStatus = { status: 'verified', recorded_at: '2026-10-14T10:00:00.000Z', manifest_hash: 'a'.repeat(64), archive_sha256: 'b'.repeat(64), key_versions: ['active', 'old'], detail: 'authenticated_archive' }, restore: RecoveryStatus = { status: 'verified', recorded_at: '2026-10-14T10:05:00.000Z', manifest_hash: 'a'.repeat(64), archive_sha256: 'b'.repeat(64), key_versions: ['active', 'old'], detail: 'isolated_restore_bound_to_archive' };
      assert.deepEqual(verifiedKeyRetirementBasis({ backup, restore }, 'active', 'old'), { backup_archive_sha256: 'b'.repeat(64), restore_archive_sha256: 'b'.repeat(64), backup_manifest_sha256: 'a'.repeat(64), restore_manifest_sha256: 'a'.repeat(64), backup_recorded_at: backup.recorded_at, restore_recorded_at: restore.recorded_at });
      assert.throws(() => verifiedKeyRetirementBasis({ backup, restore: { ...restore, archive_sha256: 'c'.repeat(64) } }, 'active', 'old'));
      assert.throws(() => verifiedKeyRetirementBasis({ backup, restore: { ...restore, recorded_at: '2026-10-13T10:05:00.000Z' } }, 'active', 'old'));
      assert.throws(() => verifiedKeyRetirementBasis({ backup, restore: { ...restore, key_versions: ['active'] } }, 'active', 'old'));
      assert.throws(() => verifiedKeyRetirementBasis({ backup: { ...backup, status: 'unverified' }, restore }, 'active', 'old'));
  });
});

describe("key maintenance checkpoint", async () => {
  const active = 'active-v2', old = 'old-v1';
  
  function fixture() {
      const ring = { active: active, keys: { [old]: randomBytes(32).toString('base64'), [active]: randomBytes(32).toString('base64') } }, oldRing = { active: old, keys: { [old]: ring.keys[old]! } }, rows: CheckpointEnvelope[] = [];
      for (let index = 0; index < 3; index++) {
          const identity = `secret:generated-workspace:${String(index).padStart(2, '0')}`, aad = `generated-workspace:generated-secret:${index}`;
          rows.push({ identity, aad, key_version: old, ciphertext: seal(`synthetic credential ${index}`, aad, oldRing) });
      }
      const key = Buffer.from(ring.keys[active]!, 'base64'), plaintextHash = (row: CheckpointEnvelope) => byteHash(Buffer.from(open(row.ciphertext, row.aad, ring)));
      return { ring, key, rows, plaintextHash };
  }
  
  function commitBatch(rows: CheckpointEnvelope[], batch: CheckpointEnvelope[], ring: {
      active: string;
      keys: Record<string, string>;
  }) {
      const old = Object.fromEntries(batch.map(row => { const envelope = JSON.parse(row.ciphertext) as {
          key_version: string;
      }; return [envelope.key_version, ring.keys[envelope.key_version]!]; }));
      return rows.map(row => batch.some(item => item.identity === row.identity) ? { ...row, key_version: ring.active, ciphertext: seal(open(row.ciphertext, row.aad, { active: JSON.parse(row.ciphertext).key_version, keys: old }), row.aad, ring) } : row);
  }
  
  test('checkpointed batches sign exact inventory and advance only after the batch commits', () => {
      const f = fixture(), started = startReencryptionCheckpoint({ operation_id: randomUUID(), active_key_version: active, rows: f.rows, now: '2026-10-14T00:00:00.000Z' }, f.key);
      assert.equal(verifyReencryptionCheckpoint(started, f.key, active).remaining_hash, started.remaining_hash);
      const first = f.rows.slice(0, 2), remaining = f.rows.slice(2), staged = stageReencryptionBatch(started, first, remaining, f.plaintextHash, f.key, '2026-10-14T00:01:00.000Z');
      assert.deepEqual(validateCheckpointResume(staged, f.rows, active, f.plaintextHash).stagedRows.map(row => row.identity), first.map(row => row.identity));
      assert.deepEqual(validateCheckpointResume(staged, f.rows, active, f.plaintextHash).remainingRows.map(row => row.identity), remaining.map(row => row.identity));
      const committed = commitBatch(f.rows, first, f.ring), next = completeReencryptionBatch(staged, { rewritten: 2, already_current: 0 }, committed, f.key, '2026-10-14T00:02:00.000Z');
      assert.equal(next.cursor, first.at(-1)?.identity);
      assert.equal(next.rewritten, 2);
      assert.notEqual(next.remaining_hash, started.remaining_hash);
      assert.equal(validateCheckpointResume(next, committed, active, f.plaintextHash).remainingRows.length, 1);
  });
  
  test('restart recovers a database commit that happened before the checkpoint cursor advanced', () => {
      const f = fixture(), started = startReencryptionCheckpoint({ operation_id: randomUUID(), active_key_version: active, rows: f.rows }, f.key), source = f.rows.slice(0, 2), remaining = f.rows.slice(2), staged = stageReencryptionBatch(started, source, remaining, f.plaintextHash, f.key);
      const committed = f.rows.map(row => source.some(item => item.identity === row.identity) ? { ...row, key_version: active, ciphertext: seal(open(row.ciphertext, row.aad, { active: old, keys: { [old]: f.ring.keys[old]! } }), row.aad, f.ring) } : row);
      const resumed = validateCheckpointResume(staged, committed, active, f.plaintextHash);
      assert.equal(resumed.stagedRows.every(row => row.key_version === active), true);
      const next = completeReencryptionBatch(staged, { rewritten: 2, already_current: 0 }, committed, f.key);
      assert.equal(next.rewritten, 2);
      assert.equal(validateCheckpointResume(next, committed, active, f.plaintextHash).remainingRows.length, 1);
  });
  
  test('pre-commit crash remains retryable and altered or unauthenticated state blocks resume', () => {
      const f = fixture(), started = startReencryptionCheckpoint({ operation_id: randomUUID(), active_key_version: active, rows: f.rows }, f.key), staged = stageReencryptionBatch(started, f.rows.slice(0, 1), f.rows.slice(1), f.plaintextHash, f.key);
      assert.equal(validateCheckpointResume(staged, f.rows, active, f.plaintextHash).stagedRows[0]?.key_version, old);
      const changed = f.rows.map((row, index) => index === 2 ? { ...row, ciphertext: seal('changed generated credential', row.aad, f.ring), key_version: active } : row);
      assert.throws(() => validateCheckpointResume(staged, changed, active, f.plaintextHash), /Unprocessed envelopes changed/);
      const first = f.rows.slice(0, 1), afterFirst = commitBatch(f.rows, first, f.ring), committedCheckpoint = completeReencryptionBatch(stageReencryptionBatch(started, first, f.rows.slice(1), f.plaintextHash, f.key), { rewritten: 1, already_current: 0 }, afterFirst, f.key), alteredProcessed = afterFirst.map(row => row.identity === first[0]!.identity ? { ...row, ciphertext: seal('altered after committed batch', row.aad, f.ring) } : row);
      assert.throws(() => validateCheckpointResume(committedCheckpoint, alteredProcessed, active, f.plaintextHash), /committed envelope changed/);
      const forged = { ...staged, remaining_hash: 'f'.repeat(64) };
      assert.throws(() => verifyReencryptionCheckpoint(forged, f.key, active), /authentication failed/);
      assert.throws(() => verifyReencryptionCheckpoint(staged, f.key, old), /different active key version/);
  });
  
  test('completed checkpoint is explicit and cannot hide remaining old-key envelopes', () => {
      const f = fixture(), started = startReencryptionCheckpoint({ operation_id: randomUUID(), active_key_version: active, rows: [] }, f.key);
      const complete = completeReencryptionOperation(started, [], f.key, '2026-10-14T00:03:00.000Z');
      assert.equal(complete.status, 'complete');
      assert.equal(complete.completed_at, '2026-10-14T00:03:00.000Z');
      assert.equal(verifyReencryptionCheckpoint(complete, f.key, active).status, 'complete');
      assert.throws(() => completeReencryptionOperation(startReencryptionCheckpoint({ operation_id: randomUUID(), active_key_version: active, rows: f.rows }, f.key), f.rows, f.key), /exact inventory is exhausted/);
  });
});

describe("rotate keys", async () => {
  test('retained AES version rotation preserves old ciphertext, authenticated scope and pinned source identity', () => {
      const before = { active: 'aes-v1', keys: { 'aes-v0': randomBytes(32).toString('base64'), 'aes-v1': randomBytes(32).toString('base64') } }, aad = 'workspace:secret:3', sealed = seal('Explicit test-only credential', aad, before), next = retainedKeyring(before, 'aes-v2', randomBytes(32));
      assert.equal(next.active, 'aes-v2');
      assert.equal(Object.keys(next.keys).length, 3);
      assert.equal(open(sealed, aad, next), 'Explicit test-only credential');
      assert.throws(() => open(sealed, 'another-workspace:secret:3', next));
      const fresh = seal('New test-only credential', aad, next);
      assert.equal(open(fresh, aad, next), 'New test-only credential');
      assert.throws(() => open(fresh, aad, before), /Unknown encryption key/);
      const pinned = Buffer.from(before.keys['aes-v1'], 'base64'), policy = { key_version: 'aes-v1', version: 'workspace-source-hmac-sha256-v1' };
      assert.equal(sessionPseudonym(pinned, 'wid', 'source', policy.version, 'raw-session'), sessionPseudonym(Buffer.from(next.keys[policy.key_version]!, 'base64'), 'wid', 'source', policy.version, 'raw-session'));
      assert.notEqual(sessionPseudonym(pinned, 'wid', 'source', policy.version, 'raw-session'), sessionPseudonym(pinned, 'other', 'source', policy.version, 'raw-session'));
      assert.throws(() => retainedKeyring(before, 'aes-v1', randomBytes(32)), /distinct/);
      assert.throws(() => retainedKeyring(before, 'aes-v3', Buffer.alloc(12)), /256/);
      assert.equal(before.active, 'aes-v1');
  });
  
  test('rotation rejects a thirty-third retained version before changing an archived recovery ceiling', () => { const keys = Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['v' + i, randomBytes(32).toString('base64')])); assert.throws(() => retainedKeyring({ active: 'v31', keys }, 'v32', randomBytes(32))); assert.equal(Object.keys(keys).length, 32); });
});

describe("recovery ciphertexts", async () => {
  test22('recovery verifies an encrypted pending capability under its retained version and exact independent AAD', () => { const old = randomBytes(32).toString('base64'), ring = { active: 'old', keys: { old } }, ciphertext = seal('Private generated capability', 'pending:token:key', ring), rotated = { active: 'new', keys: { old, new: randomBytes(32).toString('base64') } }; assert.equal(verifyRecoveryEnvelopes([{ ciphertext, aad: 'pending:token:key' }], rotated), 1); assert.throws(() => verifyRecoveryEnvelopes([{ ciphertext, aad: 'pending:token:other' }], rotated)); assert.throws(() => verifyRecoveryEnvelopes([{ ciphertext, aad: 'pending:token:key' }], { active: 'new', keys: { new: rotated.keys.new } })); });
});
