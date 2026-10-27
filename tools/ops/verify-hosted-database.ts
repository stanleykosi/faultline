import pg from 'pg';
import {runtimeMigrations} from '../../packages/database/src/runtime-migrations.js';
import {demand} from '../../packages/core/src/errors.js';

type RuntimeRole = 'faultline_api'|'faultline_auth'|'faultline_queue'|'faultline_dispatcher';
const required=(name:string)=>{const value=process.env[name];demand(value,'CONFIGURATION','Configure '+name+' in the private operator environment.');return value;};
const admin=new pg.Pool({connectionString:required('MIGRATION_DATABASE_URL')});
const runtimeConnections:[RuntimeRole,string][]=[
 ['faultline_api',required('DATABASE_URL')],
 ['faultline_auth',required('AUTH_DATABASE_URL')],
 ['faultline_queue',required('QUEUE_DATABASE_URL')],
 ['faultline_dispatcher',required('DISPATCHER_DATABASE_URL')],
];

async function deniedDdl(url:string){
 const connection=new pg.Pool({connectionString:url,max:1});
 try{
  try{await connection.query('CREATE TABLE public.faultline_runtime_escape_probe(id integer)');}
  catch(error){return (error as {code?:string}).code==='42501';}
  await connection.query('DROP TABLE IF EXISTS public.faultline_runtime_escape_probe').catch(()=>{});
  return false;
 }finally{await connection.end();}
}

try{
 const migrations=(await admin.query('SELECT id,checksum FROM faultline.schema_migrations ORDER BY id')).rows;
 demand(migrations.length===runtimeMigrations.length&&runtimeMigrations.every((expected,index)=>migrations[index]?.id===expected.id&&migrations[index]?.checksum===expected.checksum),'SCHEMA_UNSUPPORTED','Hosted migration ledger does not match the reviewed runtime schema.',503);
 const roleRows=(await admin.query("SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS has_memberships,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('auth','faultline','pgboss') AND c.relowner=r.oid) AS owns_runtime_tables FROM pg_roles r WHERE rolname=ANY($1::text[]) ORDER BY rolname",[[...runtimeConnections.map(([role])=>role),'faultline_authority']])).rows;
 demand(roleRows.length===5,'UNSAFE_DATABASE_ROLE','All reviewed hosted roles must exist.',503);
 for(const row of roleRows){
  const shouldLogin=row.rolname!=='faultline_authority';
  demand(row.rolcanlogin===shouldLogin&&!row.rolsuper&&!row.rolbypassrls&&!row.rolcreatedb&&!row.rolcreaterole&&!row.rolinherit&&!row.has_memberships&&!row.owns_runtime_tables,'UNSAFE_DATABASE_ROLE','Hosted role flags or ownership exceed the reviewed boundary: '+row.rolname,503);
 }
 const authTables=(await admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema='auth' AND table_name=ANY($1::text[]) ORDER BY table_name",[['account','session','user','verification']])).rows.map(row=>row.table_name);
 demand(authTables.length===4,'SCHEMA_UNSUPPORTED','Better Auth tables are missing after migration.',503);
 const separation:Record<string,object>={};
 for(const [expectedRole,url] of runtimeConnections){
  const connection=new pg.Pool({connectionString:url,max:1});
  try{
   const row=(await connection.query("SELECT current_user,has_schema_privilege(current_user,'auth','USAGE') AS auth_access,has_schema_privilege(current_user,'faultline','USAGE') AS tenant_access,has_schema_privilege(current_user,'pgboss','USAGE') AS queue_access,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='faultline' AND c.relname='installation' AND has_table_privilege(current_user,c.oid,'SELECT')) AS installation_read,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='faultline' AND c.relname='jobs' AND has_any_column_privilege(current_user,c.oid,'SELECT')) AS jobs_read")).rows[0];
   demand(row.current_user===expectedRole,'UNSAFE_DATABASE_ROLE','Runtime connection resolved to the wrong role.',503);
   if(expectedRole==='faultline_api')demand(!row.auth_access&&row.tenant_access&&!row.queue_access&&!row.installation_read,'UNSAFE_DATABASE_ROLE','API role separation failed.',503);
   if(expectedRole==='faultline_auth')demand(row.auth_access&&!row.tenant_access&&!row.queue_access&&!row.installation_read,'UNSAFE_DATABASE_ROLE','Auth role separation failed.',503);
   if(expectedRole==='faultline_queue')demand(!row.auth_access&&!row.tenant_access&&row.queue_access&&!row.installation_read,'UNSAFE_DATABASE_ROLE','Queue role separation failed.',503);
   if(expectedRole==='faultline_dispatcher')demand(!row.auth_access&&row.tenant_access&&!row.queue_access&&!row.installation_read&&!row.jobs_read,'UNSAFE_DATABASE_ROLE','Dispatcher role separation failed.',503);
   demand(await deniedDdl(url),'UNSAFE_DATABASE_ROLE','Runtime role unexpectedly created a table: '+expectedRole,503);
   separation[expectedRole]={connected_as_expected:true,ddl_denied:true,installation_read:false};
  }finally{await connection.end();}
 }
 console.log(JSON.stringify({operation:'verify_hosted_database',status:'passed',migration_count:migrations.length,migration_ids:migrations.map(row=>row.id),auth_tables:authTables,roles:roleRows.map(row=>({name:row.rolname,can_login:row.rolcanlogin})),separation}));
}finally{await admin.end();}
