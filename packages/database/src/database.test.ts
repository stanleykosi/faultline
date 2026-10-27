import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {identitySql, migrationChecksum, parseIdentitySchema} from './identity-schema.js';
import {runtimeMigrations} from './runtime-migrations.js';
import {assertRuntimeMigrations} from './runtime-schema.js';
import pg from 'pg';
import {warmPool, runtimePoolSize} from './warm-pool.js';
import {DomainError} from '../../core/src/errors.js';

describe("identity schema", async () => {
  test('only the two reviewed identity namespaces are accepted', () => {
      assert.equal(parseIdentitySchema('auth'), 'auth');
      assert.equal(parseIdentitySchema('faultline_identity'), 'faultline_identity');
      for (const value of ['public', 'auth; DROP SCHEMA auth', '"auth"', ''])
          assert.throws(() => parseIdentitySchema(value));
  });
  
  test('current migration inventory and both identity namespaces match reviewed SQL', async () => {
      const names=(await fs.readdir('packages/database/migrations')).filter(name=>/^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
      assert.deepEqual(runtimeMigrations.map(item=>item.id),names.map(name=>name.slice(0,-4)));
      assert.doesNotThrow(()=>assertRuntimeMigrations(runtimeMigrations));
      for (const migration of runtimeMigrations) {
          const original = await fs.readFile('packages/database/migrations/' + migration.id + '.sql', 'utf8');
          assert.equal(identitySql(original, 'auth'), original);
          assert.equal(migrationChecksum(original, 'auth'), migration.checksum);
          const rendered = identitySql(original, 'faultline_identity');
          assert.doesNotMatch(rendered, /\bauth\b/);
          assert.equal(createHash('sha256').update(rendered).digest('hex'), migration.supabaseChecksum);
          assert.equal(migrationChecksum(original + '-- tampered', 'faultline_identity') === migration.supabaseChecksum, false);
      }
  });
});

describe("runtime schema", async () => {
  
  test('missing, altered or unexpected migrations fail closed', () => {
      assert.throws(()=>assertRuntimeMigrations(runtimeMigrations.slice(0,-1)),{code:'SCHEMA_UNSUPPORTED',status:503});
      const changed: {
          id: string;
          checksum: string;
      }[] = runtimeMigrations.map(item => ({ ...item }));
      changed[0]!.checksum = '0'.repeat(64);
      assert.throws(() => assertRuntimeMigrations(changed), { code: 'SCHEMA_MISMATCH', status: 503 });
      assert.throws(() => assertRuntimeMigrations([...runtimeMigrations, { id: '9999-unreviewed', checksum: '0'.repeat(64) }]), { code: 'SCHEMA_UNSUPPORTED', status: 503 });
  });
});

describe("warm pool", async () => {
  const configuration = (error: unknown) => error instanceof DomainError && error.code === 'CONFIGURATION';
  
  const unavailable = (error: unknown) => error instanceof DomainError && error.code === 'DEPENDENCY_UNAVAILABLE' && error.status === 503;
  
  test('pool size bounds and capacity reject unsafe values before opening a connection', async () => {
      assert.equal(runtimePoolSize(undefined, 6), 6);
      assert.equal(runtimePoolSize('1', 6), 1);
      assert.equal(runtimePoolSize('32', 6), 32);
      for (const value of ['', '0', '33', '-1', '1.5', 'NaN', 'Infinity'])
          assert.throws(() => runtimePoolSize(value, 6), configuration);
      for (const fallback of [0, 33, 1.5, Number.NaN])
          assert.throws(() => runtimePoolSize(undefined, fallback), configuration);
      const pool = new pg.Pool({ max: 2 });
      let calls = 0;
      Object.defineProperty(pool, 'connect', { value: () => { calls++; throw Error('Invalid size must not connect.'); } });
      try {
          for (const size of [0, 3, 33, 1.5, Number.NaN])
              await assert.rejects(warmPool(pool, size), configuration);
          assert.equal(calls, 0);
      }
      finally {
          await pool.end();
          assert.equal(pool.ended, true);
      }
  });
  
  test('explicit unit injection: a fulfilled slot is held until partial connection failure settles, then released once', async () => {
      const pool = new pg.Pool({ max: 2 });
      let calls = 0, queries = 0, rejectSecond: (reason: Error) => void = () => { throw Error('Deferred connection not initialized.'); };
      const releases: boolean[] = [];
      const client = { query: async () => { queries++; return { rows: [{ warm: 1 }] }; }, release: (destroy: boolean) => releases.push(destroy) };
      const second = new Promise<never>((_resolve, reject) => { rejectSecond = reject; });
      Object.defineProperty(pool, 'connect', { value: () => ++calls === 1 ? Promise.resolve(client) : second });
      try {
          const warming = warmPool(pool, 2);
          await Promise.resolve();
          assert.equal(calls, 2);
          assert.equal(queries, 0);
          assert.deepEqual(releases, []);
          rejectSecond(Error('Explicit unit connection fault; not a runtime dependency result.'));
          await assert.rejects(warming, unavailable);
          assert.equal(queries, 0);
          assert.deepEqual(releases, [true]);
      }
      finally {
          await pool.end();
          assert.equal(pool.ended, true);
      }
  });
  
  test('explicit unit injection: warm queries are bounded and query failure destroys every acquired slot', async () => {
      const pool = new pg.Pool({ max: 2 });
      let calls = 0;
      const queries: {
          text: string | undefined;
          timeout: number | undefined;
      }[] = [], releases: {
          slot: number;
          destroy: boolean;
      }[] = [];
      Object.defineProperty(pool, 'connect', { value: () => {
              const slot = ++calls;
              return Promise.resolve({
                  query: async (config: pg.QueryConfig & {
                      query_timeout?: number;
                  }) => { queries.push({ text: config.text, timeout: config.query_timeout }); if (slot === 2)
                      throw Error('Explicit unit query fault.'); return { rows: [{ warm: 1 }] }; },
                  release: (destroy: boolean) => releases.push({ slot, destroy }),
              });
          } });
      try {
          await assert.rejects(warmPool(pool, 2), unavailable);
          assert.equal(calls, 2);
          assert.deepEqual(queries, [{ text: 'SELECT 1 AS warm', timeout: 3000 }, { text: 'SELECT 1 AS warm', timeout: 3000 }]);
          assert.deepEqual(releases, [{ slot: 1, destroy: true }, { slot: 2, destroy: true }]);
      }
      finally {
          await pool.end();
          assert.equal(pool.ended, true);
      }
  });
});
