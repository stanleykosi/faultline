import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {assertRuntimeMigrations} from './runtime-schema.js';
import {runtimeMigrations} from './runtime-migrations.js';

test('compiled runtime expectation matches every reviewed SQL migration', async () => {
  const names = (await fs.readdir('packages/database/migrations')).filter(name => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
  assert.deepEqual(runtimeMigrations.map(item => item.id), names.map(name => name.slice(0, -4)));
  for (const item of runtimeMigrations) {
    const sql = await fs.readFile('packages/database/migrations/' + item.id + '.sql', 'utf8');
    assert.equal(item.checksum, createHash('sha256').update(sql).digest('hex'));
  }
  assert.doesNotThrow(() => assertRuntimeMigrations(runtimeMigrations));
});

test('the former 24-migration installation cannot claim current runtime compatibility', () => {
  assert.throws(() => assertRuntimeMigrations(runtimeMigrations.filter(item => !['0025-model-budget-extensions', '0026-managed-demo-cases'].includes(item.id))), {code: 'SCHEMA_UNSUPPORTED', status: 503});
});

test('a complete migration inventory with altered SQL or an unexpected migration is rejected', () => {
  const changed: {id: string; checksum: string}[] = runtimeMigrations.map(item => ({...item}));
  changed[0]!.checksum = '0'.repeat(64);
  assert.throws(() => assertRuntimeMigrations(changed), {code: 'SCHEMA_MISMATCH', status: 503});
  assert.throws(() => assertRuntimeMigrations([...runtimeMigrations, {id: '9999-unreviewed', checksum: '0'.repeat(64)}]), {code: 'SCHEMA_UNSUPPORTED', status: 503});
});

test('the latest deletion capability remains exact-scope and covers every schema-27 scoped row', async () => {
  const sql = await fs.readFile('packages/database/migrations/0028-scoped-purge-current-content.sql', 'utf8');
  assert.match(sql, /Deletion intent required/);
  assert.match(sql, /Exact runner cleanup proof required/);
  assert.match(sql, /Private object cleanup required/);
  assert.match(sql, /WHERE workspace_id=\$1 AND case_id=\$2/);
  assert.match(sql, /'redaction_previews'.*'model_budget_extensions'.*'case_redaction_keys'.*'case_revisions'/);
  assert.match(sql, /'staging_catalog','secret_replacements'.*'secret_versions'/);
  assert.match(sql, /GRANT SELECT,DELETE ON faultline\.%I TO faultline_authority/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION faultline\.purge_case_data\(uuid\),faultline\.purge_workspace_data\(\) TO faultline_api/);
  assert.doesNotMatch(sql, /GRANT DELETE ON faultline\.canonical_events TO faultline_api/);
});
