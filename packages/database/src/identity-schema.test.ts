import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {identitySql,migrationChecksum,parseIdentitySchema} from './identity-schema.js';
import {runtimeMigrations} from './runtime-migrations.js';
test('only the two reviewed identity namespaces are accepted',()=>{
 assert.equal(parseIdentitySchema('auth'),'auth');assert.equal(parseIdentitySchema('faultline_identity'),'faultline_identity');
 for(const value of ['public','auth; DROP SCHEMA auth','"auth"',''])assert.throws(()=>parseIdentitySchema(value));
});
test('Railway migration bytes retain canonical hashes; Supabase has independently rendered checksums',async()=>{
 for(const migration of runtimeMigrations){
  const original=await fs.readFile('packages/database/migrations/'+migration.id+'.sql','utf8');
  assert.equal(identitySql(original,'auth'),original);
  assert.equal(migrationChecksum(original,'auth'),migration.checksum);
  const rendered=identitySql(original,'faultline_identity');assert.doesNotMatch(rendered,/\bauth\b/);
  assert.equal(createHash('sha256').update(rendered).digest('hex'),migration.supabaseChecksum);
  assert.equal(migrationChecksum(original+'-- tampered','faultline_identity')===migration.supabaseChecksum,false);
 }
});
