import {createHash} from 'node:crypto';
import {demand} from '../../core/src/errors.js';

export type IdentitySchema = 'auth' | 'faultline_identity';
export function parseIdentitySchema(value = process.env.AUTH_DATABASE_SCHEMA): IdentitySchema {
  demand(value === undefined || value === 'auth' || value === 'faultline_identity', 'IDENTITY_SCHEMA_INVALID', 'Use the reviewed identity database schema.');
  return value ?? 'auth';
}
export const identitySchema = parseIdentitySchema();
/** Historical SQL is immutable. The optional hosting profile renders only its reserved identity namespace. */
export function identitySql(sql: string, schema: IdentitySchema = identitySchema): string {
  return schema === 'auth' ? sql : sql.replace(/\bauth\b/g, 'faultline_identity');
}
export function migrationChecksum(sql: string, schema: IdentitySchema = identitySchema): string {
  return createHash('sha256').update(identitySql(sql, schema)).digest('hex');
}
