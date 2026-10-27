import {decodeDatabaseDump} from './backup-sql.js';
import {verifyRecoveryCiphertexts} from './recovery-ciphertexts.js';
import {verifyRestoredObjects} from './verify-restored-objects.js';
import {checkRecoveryCapacity} from './recovery-capacity.js';
import {decodeBackupPart} from './backup-parts.js';
import type {Keyring} from '../../packages/core/src/secrets/keyring.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hash, byteHash} from '../../packages/core/src/canonical.js';
import {demand} from '../../packages/core/src/errors.js';
import {assertRuntimeRoles, cliMain, connection, inventory, pgVersions, readBundle, runPg, settings} from './backup.js';

export function createIsolatedDatabaseSql(database:string,configuration:{encoding:string;collation:string;ctype:string}) {
  demand(/^faultline_restore_[0-9]{13}_[a-f0-9]{8}$/.test(database),'RESTORE_DATABASE_NAME','Restore destination must be a newly generated isolated database.');
  demand(/^[A-Za-z0-9_-]{1,32}$/.test(configuration.encoding)&&/^[A-Za-z0-9_.@ -]{1,128}$/.test(configuration.collation)&&/^[A-Za-z0-9_.@ -]{1,128}$/.test(configuration.ctype),'RESTORE_DATABASE_CONFIGURATION','Database encoding and locale must use bounded PostgreSQL names.');
  const literal=(value:string)=>"'"+value.replaceAll("'","''").replaceAll('\\','\\\\')+"'";
  return 'CREATE DATABASE "'+database+'" TEMPLATE template0 ENCODING '+literal(configuration.encoding)+' LC_COLLATE '+literal(configuration.collation)+' LC_CTYPE '+literal(configuration.ctype);
}

export async function restoreIsolated(args: string[]): Promise<object> {
  demand(args.length === 2 && args[0] === '--archive' && args[1], 'RESTORE_ARGUMENTS', 'Use restore.ts --archive <private encrypted backup>; destination is always new and isolated.');
  await checkRecoveryCapacity(process.cwd());
  const started = Date.now(), options = settings(), archive = path.resolve(args[1]), versions = await pgVersions();
  const bundle = await readBundle(archive, options.wrap_key, options.signing_public); // Every byte and trusted signature are verified before DB creation.
  const id = randomUUID(), database = `faultline_restore_${Date.now()}_${id.slice(0, 8)}`, root = path.resolve('.runtime/restores', id);
  demand(database !== bundle.manifest.source_database && database !== options.url.pathname.slice(1) && /^faultline_restore_[0-9]{13}_[a-f0-9]{8}$/.test(database), 'ISOLATED_DATABASE_REQUIRED', 'Restore must use a generated fresh rehearsal database.');
  const admin = connection(options.url); await admin.connect();
  try {
    demand((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper, 'RESTORE_OPERATOR_REQUIRED', 'Local restore requires the trusted installation operator.');
    demand(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 'RESTORE_DESTINATION_EXISTS', 'An existing database is never overwritten.');
    const roleNames = bundle.manifest.database.roles.map(role => String(role.rolname));
    const roles = (await admin.query('SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolcreatedb,r.rolcreaterole,r.rolinherit,ARRAY(SELECT p.rolname::text FROM pg_roles p WHERE p.oid<>r.oid AND pg_has_role(r.oid,p.oid,\'MEMBER\') ORDER BY p.rolname) AS memberships FROM pg_roles r WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname', [roleNames])).rows;
    const membershipRecorded=bundle.manifest.database.roles.every(role=>Array.isArray(role.memberships));demand(bundle.manifest.database.inventory_version===1||membershipRecorded,'BACKUP_INVENTORY_VERSION','Version2 inventories must record role memberships.');demand(roles.every(role=>Array.isArray(role.memberships)&&role.memberships.length===0),'UNSAFE_RUNTIME_ROLES','Current runtime roles must have zero role memberships, including legacy backup restore.');const compareRoles=(items:Record<string,unknown>[])=>membershipRecorded?items:items.map(({memberships,...saved})=>saved);
    demand(hash(compareRoles(roles)) === hash(bundle.manifest.database.roles), 'RESTORE_ROLES_CHANGED', 'Reviewed runtime role definitions must exist unchanged; this rehearsal never imports role passwords or modifies cluster roles.');
    await fs.mkdir(path.dirname(root), {recursive: true, mode: 0o700}); await fs.mkdir(root, {mode: 0o700});
    demand((await fs.realpath(root)) === root && !(await fs.lstat(root)).isSymbolicLink(), 'RESTORE_PATH_ESCAPE', 'Recovery destination must be a distinct private directory without symlink redirection.');
    for (const part of bundle.parts) {
      if (part.name === 'database.sql'||part.name.startsWith('database/')) continue;
      const destination = path.resolve(root, part.name), relative = path.relative(root, destination);
      demand(!relative.startsWith('..') && !path.isAbsolute(relative), 'RESTORE_PATH_ESCAPE', 'Archive destination escaped its private root.');
      await fs.mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
      const bytes=decodeBackupPart(part,bundle.manifest.schema_version);await fs.writeFile(destination, bytes, {flag: 'wx', mode: 0o600});
      demand(byteHash(await fs.readFile(destination)) === part.sha256, 'RESTORE_OBJECT_CHECKSUM', 'Recovered private file changed after writing.');
    }
    const config = {schema_version: 1, database_name: database, object_store_path: path.join(root, 'objects'), secret_keyring_path: path.join(root, 'keys/keyring.json'), report_signing_key_path: path.join(root, 'keys/report-private.pem'), authentication_secret_file: path.join(root, 'keys/recovery-secrets.json'), ...(bundle.manifest.fixture_runner?{fixture_runner_recovery:{key_path:path.join(root,'runner/key.bin'),state_root:path.join(root,'runner/state'),artifact_root:path.join(root,'runner/artifacts'),start_authorized:false}}:{}),model_provider: 'none', runner_mode: 'disabled', source_dispatch: 'paused', worker_start_authorized: false, origin_cutover_authorized: false};
    await fs.mkdir(config.object_store_path, {recursive: true, mode: 0o700});
    await fs.writeFile(path.join(root, 'recovery-config.json'), JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    let databaseConfiguration=bundle.manifest.database.database_configuration,databaseConfigurationSource='archive_manifest';
    if(!databaseConfiguration){
      const source=(await admin.query('SELECT pg_encoding_to_char(encoding) AS encoding,datcollate AS collation,datctype AS ctype FROM pg_database WHERE datname=$1',[bundle.manifest.source_database])).rows[0];
      if(source){databaseConfiguration=source;databaseConfigurationSource='same_cluster_source_catalog';}
      else{databaseConfiguration={encoding:'UTF8',collation:'C',ctype:'C'};databaseConfigurationSource='legacy_utf8_c_compatibility_profile';}
    }
    demand(databaseConfiguration,'RESTORE_DATABASE_CONFIGURATION','A signed, source-catalog or compatibility database locale is required.');
    await admin.query(createIsolatedDatabaseSql(database,databaseConfiguration));
    const target = new URL(options.url); target.pathname = '/' + database;
    const dump=bundle.manifest.schema_version===3?decodeDatabaseDump(bundle.manifest.database_dump!,bundle.parts):decodeBackupPart(bundle.parts.find(part=>part.name==='database.sql')!,bundle.manifest.schema_version);
    const importResult = await runPg('psql', ['--no-password', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--single-transaction','--file=-'], target, dump, 4 * 1024 * 1024);
    demand(importResult.stderr_bytes === 0, 'RESTORE_DIAGNOSTICS', 'Database import emitted diagnostics; inspect the preserved attempt before treating restore as verified.');
    const restored = connection(target); await restored.connect();
    try {
      const ring=JSON.parse(await fs.readFile(path.join(root,'keys/keyring.json'),'utf8')) as Keyring,recoveryCiphertexts=await verifyRecoveryCiphertexts(restored,ring);
      const actual = await inventory(restored); assertRuntimeRoles(actual);
      if(bundle.manifest.database.database_configuration)demand(hash(actual.database_configuration)===hash(bundle.manifest.database.database_configuration),'RESTORE_DATABASE_CONFIGURATION','Restored database encoding and locale differ from the signed source inventory.');
      demand(hash(actual.counts) === hash(bundle.manifest.database.counts), 'RESTORE_ROW_COUNTS', 'Restored actual table counts differ from the consistent snapshot.');
      demand(hash(actual.migrations) === hash(bundle.manifest.database.migrations), 'RESTORE_MIGRATIONS', 'Schema migration identities/checksums changed.');
      demand(actual.event_timestamps.hash === bundle.manifest.database.event_timestamps.hash && actual.event_timestamps.count === bundle.manifest.database.event_timestamps.count, 'RESTORE_TIMESTAMP_PRECISION', 'Restored canonical events changed identity or six-digit occurrence timestamps.');
      demand(actual.security_hash === bundle.manifest.database.security_hash && hash(compareRoles(actual.roles)) === hash(bundle.manifest.database.roles), 'RESTORE_SECURITY_CHANGED', 'Table grants, ownership, RLS policies or function authority changed.');
      const references = (await restored.query('SELECT DISTINCT workspace_id::text,object_key,size_bytes::text FROM faultline.object_references ORDER BY workspace_id,object_key')).rows;
      demand(references.length === bundle.manifest.object_count, 'RESTORE_OBJECT_COUNT', 'Recovered object reference inventory differs.');
      await verifyRestoredObjects(path.join(root,'objects'),references);
      const noScope = await restored.query('BEGIN'); void noScope;
      try {await restored.query('SET LOCAL ROLE faultline_api'); await restored.query("SELECT set_config('faultline.workspace_id','',true)"); const rows = (await restored.query('SELECT count(*)::integer AS n FROM faultline.cases')).rows[0].n; demand(rows === 0, 'RESTORE_TENANT_ISOLATION', 'Runtime role could read tenant rows without a workspace scope.');}
      finally {await restored.query('ROLLBACK');}
      const auth = await restored.query("SELECT has_schema_privilege('faultline_auth','faultline','USAGE') AS tenant_access");
      demand(auth.rows[0].tenant_access === false, 'RESTORE_AUTH_ISOLATION', 'Auth role must remain isolated from tenant schemas.');
      return {operation: 'restore', status: 'isolated_restore_verified', id, checked_at:new Date().toISOString(),key_versions:bundle.manifest.key_versions,destination_database: database, private_root: root, recovery_config: path.join(root, 'recovery-config.json'), archive_sha256: byteHash(await fs.readFile(archive)), manifest_hash: bundle.manifest_hash, client_versions: versions, database_counts: actual.counts, database_configuration:actual.database_configuration,database_configuration_source:databaseConfigurationSource,object_count: references.length, timestamp_count: actual.event_timestamps.count, timestamp_hash: actual.event_timestamps.hash, microsecond_values: actual.event_timestamps.microsecond_values, security_hash: actual.security_hash, migration_count: actual.migrations.length, retained_ciphertexts_verified:recoveryCiphertexts,runtime_roles_verified: true,backup_inventory_version:bundle.manifest.database.inventory_version,historical_role_memberships_recorded:membershipRecorded,current_role_memberships_verified_zero:true, tenant_without_scope_rows: 0, auth_tenant_access: false, external_effects: 'paused', duration_ms: Date.now() - started, limitations: ['This is an isolated database/object/permission rehearsal, not a production cutover or application smoke check.', 'Cluster roles are reused and verified; role passwords are never backed up.', 'Do not start a worker, enable external sources, reuse runner leases or switch an origin without separate operator review.',...(databaseConfigurationSource==='legacy_utf8_c_compatibility_profile'?['Legacy archive lacked signed database locale metadata; the explicit UTF8/C compatibility profile was used.']:[])]};
    } finally {await restored.end();}
  } finally {await admin.end();}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cliMain('restore', () => restoreIsolated(process.argv.slice(2)));
