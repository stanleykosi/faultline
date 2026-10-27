import type pg from 'pg';
import {demand} from '../../core/src/errors.js';
import {runtimeMigrations} from './runtime-migrations.js';
import {identitySchema} from './identity-schema.js';

export function assertRuntimeMigrations(rows: readonly {id: string; checksum: string}[]) {
  const installed = new Map(rows.map(row => [row.id, row.checksum]));
  demand(rows.length === runtimeMigrations.length && installed.size === rows.length && runtimeMigrations.every(item => installed.has(item.id)),
    'SCHEMA_UNSUPPORTED', 'Apply the reviewed migrations for this release before running it.', 503);
  demand(runtimeMigrations.every(item => installed.get(item.id) === (identitySchema === 'auth' ? item.checksum : item.supabaseChecksum)),
    'SCHEMA_MISMATCH', 'Applied migration checksums do not match this release. Inspect the migration history before proceeding.', 503);
}

/** Runtime services verify compatibility; only the operator command applies SQL. */
export async function verifyRuntimeSchema(connection: Pick<pg.Pool, 'query'>) {
  const result = await connection.query('SELECT id,checksum FROM faultline.schema_migrations ORDER BY id');
  assertRuntimeMigrations(result.rows);
}
