import pg from 'pg';
import {spawn} from 'node:child_process';
import {demand} from '../../packages/core/src/errors.js';

/** Explicit installer profile. Never called by the API or worker. */
const raw=process.env.MIGRATION_DATABASE_URL;
demand(raw,'OPERATOR_CONFIGURATION_MISSING','Supply a dedicated Supabase installer connection.');
const url=new URL(raw);
demand(['postgres:','postgresql:'].includes(url.protocol)&&url.username&&url.password,'OPERATOR_CONFIGURATION_INVALID','A PostgreSQL installer connection is required.');
const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
demand(loopback?process.env.FAULTLINE_SYNTHETIC_INSTALL==='true':/\.(?:supabase\.co|supabase\.com)$/.test(url.hostname),'SUPABASE_TARGET_REQUIRED','Use a Supabase direct/session connection, or an explicit generated local installation.');
demand(loopback||url.searchParams.get('sslmode')==='verify-full','DATABASE_TLS_REQUIRED','Supabase installer requires certificate-verified TLS.');
demand(url.port!=='6543','SESSION_CONNECTION_REQUIRED','Installer needs a direct or session connection, not transaction pooling.');
demand(process.argv.includes('--install-fresh')||process.argv.includes('--upgrade'),'INSTALL_INTENT_REQUIRED','Choose --install-fresh or --upgrade explicitly.');
const admin=new pg.Pool({connectionString:raw,max:1}),quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
async function run(file:string,args:string[]=[]){await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx',file,...args],{env:{...process.env,AUTH_DATABASE_SCHEMA:'faultline_identity'},stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('SUPABASE_INSTALL_STEP_FAILED')));});}
let authorityGrant=false,schemasGranted=false,installer='';
try{
 installer=(await admin.query('SELECT current_user AS name')).rows[0].name;
 const existing=await admin.query("SELECT to_regnamespace('faultline') AS product, to_regnamespace('faultline_identity') AS identity, to_regnamespace('pgboss') AS queue");
 const fresh=process.argv.includes('--install-fresh');
 if(fresh)demand(!existing.rows[0].product&&!existing.rows[0].identity&&!existing.rows[0].queue,'EXISTING_INSTALLATION','Fresh installation requires unused Faultline, identity and queue schemas. Existing data is never replaced.',409);
 else{
  demand((await admin.query("SELECT to_regclass('faultline.hosting_profile') AS profile")).rows[0].profile,'HOSTING_PROFILE_MISMATCH','Only an existing Supabase profile can be upgraded.',409);
  demand((await admin.query('SELECT identity_schema FROM faultline.hosting_profile WHERE singleton')).rows[0]?.identity_schema==='faultline_identity','HOSTING_PROFILE_MISMATCH','Installed profile differs.',409);
 }
 if(fresh){
  // This command provisions only a new installation; existing passwords are never rotated.
  demand(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname IN('faultline_api','faultline_auth','faultline_queue','faultline_dispatcher','faultline_authority')")).rowCount,'ROLES_ALREADY_EXIST','Use a dedicated project; runtime roles already exist.',409);
  // DDL and role provisioning commit together, so an interrupted first step leaves no half-installed roles.
  const quoteValue=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  await admin.query('BEGIN');
  try{
   for(const [role,name] of [['faultline_api','API_DATABASE_PASSWORD'],['faultline_auth','AUTH_DATABASE_PASSWORD'],['faultline_queue','QUEUE_DATABASE_PASSWORD'],['faultline_dispatcher','DISPATCHER_DATABASE_PASSWORD']]){
    const password=process.env[name!];demand(password&&password.length>=24,'OPERATOR_CONFIGURATION_MISSING','Provide all four new runtime role passwords.');
    await admin.query('CREATE ROLE '+quote(role!)+' LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '+quoteValue(password));
   }
   await admin.query('CREATE ROLE faultline_authority NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT');
   await admin.query("CREATE SCHEMA faultline; CREATE SCHEMA faultline_identity; CREATE SCHEMA pgboss; CREATE TABLE faultline.schema_migrations(id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE faultline.hosting_profile(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),identity_schema text NOT NULL CHECK(identity_schema='faultline_identity')); INSERT INTO faultline.hosting_profile VALUES(true,'faultline_identity'); REVOKE ALL ON SCHEMA faultline,faultline_identity,pgboss FROM PUBLIC; REVOKE ALL ON faultline.hosting_profile FROM PUBLIC");
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
 }
 const membership=(await admin.query("SELECT pg_has_role(current_user,'faultline_authority','SET') AS can_set")).rows[0];
 if(!membership.can_set){await admin.query('GRANT faultline_authority TO '+quote(installer)+' WITH SET TRUE');authorityGrant=true;}
 await admin.query('GRANT USAGE,CREATE ON SCHEMA faultline,faultline_identity TO faultline_authority');schemasGranted=true;
 await run('tools/ops/migrate.ts');
 await run('tools/ops/roles.ts',['--finalize-existing']);
 console.log('Supabase schema installation verified. Supabase-managed auth was not used. Runtime and storage acceptance are separate gates.');
}finally{
 try{if(schemasGranted)await admin.query('REVOKE CREATE ON SCHEMA faultline,faultline_identity FROM faultline_authority');}
 finally{try{if(authorityGrant)await admin.query('GRANT faultline_authority TO '+quote(installer)+' WITH SET FALSE');}finally{await admin.end();}}
}
