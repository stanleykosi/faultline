import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {open,seal} from '../../packages/core/src/secrets/keyring.js';
import {keyRetirementBlockers,reencryptEnvelope,verifiedKeyRetirementBasis} from './key-maintenance.js';
import type {RecoveryStatus} from '../../packages/core/src/retention/recovery-receipts.js';

test('synthetic ciphertext re-encryption authenticates scope and is idempotent at the active version',()=>{
 const ring={active:'new',keys:{old:randomBytes(32).toString('base64'),new:randomBytes(32).toString('base64')}},aad='generated-workspace:generated-secret:4';
 const before=seal('synthetic test credential only',aad,{active:'old',keys:{old:ring.keys.old!}}),first=reencryptEnvelope(before,aad,ring);
 assert.equal(first.changed,true);assert.notEqual(first.ciphertext,before);assert.equal(open(first.ciphertext,aad,ring),'synthetic test credential only');
 const retry=reencryptEnvelope(first.ciphertext,aad,ring);assert.deepEqual(retry,{ciphertext:first.ciphertext,changed:false});
 assert.throws(()=>open(first.ciphertext,'another-workspace:generated-secret:4',ring));
});

test('unknown or unauthenticated synthetic envelopes fail closed before updates',()=>{
 const ring={active:'new',keys:{new:randomBytes(32).toString('base64')}},aad='generated:secret:1';
 assert.throws(()=>reencryptEnvelope(JSON.stringify({version:1,key_version:'missing'}),aad,ring));
 const wrong=seal('synthetic payload',aad,{active:'new',keys:ring.keys});
 assert.throws(()=>reencryptEnvelope(wrong,'wrong:secret:1',ring));
});

test('key retirement stays blocked by any ciphertext or pinned pseudonym policy',()=>{
 assert.deepEqual(keyRetirementBlockers('old',['new','old'],[]),{ciphertexts:1,pinned_policies:0});
 assert.deepEqual(keyRetirementBlockers('old',[],['old']),{ciphertexts:0,pinned_policies:1});
 assert.deepEqual(keyRetirementBlockers('old',['new'],['new']),{ciphertexts:0,pinned_policies:0});
 assert.throws(()=>keyRetirementBlockers('../old',[],[]));
});

test('old-key retirement needs one signed archive and later isolated restore preserving both key versions',()=>{
 const backup:RecoveryStatus={status:'verified',recorded_at:'2026-10-14T10:00:00.000Z',manifest_hash:'a'.repeat(64),archive_sha256:'b'.repeat(64),key_versions:['active','old'],detail:'authenticated_archive'},restore:RecoveryStatus={status:'verified',recorded_at:'2026-10-14T10:05:00.000Z',manifest_hash:'a'.repeat(64),archive_sha256:'b'.repeat(64),key_versions:['active','old'],detail:'isolated_restore_bound_to_archive'};
 assert.deepEqual(verifiedKeyRetirementBasis({backup,restore},'active','old'),{backup_archive_sha256:'b'.repeat(64),restore_archive_sha256:'b'.repeat(64),backup_manifest_sha256:'a'.repeat(64),restore_manifest_sha256:'a'.repeat(64),backup_recorded_at:backup.recorded_at,restore_recorded_at:restore.recorded_at});
 assert.throws(()=>verifiedKeyRetirementBasis({backup,restore:{...restore,archive_sha256:'c'.repeat(64)}},'active','old'));
 assert.throws(()=>verifiedKeyRetirementBasis({backup,restore:{...restore,recorded_at:'2026-10-13T10:05:00.000Z'}},'active','old'));
 assert.throws(()=>verifiedKeyRetirementBasis({backup,restore:{...restore,key_versions:['active']}},'active','old'));
 assert.throws(()=>verifiedKeyRetirementBasis({backup:{...backup,status:'unverified'},restore},'active','old'));
});
