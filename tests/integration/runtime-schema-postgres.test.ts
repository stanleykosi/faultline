import test from 'node:test';
import assert from 'node:assert/strict';
import {pool, authPool} from '../../packages/database/src/client.js';
import {assertRuntimeMigrations, verifyRuntimeSchema} from '../../packages/database/src/runtime-schema.js';
import {buildServer} from '../../apps/api/src/server.js';

test('actual configured database and API readiness refuse an incompatible migration set', {skip: !pool}, async () => {
  const rows = (await pool!.query('SELECT id,checksum FROM faultline.schema_migrations ORDER BY id')).rows;
  let compatible = true;
  try {assertRuntimeMigrations(rows);} catch {compatible = false;}
  const app = await buildServer();
  try {
    const response = await app.inject('/health/ready');
    if (!compatible) {
      await assert.rejects(verifyRuntimeSchema(pool!), {code: 'SCHEMA_UNSUPPORTED'});
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().status, 'not_ready');
      assert.equal(response.json().components.database, 'unavailable');
    } else {
      await verifyRuntimeSchema(pool!);
      assert.equal(response.json().components.database, 'ready');
    }
    console.log(JSON.stringify({database_migrations: rows.length, compatible, actual_api_status: response.statusCode}));
  } finally {await app.close(); await pool!.end(); await authPool?.end();}
});
