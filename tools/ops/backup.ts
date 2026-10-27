import {encodeDatabaseDump,decodeDatabaseDump,type DatabaseDumpDescriptor} from './backup-sql.js';
import {acquireNativeLock} from '../../packages/core/src/experiments/native-lock.js';
import {assertNativeRunnerStopped,nativeInventoryHash} from './runner-quiescence.js';
import {verifyRecoveryCiphertexts} from './recovery-ciphertexts.js';
import {checkRecoveryCapacity} from './recovery-capacity.js';
import {encodeBackupPart,decodeBackupPart,partDescriptor,assertPartInventoryLimits,serializeBackupFrame,MAX_RECOVERY_FRAME_BYTES,MAX_RECOVERY_PART_BYTES,MAX_RECOVERY_LOGICAL_BYTES,MAX_RECOVERY_STORED_BYTES} from './backup-parts.js';
import type {BackupPart} from './backup-parts.js';
export type {BackupPart} from './backup-parts.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify} from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {canonical, hash, byteHash} from '../../packages/core/src/canonical.js';
import {demand, DomainError} from '../../packages/core/src/errors.js';

const MAGIC = Buffer.from('FAULTLINE_BACKUP_V1\n');
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_DUMP_BYTES = 256 * 1024 * 1024;
const ROLES = ['faultline_api', 'faultline_auth', 'faultline_queue', 'faultline_dispatcher', 'faultline_authority'];
export type CliName = 'pg_dump' | 'psql';
export interface DatabaseInventory {
  inventory_version: 1 | 2; server_version: string; counts: Record<string, number>; migrations: {id: string; checksum: string}[];
  roles: Record<string, unknown>[]; security_hash: string; security: Record<string, unknown>[];
  event_timestamps: {count: number; hash: string; microsecond_values: number};
  database_configuration?: {encoding: string; collation: string; ctype: string};
}
export interface BackupManifest {
  schema_version: 1|2|3; database_dump?:DatabaseDumpDescriptor; id: string; created_at: string; application_version: string;
  snapshot_method: 'exported_repeatable_read'; offline: true; source_database: string;
  database: DatabaseInventory; object_count: number; key_versions: string[]; report_signing_key_versions: string[];
  parts: Omit<BackupPart,'bytes_base64'>[];
  fixture_runner?:{scope:'trusted_fixture';production_claim_eligible:false;ledger_files:number;artifact_files:number;legacy_without_terminal_count:number};
  signer_sha256: string; completion: 'complete'; external_effects: 'paused';
}
export interface BackupBundle {manifest: BackupManifest; manifest_hash: string; signature: string; parts: BackupPart[];}
export interface OpsSettings {url: URL; object_root: string; keyring: string; signing_key: string; signing_public: string; wrap_key: string;}

export function localOperatorUrl(value = process.env.MIGRATION_DATABASE_URL): URL {
  demand(value, 'OPERATOR_CONFIGURATION_MISSING', 'Supply MIGRATION_DATABASE_URL through the private operator environment.');
  let url: URL; try {url = new URL(value);} catch {throw new DomainError('OPERATOR_CONFIGURATION_INVALID', 'Invalid private operator connection configuration.');}
  demand(['postgresql:', 'postgres:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'LOCAL_DATABASE_REQUIRED', 'Recovery tools require a loopback PostgreSQL destination.');
  demand(url.username && url.password && /^\/[A-Za-z0-9_-]{1,63}$/.test(url.pathname) && !url.search && !url.hash, 'OPERATOR_CONFIGURATION_INVALID', 'Use a private loopback operator URL without query options.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}
export function settings(): OpsSettings {
  const signing_key = path.resolve(process.env.REPORT_SIGNING_KEY_PATH ?? '.runtime/keys/report-private.pem');
  return {url: localOperatorUrl(), object_root: path.resolve(process.env.OBJECT_STORE_PATH ?? '.runtime/objects'), keyring: path.resolve(process.env.SECRET_KEYRING_PATH ?? '.runtime/keys/keyring.json'), signing_key, signing_public: path.resolve(process.env.REPORT_SIGNING_PUBLIC_KEY_PATH ?? path.join(path.dirname(signing_key), 'report-public.pem')), wrap_key: path.resolve(process.env.BACKUP_WRAP_KEY_PATH ?? '.runtime/keys/backup-wrap.key')};
}
export function connection(url: URL): pg.Client {
  return new pg.Client({connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 120_000, application_name: 'faultline-ops', options: '-c timezone=UTC -c statement_timeout=120000 -c lock_timeout=5000'});
}
export async function regularBytes(file: string, maximum: number): Promise<Buffer> {
  const entry = await fs.lstat(file); demand(entry.isFile() && !entry.isSymbolicLink() && entry.size <= maximum, 'PRIVATE_FILE_INVALID', 'Private input must be a bounded regular file.');
  return fs.readFile(file);
}
export async function privatePath(file: string, root: string): Promise<string> {
  const resolved = await fs.realpath(file), base = await fs.realpath(root), relative = path.relative(base, resolved);
  demand(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'PRIVATE_PATH_ESCAPE', 'Object path escaped its private root.');
  demand(!((await fs.lstat(file)).isSymbolicLink()), 'PRIVATE_PATH_ESCAPE', 'Symlinks are not accepted as private recovery inputs.');
  return resolved;
}
export async function cliPath(name: CliName): Promise<string> {
  const executable = name + (process.platform === 'win32' ? '.exe' : '');
  const directories = process.env.PG_BIN_DIRECTORY ? [path.resolve(process.env.PG_BIN_DIRECTORY)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    try {const stat = await fs.lstat(candidate); if (stat.isFile() && !stat.isSymbolicLink()) return await fs.realpath(candidate);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
  throw new DomainError('PG_CLIENT_TOOLS_MISSING', 'Install trusted PostgreSQL 17 pg_dump and psql utilities; set PG_BIN_DIRECTORY to their bin directory.');
}
export async function runPgStream<T>(name: CliName,args: string[],url: URL | undefined,consume: (source: AsyncIterable<Buffer>)=>Promise<T>,input?: Buffer | Iterable<Buffer> | AsyncIterable<Buffer>,maximum=MAX_DUMP_BYTES,options?:{timeoutMilliseconds?:number}):Promise<{value:T;stderr_hash:string;stderr_bytes:number;duration_ms:number}> {
  demand(Number.isSafeInteger(maximum)&&maximum>0&&maximum<=MAX_RECOVERY_LOGICAL_BYTES,'BACKUP_SIZE_LIMIT','PostgreSQL stream output must retain the existing finite archive ceiling.');
  const timeout=options?.timeoutMilliseconds??180000;demand(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=180000,'PG_TOOL_TIMEOUT_CONFIGURATION','PostgreSQL tool deadline can only be shortened.');
  const executable=await cliPath(name),started=Date.now(),env:NodeJS.ProcessEnv={};
  for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
  if(url)Object.assign(env,{PGHOST:url.hostname.replace(/^\[|\]$/g,''),PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',PGAPPNAME:'faultline-ops-cli',PGOPTIONS:'-c timezone=UTC -c statement_timeout=120000 -c lock_timeout=5000'});
  const child=spawn(executable,args,{env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let failure:DomainError|undefined,errorBytes=0,outputBytes=0;const diagnostics:Buffer[]=[];
  let rejectFailure!:(error:DomainError)=>void;const failed=new Promise<never>((_,reject)=>{rejectFailure=reject;});void failed.catch(()=>{});
  const closed=new Promise<number|null>(resolve=>{child.once('error',()=>{failure??=new DomainError('PG_TOOL_UNAVAILABLE','PostgreSQL utility could not start or signal its owned process.');rejectFailure(failure);});child.once('close',resolve);});
  const terminate=(error:DomainError)=>{failure??=error;rejectFailure(failure);child.kill();};
  const timer=setTimeout(()=>terminate(new DomainError('PG_TOOL_TIMEOUT','PostgreSQL utility exceeded the bounded operation deadline.')),timeout);
  child.stderr.on('data',(chunk:Buffer)=>{errorBytes+=chunk.length;if(errorBytes>65536)terminate(new DomainError('PG_TOOL_OUTPUT_LIMIT','PostgreSQL utility diagnostics exceeded their bound.'));else diagnostics.push(chunk);});
  child.stdin.on('error',()=>terminate(new DomainError('PG_TOOL_INPUT_FAILED','PostgreSQL utility input failed; private data is withheld.')));
  const feed=(async()=>{if(input!==undefined){const chunks=Buffer.isBuffer(input)?[input]:input;let total=0;for await(const chunk of chunks){demand(Buffer.isBuffer(chunk),'BACKUP_FORMAT','SQL input requires binary chunks.');total+=chunk.length;demand(total<=MAX_RECOVERY_LOGICAL_BYTES,'BACKUP_SIZE_LIMIT','SQL input exceeded the unchanged logical archive limit.');if(failure)throw failure;await new Promise<void>((resolve,reject)=>{child.stdin.write(chunk,error=>error?reject(error):resolve());});}}await new Promise<void>(resolve=>child.stdin.end(resolve));})().catch(()=>terminate(new DomainError('PG_TOOL_INPUT_FAILED','PostgreSQL utility did not accept the bounded private input.')));
  const source=(async function*(){for await(const chunk of child.stdout){demand(Buffer.isBuffer(chunk),'PG_TOOL_OUTPUT_LIMIT','PostgreSQL utility output requires binary chunks.');outputBytes+=chunk.length;if(outputBytes>maximum){terminate(new DomainError('BACKUP_SIZE_LIMIT','PostgreSQL utility output exceeded the finite recovery limit.'));throw failure;}if(failure)throw failure;yield chunk;}})();
  try{const value=await Promise.race([consume(source),failed]);await Promise.race([feed,failed]);const code=await Promise.race([closed,failed]);if(failure)throw failure;demand(code===0,'PG_TOOL_FAILED','PostgreSQL utility exited unsuccessfully; private diagnostics are withheld.');return {value,stderr_hash:byteHash(Buffer.concat(diagnostics)),stderr_bytes:errorBytes,duration_ms:Date.now()-started};}
  catch(error){child.kill();let closeTimer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([closed,new Promise<never>((_,reject)=>{closeTimer=setTimeout(()=>reject(new DomainError('PG_TOOL_CLOSURE_UNKNOWN','Owned PostgreSQL utility closure was not confirmed.')),10000);})]);}finally{clearTimeout(closeTimer);}throw failure??error;}
  finally{clearTimeout(timer);}
}
export async function runPg(name:CliName,args:string[],url?:URL,input?:Buffer|Iterable<Buffer>|AsyncIterable<Buffer>,maximum=MAX_DUMP_BYTES):Promise<{stdout:Buffer;stderr_hash:string;stderr_bytes:number;duration_ms:number}> {
  const result=await runPgStream(name,args,url,async source=>{const chunks:Buffer[]=[];for await(const chunk of source)chunks.push(chunk);return Buffer.concat(chunks);},input,maximum);
  return {stdout:result.value,stderr_hash:result.stderr_hash,stderr_bytes:result.stderr_bytes,duration_ms:result.duration_ms};
}
export async function pgVersions(): Promise<Record<CliName, string>> {
  const result = {} as Record<CliName, string>;
  for (const name of ['pg_dump', 'psql'] as const) {const version = (await runPg(name, ['--version'], undefined, undefined, 1024)).stdout.toString('utf8').trim(); demand(/\(PostgreSQL\) 17\./.test(version), 'PG_CLIENT_VERSION', 'Recovery requires PostgreSQL 17 client utilities.'); result[name] = version;}
  return result;
}
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export async function inventory(client: pg.Client): Promise<DatabaseInventory> {
  const databaseConfiguration=(await client.query("SELECT pg_encoding_to_char(encoding) AS encoding,datcollate AS collation,datctype AS ctype FROM pg_database WHERE datname=current_database()")).rows[0];
  demand(databaseConfiguration&&typeof databaseConfiguration.encoding==='string'&&typeof databaseConfiguration.collation==='string'&&typeof databaseConfiguration.ctype==='string','DATABASE_CONFIGURATION_UNAVAILABLE','The current PostgreSQL database encoding and locale must be available for recovery.');
  const tables = (await client.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('faultline','auth','pgboss') AND c.relkind IN('r','p') AND NOT c.relispartition ORDER BY n.nspname,c.relname")).rows;
  demand(tables.length > 0 && tables.length <= 200, 'SCHEMA_UNAVAILABLE', 'Expected bounded Faultline schemas.');
  const counts: Record<string, number> = {};
  for (const table of tables) {const value = Number((await client.query('SELECT count(*) AS n FROM ' + identifier(table.schema) + '.' + identifier(table.name))).rows[0].n); demand(Number.isSafeInteger(value) && value <= 1_000_000, 'DATABASE_SIZE_LIMIT', 'Local recovery table count exceeds the rehearsal ceiling.'); counts[`${table.schema}.${table.name}`] = value;}
  const roles = (await client.query('SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolcreatedb,r.rolcreaterole,r.rolinherit,ARRAY(SELECT p.rolname::text FROM pg_roles p WHERE p.oid<>r.oid AND pg_has_role(r.oid,p.oid,\'MEMBER\') ORDER BY p.rolname) AS memberships FROM pg_roles r WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname', [ROLES])).rows;
  const security = (await client.query("SELECT n.nspname AS schema,c.relname AS name,r.rolname AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,c.relacl::text AS acl,(n.nspname='faultline' AND (c.relname='workspaces' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped))) AS tenant_table FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname IN('faultline','auth','pgboss') AND c.relkind IN('r','p','S') ORDER BY n.nspname,c.relname")).rows;
  const policies = (await client.query("SELECT schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check FROM pg_policies WHERE schemaname IN('faultline','auth','pgboss') ORDER BY schemaname,tablename,policyname")).rows;
  const functions = (await client.query("SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,r.rolname AS owner,p.prosecdef AS security_definer,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname IN('faultline','auth','pgboss') ORDER BY n.nspname,p.proname,arguments")).rows;
  const events = (await client.query(`SELECT workspace_id::text,snapshot_id::text,source_id::text,event_id,session_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM faultline.canonical_events ORDER BY workspace_id,snapshot_id,source_id,event_id`)).rows;
  demand(events.length <= 1_000_000 && events.every(row => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.occurred_at)), 'TIMESTAMP_PRECISION', 'Canonical event timestamps must retain six fractional digits.');
  return {inventory_version: 2, server_version: (await client.query('SHOW server_version')).rows[0].server_version, counts, migrations: (await client.query('SELECT id,checksum FROM faultline.schema_migrations ORDER BY id')).rows, roles, security, security_hash: hash({security, policies, functions}), event_timestamps: {count: events.length, hash: hash(events), microsecond_values: events.filter(row => !row.occurred_at.endsWith('000Z')).length},database_configuration:{encoding:databaseConfiguration.encoding,collation:databaseConfiguration.collation,ctype:databaseConfiguration.ctype}};
}
export function assertRuntimeRoles(value: DatabaseInventory): void {
  demand(/^17\./.test(value.server_version), 'POSTGRES_VERSION', 'This installation and recovery inventory require PostgreSQL 17.');
  demand(value.roles.length === ROLES.length && value.roles.every(role => !role.rolsuper && !role.rolbypassrls && !role.rolcreatedb && !role.rolcreaterole && !role.rolinherit && Array.isArray(role.memberships)&&role.memberships.length===0 && (role.rolname === 'faultline_authority' ? !role.rolcanlogin : role.rolcanlogin)), 'UNSAFE_RUNTIME_ROLES', 'Expected isolated non-owner runtime roles and a non-login authority.');
  demand(value.security.every(table => !ROLES.filter(role => role !== 'faultline_authority').includes(String(table.owner))), 'UNSAFE_RUNTIME_OWNERSHIP', 'Runtime roles must not own recovery tables.');
  demand(value.security.every(table => !table.tenant_table || (table.rls && table.force_rls)), 'TENANT_RLS_REQUIRED', 'Tenant tables must enable and force row-level security.');
}
export async function assertQuiesced(client: pg.Client): Promise<void> {
  const connections = (await client.query('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type=\'client backend\'')).rows[0].n;
  const jobs = (await client.query("SELECT count(*)::integer AS n FROM faultline.jobs WHERE status IN('running','cancel_requested')")).rows[0].n;
  const active = (await client.query("SELECT count(*)::integer AS n FROM pgboss.job WHERE state='active'")).rows[0].n;
  demand(connections === 0 && jobs === 0 && active === 0, 'SERVICES_NOT_QUIESCED', 'Stop API/worker and other database clients; reconcile active jobs before offline backup.');
}
export async function writeReport(operation: string, value: object, id = randomUUID()): Promise<string> {
  demand(/^[a-z_-]+$/.test(operation), 'INVALID_OPERATION', 'Invalid recovery report operation.');
  const record=value as Record<string,unknown>,reportId=['backup','restore'].includes(operation)&&typeof record.id==='string'&&/^[a-f0-9-]{36}$/i.test(record.id)?record.id:id;
  const unsigned=JSON.parse(JSON.stringify(value)) as Record<string,unknown>;let document:Record<string,unknown>=unsigned;
  if(operation==='backup'||operation==='restore'){
    const signingPath=path.resolve(process.env.REPORT_SIGNING_KEY_PATH??'.runtime/keys/report-private.pem');
    try{
      const stat=await fs.lstat(signingPath);demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=65536&&(process.platform==='win32'||(stat.mode&0o077)===0),'REPORT_SIGNING_KEY_PRIVATE','Recovery receipt signing key must remain a private bounded regular file.');
      const privateKey=createPrivateKey(await fs.readFile(signingPath)),publicDer=createPublicKey(privateKey).export({format:'der',type:'spki'}),signature=sign(null,Buffer.from(canonical(unsigned)),privateKey).toString('base64');
      document={...unsigned,receipt_signature:{schema_version:1,signer_sha256:byteHash(publicDer),signature}};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new DomainError('REPORT_SIGNING_KEY_REQUIRED','A private receipt signer is required to record backup/restore verification.');throw error;}
  }
  const file = path.resolve('reports/application', `ops-${operation}-${reportId}.json`); await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  await fs.writeFile(file, JSON.stringify(document, null, 2) + '\n', {flag: 'wx', mode: 0o600}); return file;
}
async function wrappingKey(file: string, create: boolean): Promise<Buffer> {
  if (create) {await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700}); try {await fs.writeFile(file, randomBytes(32), {flag: 'wx', mode: 0o600});} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}}
  const key = await regularBytes(file, 32); demand(key.length === 32, 'BACKUP_WRAP_KEY_INVALID', 'A separate 32-byte backup wrapping key is required.'); return key;
}
export async function readBundle(file: string, wrapFile: string, trustedPublicFile: string): Promise<BackupBundle> {
  const raw = await regularBytes(file, MAX_ARCHIVE_BYTES); demand(raw.length > MAGIC.length + 28 && raw.subarray(0, MAGIC.length).equals(MAGIC), 'BACKUP_FORMAT', 'Unsupported encrypted backup format.');
  const key = await wrappingKey(wrapFile, false), iv = raw.subarray(MAGIC.length, MAGIC.length + 12), tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28);
  let clear: Buffer; try {const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(MAGIC); decipher.setAuthTag(tag); clear = Buffer.concat([decipher.update(raw.subarray(MAGIC.length + 28)), decipher.final()]);} catch {throw new DomainError('BACKUP_AUTHENTICATION_FAILED', 'Archive authentication failed; restore was not attempted.');}
  demand(clear.length<=MAX_RECOVERY_FRAME_BYTES,'BACKUP_SIZE_LIMIT','Authenticated recovery frame exceeds the installed Node finite string ceiling.');
  let bundle: BackupBundle; try {bundle = JSON.parse(clear.toString('utf8')) as BackupBundle;} catch {throw new DomainError('BACKUP_FORMAT', 'Invalid authenticated backup document.');}
  demand([1,2,3].includes(bundle.manifest?.schema_version) && bundle.manifest.offline === true && bundle.manifest.completion === 'complete' && bundle.manifest.external_effects === 'paused' && Array.isArray(bundle.parts) && bundle.parts.length <= 20_000, 'BACKUP_FORMAT', 'Unsupported or incomplete backup manifest.');
  demand([1,2].includes(bundle.manifest.database?.inventory_version), 'BACKUP_INVENTORY_VERSION', 'Backup must declare a supported complete inventory version. Legacy membership coverage remains explicitly unrecorded.');
  const trusted = await regularBytes(trustedPublicFile, 65_536), publicKey = createPublicKey(trusted), publicDer = publicKey.export({format: 'der', type: 'spki'});
  demand(byteHash(publicDer) === bundle.manifest.signer_sha256 && bundle.manifest_hash === hash(bundle.manifest) && verify(null, Buffer.from(canonical(bundle.manifest)), publicKey, Buffer.from(bundle.signature, 'base64')), 'BACKUP_SIGNATURE_FAILED', 'Backup signer is not the separately trusted installation signer.');
  demand(hash(bundle.parts.map(partDescriptor))===hash(bundle.manifest.parts),'BACKUP_MANIFEST_MISMATCH','Recovery descriptors differ from the independently signed manifest.');
  assertPartInventoryLimits(bundle.parts,bundle.manifest.schema_version);
  const names = new Set<string>();
  for (const part of bundle.parts) {
    demand(typeof part.name === 'string' && /^(database\.sql|database\/[0-9]{6}\.sql|keys\/(keyring\.json|report-private\.pem|report-public\.pem|recovery-secrets\.json)|objects\/[a-f0-9-]{36}\/[a-f0-9]{64}|runner\/key\.bin|runner\/state\/(runs|requests|terminals|tombstones|request-tombstones)\/[a-f0-9-]{36}\.json|runner\/artifacts\/[a-f0-9-]{36}\/((known_good|incident|candidate)-(mobile|desktop)-[1-3]\.png|observations\.jsonl|receipt\.json))$/.test(part.name) && !names.has(part.name), 'BACKUP_PATH_INVALID', 'Invalid, repeated or unsafe archive path.'); names.add(part.name);
  }
  demand(names.has('keys/keyring.json') && names.has('keys/report-private.pem') && names.has('keys/report-public.pem') && names.has('keys/recovery-secrets.json'), 'BACKUP_MANIFEST_MISMATCH', 'Required backup contents do not match the signed manifest.');
  if(bundle.manifest.schema_version===3){demand(!names.has('database.sql')&&bundle.manifest.database_dump,'BACKUP_MANIFEST_MISMATCH','Chunked SQL requires its signed full original descriptor.');for(const bytes of decodeDatabaseDump(bundle.manifest.database_dump,bundle.parts))void bytes;}
  else demand(names.has('database.sql')&&!bundle.manifest.database_dump&&!bundle.parts.some(part=>part.name.startsWith('database/')),'BACKUP_MANIFEST_MISMATCH','Legacy SQL contents must retain their original finite format.');
  for(const part of bundle.parts)if(!part.name.startsWith('database/'))decodeBackupPart(part,bundle.manifest.schema_version);
  return bundle;
}
export async function backupOffline(args: string[]): Promise<object> {
  demand(args.includes('--offline') && args.includes('--services-quiesced') && args.every(value => ['--offline', '--services-quiesced'].includes(value)), 'OFFLINE_CONFIRMATION_REQUIRED', 'Backup requires --offline --services-quiesced and stopped API/worker processes.');
  await checkRecoveryCapacity(process.cwd());
  const started = Date.now(), options = settings(), id = randomUUID(), versions = await pgVersions();
  const nativeLock=process.env.RUNNER_MODE==='trusted_fixture'?await acquireNativeLock(path.resolve(process.env.RUNNER_STATE_ROOT??'.runtime/fixture-runner'),'backup'):null;
  const client = connection(options.url);let transaction=false;
  try {await assertNativeRunnerStopped();await client.connect();
    const operator = (await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    demand(operator?.rolsuper && operator.rolbypassrls, 'FULL_INSTALLATION_BACKUP_REQUIRED', 'This local full-installation recovery tool requires the trusted operator role, never a tenant-scoped runtime role.');
    await assertQuiesced(client);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const database = await inventory(client); assertRuntimeRoles(database);
    const references = (await client.query(`SELECT workspace_id::text,object_key,size_bytes::text FROM faultline.object_references ORDER BY workspace_id,object_key`)).rows;
    const required = (await client.query(`SELECT workspace_id::text,raw_key AS object_key FROM faultline.imports UNION SELECT workspace_id::text,normalized_key FROM faultline.imports WHERE normalized_key IS NOT NULL UNION SELECT workspace_id::text,object_key FROM faultline.snapshots UNION SELECT workspace_id::text,object_key FROM faultline.report_exports UNION SELECT workspace_id::text,object_key FROM faultline.evidence_artifacts UNION SELECT workspace_id::text,object_key FROM faultline.integration_capture_artifacts UNION SELECT workspace_id::text,object_key FROM faultline.verification_artifacts UNION SELECT workspace_id::text,patch_key FROM faultline.experiment_candidates WHERE patch_key IS NOT NULL`)).rows;
    const referenceMap = new Map<string, {workspace_id: string; object_key: string; size_bytes: string}>();
    for (const reference of references) {const key = `${reference.workspace_id}/${reference.object_key}`, prior = referenceMap.get(key); demand(!prior || prior.size_bytes === reference.size_bytes, 'OBJECT_REFERENCE_CONFLICT', 'Immutable object references disagree on length.'); referenceMap.set(key, reference);}
    demand(required.every(row => referenceMap.has(`${row.workspace_id}/${row.object_key}`)), 'OBJECT_REFERENCE_MISSING', 'Every database object reference must be included in the immutable reference ledger.');
    const dump = await runPgStream('pg_dump', ['--no-password', '--format=plain', '--encoding=UTF8', '--lock-wait-timeout=5000', '--snapshot=' + snapshot], options.url,async source=>{const encoder=encodeDatabaseDump(source),sqlParts:BackupPart[]=[];let item=await encoder.next();while(!item.done){sqlParts.push(item.value);item=await encoder.next();}return {parts:sqlParts,descriptor:item.value};},undefined,MAX_RECOVERY_LOGICAL_BYTES);
    demand(dump.stderr_bytes === 0, 'PG_DUMP_DIAGNOSTICS', 'pg_dump emitted diagnostics; backup remains unverified rather than concealing warnings.');
    const parts: BackupPart[] = []; let total = 0,storedTotal=0;
    const addPart=(part:BackupPart)=>{total+=part.size_bytes;demand(total<=MAX_RECOVERY_LOGICAL_BYTES&&parts.length<20_000,'BACKUP_SIZE_LIMIT','Recovery supports at most1 GiB logical bytes and20,000 parts.');storedTotal+=Buffer.byteLength(part.bytes_base64,'base64');demand(storedTotal<=MAX_RECOVERY_STORED_BYTES,'BACKUP_SIZE_LIMIT','Compressed recovery bytes exceed512 MiB.');parts.push(part);};
    const add=(name:string,bytes:Buffer)=>addPart(encodeBackupPart(name,bytes));
    for(const part of dump.value.parts)addPart(part);
    for (const reference of referenceMap.values()) {
      demand(/^[a-f0-9-]{36}$/i.test(reference.workspace_id) && /^[a-f0-9]{64}$/.test(reference.object_key), 'OBJECT_REFERENCE_INVALID', 'Invalid immutable object identity.');
      demand(Number.isSafeInteger(Number(reference.size_bytes))&&Number(reference.size_bytes)>=0&&Number(reference.size_bytes)<=MAX_RECOVERY_PART_BYTES,'BACKUP_SIZE_LIMIT','Referenced object exceeds the schema2 original-part ceiling.');
      const file = await privatePath(path.join(options.object_root, reference.workspace_id, reference.object_key), options.object_root), bytes = await regularBytes(file, MAX_RECOVERY_PART_BYTES);
      demand(bytes.length === Number(reference.size_bytes) && byteHash(bytes) === reference.object_key, 'OBJECT_CHECKSUM_FAILED', 'Referenced immutable object is missing or corrupt.'); add('objects/' + reference.workspace_id + '/' + reference.object_key, bytes);
    }
    const keyringBytes = await regularBytes(options.keyring, 65_536), keyring = JSON.parse(keyringBytes.toString('utf8')) as {active: string; keys: Record<string, string>};
    const keyVersions = Object.keys(keyring.keys ?? {}).sort();
    demand(keyVersions.length > 0 && keyVersions.length <= 32 && keyVersions.includes(keyring.active) && keyVersions.every(version => /^[A-Za-z0-9_-]{1,64}$/.test(version) && Buffer.from(keyring.keys[version]!, 'base64').length === 32), 'KEYRING_INVALID', 'Necessary key versions must contain valid AES-256 keys.');
    const requiredKeys = (await client.query('SELECT key_version FROM faultline.secrets UNION SELECT key_version FROM faultline.secret_versions UNION SELECT key_version FROM faultline.source_identity_policies UNION SELECT key_version FROM faultline.case_redaction_keys')).rows;
    demand(requiredKeys.every(row => keyVersions.includes(row.key_version)), 'RECOVERY_KEY_VERSION_MISSING', 'Referenced encryption key versions must remain recoverable.');
    const recoveryCiphertexts=await verifyRecoveryCiphertexts(client,keyring);
    const privateBytes = await regularBytes(options.signing_key, 65_536), publicBytes = await regularBytes(options.signing_public, 65_536), privateKey = createPrivateKey(privateBytes), publicKey = createPublicKey(publicBytes), derived = createPublicKey(privateKey).export({format: 'der', type: 'spki'});
    demand(privateKey.asymmetricKeyType === 'ed25519' && Buffer.from(publicKey.export({format: 'der', type: 'spki'})).equals(derived), 'SIGNING_KEY_MISMATCH', 'Recovery signing key must match its separately retained public identity.');
    const signerId = byteHash(derived), exports = (await client.query('SELECT manifest,signature FROM faultline.report_exports')).rows;
    demand(exports.every(row => row.manifest?.signer_key_id === signerId), 'REPORT_SIGNING_RECOVERY_KEY_MISSING', 'A historical export requires a separately retained signing key version; this installation currently exposes only its configured keypair.');
    demand(exports.every(row => verify(null, Buffer.from(canonical(row.manifest)), publicKey, Buffer.from(row.signature, 'base64'))), 'REPORT_SIGNATURE_INVALID', 'A persisted report export signature does not verify under its retained signer.');
    demand(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32, 'AUTH_RECOVERY_SECRET_MISSING', 'Load private installation authentication configuration.');
    add('keys/keyring.json', keyringBytes); add('keys/report-private.pem', privateBytes); add('keys/report-public.pem', publicBytes); add('keys/recovery-secrets.json', Buffer.from(JSON.stringify({schema_version: 1, AUTH_SECRET: process.env.AUTH_SECRET})));
    let fixtureRunner:BackupManifest['fixture_runner'];
    if(process.env.RUNNER_MODE==='trusted_fixture'){
      const stateRoot=path.resolve(process.env.RUNNER_STATE_ROOT??'.runtime/fixture-runner'),artifactRoot=path.resolve(process.env.RUNNER_ARTIFACT_ROOT??'.runtime/fixture-runner/artifacts'),keyPath=process.env.RUNNER_AUTH_KEY_PATH;
      demand(keyPath,'RUNNER_RECOVERY_KEY_MISSING','The configured fixture runner key must be retained privately.');const runnerKeyBytes=await regularBytes(path.resolve(keyPath),32);demand(runnerKeyBytes.length===32,'RUNNER_RECOVERY_KEY_MISSING','Fixture runner recovery key differs.');add('runner/key.bin',runnerKeyBytes);
      await assertNativeRunnerStopped();const nativeBefore=await nativeInventoryHash([stateRoot,artifactRoot]);
      let ledgerFiles=0,artifactFiles=0,legacy=0;
      for(const kind of ['runs','requests','terminals','tombstones','request-tombstones']){
        const directory=path.join(stateRoot,kind);let names:string[];try{demand((await fs.lstat(directory)).isDirectory()&&!(await fs.lstat(directory)).isSymbolicLink(),'RUNNER_RECOVERY_PATH_INVALID','Fixture ledgers must be regular directories.');names=await fs.readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        demand(names.length<=10000,'RUNNER_RECOVERY_LIMIT','Fixture ledger is bounded.');for(const name of names.sort()){demand(/^[a-f0-9-]{36}\.json$/.test(name),'RUNNER_RECOVERY_PATH_INVALID','Unknown fixture ledger file remains blocked.');const file=await privatePath(path.join(directory,name),stateRoot),bytes=await regularBytes(file,1024*1024);add('runner/state/'+kind+'/'+name,bytes);ledgerFiles++;if(kind==='runs'){try{await fs.access(path.join(stateRoot,'terminals',name));}catch{legacy++;}}}
      }
      let nonces:string[];try{nonces=await fs.readdir(artifactRoot);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')nonces=[];else throw error;}demand(nonces.length<=10000,'RUNNER_RECOVERY_LIMIT','Fixture artifact ledger is bounded.');
      for(const nonce of nonces.sort()){demand(/^[a-f0-9-]{36}$/.test(nonce),'RUNNER_RECOVERY_PATH_INVALID','Unknown fixture artifact scope remains blocked.');const directory=path.join(artifactRoot,nonce),stat=await fs.lstat(directory);demand(stat.isDirectory()&&!stat.isSymbolicLink(),'RUNNER_RECOVERY_PATH_INVALID','Fixture artifact scopes must be regular directories.');const names=await fs.readdir(directory);demand(names.length<=20,'RUNNER_RECOVERY_LIMIT','Fixture artifact cell inventory exceeds its bound.');for(const name of names.sort()){demand(/^(known_good|incident|candidate)-(mobile|desktop)-[1-3]\.png$/.test(name)||['observations.jsonl','receipt.json'].includes(name),'RUNNER_RECOVERY_PATH_INVALID','Unknown fixture artifact remains blocked.');const file=await privatePath(path.join(directory,name),artifactRoot),bytes=await regularBytes(file,10*1024*1024);add('runner/artifacts/'+nonce+'/'+name,bytes);artifactFiles++;}}
      demand(await nativeInventoryHash([stateRoot,artifactRoot])===nativeBefore,'RUNNER_RECOVERY_CHANGED','Native runner inventory changed during offline copy.');await assertNativeRunnerStopped();
      fixtureRunner={scope:'trusted_fixture',production_claim_eligible:false,ledger_files:ledgerFiles,artifact_files:artifactFiles,legacy_without_terminal_count:legacy};
    }
    demand(options.wrap_key !== options.keyring && options.wrap_key !== options.signing_key, 'BACKUP_WRAP_KEY_SEPARATION', 'Backup wrapping key must be independent of product encryption/signing keys.');
    await assertQuiesced(client); await client.query('COMMIT'); transaction = false;
    const manifest: BackupManifest = {schema_version: 3, database_dump:dump.value.descriptor, id, created_at: new Date().toISOString(), application_version: JSON.parse(await fs.readFile('package.json', 'utf8')).version, snapshot_method: 'exported_repeatable_read', offline: true, source_database: options.url.pathname.slice(1), database,...(fixtureRunner?{fixture_runner:fixtureRunner}:{}), object_count: referenceMap.size, key_versions: keyVersions, report_signing_key_versions: [signerId], parts: parts.map(partDescriptor), signer_sha256: signerId, completion: 'complete', external_effects: 'paused'};
    const bundle: BackupBundle = {manifest, manifest_hash: hash(manifest), signature: sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64'), parts};
    const wrap = await wrappingKey(options.wrap_key, true);
    demand(!keyVersions.some(version => Buffer.from(keyring.keys[version]!, 'base64').equals(wrap)), 'BACKUP_WRAP_KEY_SEPARATION', 'Backup wrapping key must not reuse any product encryption key version.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrap, iv); cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([cipher.update(serializeBackupFrame(bundle), 'utf8'), cipher.final()]), archive = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]); demand(archive.length <= MAX_ARCHIVE_BYTES, 'BACKUP_SIZE_LIMIT', 'Encrypted archive exceeds the local limit.');
    const destination = path.resolve('.runtime/backups', `faultline-${id}.flbackup`); await fs.mkdir(path.dirname(destination), {recursive: true, mode: 0o700}); await fs.writeFile(destination, archive, {flag: 'wx', mode: 0o600});
    await readBundle(destination, options.wrap_key, options.signing_public);
    return {operation: 'backup', status: 'complete_restore_not_run', id, checked_at:new Date().toISOString(),archive_path: destination, archive_sha256: byteHash(archive), manifest_hash: bundle.manifest_hash, snapshot_method: manifest.snapshot_method, backup_schema_version:manifest.schema_version,logical_bytes:total,stored_compressed_bytes:storedTotal,dump_bytes: dump.value.descriptor.size_bytes,sql_part_count:dump.value.parts.length,sql_sha256:dump.value.descriptor.sha256, object_count: manifest.object_count, key_versions: keyVersions, report_signing_key_versions: manifest.report_signing_key_versions, persisted_report_signatures_verified: exports.length,retained_ciphertexts_verified:recoveryCiphertexts, database_counts: database.counts, timestamp_count: database.event_timestamps.count, timestamp_hash: database.event_timestamps.hash, client_versions: versions, duration_ms: Date.now() - started, external_effects: 'paused', limitations: ['Archive is authenticated and complete; it is not verified until the isolated restore succeeds.', 'A separate retained wrapping key and trusted report public key are required.']};
  } finally {if (transaction) await client.query('ROLLBACK').catch(() => {}); await client.end();await nativeLock?.release();}
}
export async function cliMain(operation: string, action: () => Promise<object>): Promise<void> {
  try {const result = await action(), report = await writeReport(operation, result); console.log(JSON.stringify({...result, evidence_path: report}));}
  catch (error) {const result = {operation, status: 'failed', code: error instanceof DomainError ? error.code : (error as NodeJS.ErrnoException).code ?? 'OPERATION_FAILED', at: new Date().toISOString(), external_effects: 'paused'}; const report = await writeReport(operation, result); console.error(JSON.stringify({...result, evidence_path: report})); process.exitCode = 1;}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cliMain('backup', () => backupOffline(process.argv.slice(2)));
