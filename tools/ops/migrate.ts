import {identitySql,identitySchema} from "../../packages/database/src/identity-schema.js";
import fs from 'node:fs/promises';
import pg from 'pg';
import {getMigrations} from 'better-auth/db/migration';
import {PgBoss} from 'pg-boss';
import {makeAuth} from '../../packages/core/src/identity/auth.js';
import {byteHash} from '../../packages/core/src/canonical.js';
import {demand} from '../../packages/core/src/errors.js';
import {authDatabaseTypes} from '../../packages/database/src/client.js';
const url=process.env.MIGRATION_DATABASE_URL;demand(url,'CONFIGURATION','Configure MIGRATION_DATABASE_URL in the private operator environment.');
const admin=new pg.Pool({connectionString:url}),authAdmin=new pg.Pool({connectionString:url,types:authDatabaseTypes,options:identitySql('-c search_path=auth')});
const lock=await admin.connect();
try{
 await lock.query("SELECT pg_advisory_lock(hashtextextended('faultline.migrations',0))");
 if(identitySchema==='faultline_identity'){
  const prior=await lock.query("SELECT to_regclass('faultline.schema_migrations') AS ledger, to_regnamespace('faultline_identity') AS identity");
  if(prior.rows[0].ledger){
   const profile=await lock.query("SELECT to_regclass('faultline.hosting_profile') AS profile");
   demand(profile.rows[0].profile,'HOSTING_PROFILE_MISMATCH','Use a fresh database for the Supabase hosting profile; existing installations need a reviewed transfer.',409);
   demand((await lock.query("SELECT identity_schema FROM faultline.hosting_profile WHERE singleton")).rows[0]?.identity_schema===identitySchema,'HOSTING_PROFILE_MISMATCH','The installed identity profile differs.',409);
  }else demand(!prior.rows[0].identity,'IDENTITY_SCHEMA_IN_USE','The identity schema must be empty before the first installation.',409);
 }
 await lock.query('CREATE SCHEMA IF NOT EXISTS faultline; CREATE TABLE IF NOT EXISTS faultline.schema_migrations(id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 const apply=async(id:string,source:string)=>{
  const sql=identitySql(source);
  const checksum=byteHash(sql),prior=(await lock.query('SELECT checksum FROM faultline.schema_migrations WHERE id=$1',[id])).rows[0];
  if(prior){demand(prior.checksum===checksum,'MIGRATION_CHANGED','An applied migration changed: '+id,409);return;}
  try{await lock.query('BEGIN');await lock.query(sql);await lock.query('INSERT INTO faultline.schema_migrations(id,checksum) VALUES($1,$2)',[id,checksum]);await lock.query('COMMIT');}
  catch(e){await lock.query('ROLLBACK');throw e;}
 };
 await apply('0001-foundation',await fs.readFile('packages/database/migrations/0001-foundation.sql','utf8'));
 if(identitySchema==='faultline_identity')await lock.query("CREATE TABLE IF NOT EXISTS faultline.hosting_profile(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),identity_schema text NOT NULL CHECK(identity_schema='faultline_identity')); INSERT INTO faultline.hosting_profile(singleton,identity_schema) VALUES(true,'faultline_identity') ON CONFLICT DO NOTHING; REVOKE ALL ON faultline.hosting_profile FROM PUBLIC");
 const identity=makeAuth(authAdmin)!;const authMigrations=await getMigrations(identity.options);
 demand(authMigrations.unsafeChanges.length===0,'UNSAFE_MIGRATION','Auth schema needs explicit operator review.');
 const sql=await authMigrations.compileMigrations();
 await fs.mkdir('reports/application',{recursive:true});if(sql.trim())await fs.writeFile('reports/application/auth-migration-1.7.7-'+byteHash(sql)+'.sql',sql,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
 await authMigrations.runMigrations();
 const migrationFiles=(await fs.readdir('packages/database/migrations')).filter(name=>/^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
 demand(migrationFiles[0]==='0001-foundation.sql'&&migrationFiles.every((name,index)=>Number(name.slice(0,4))===index+1),'MIGRATION_SEQUENCE','Migration files must be contiguous, explicit and unique.');
 for(const fileName of migrationFiles.slice(1)){const file='packages/database/migrations/'+fileName;const stat=await fs.lstat(file);demand(stat.isFile()&&!stat.isSymbolicLink(),'MIGRATION_FILE','Only reviewed regular migration files can execute.');await apply(fileName.slice(0,-4),await fs.readFile(file,'utf8'));}
 const migrationBoss=new PgBoss({connectionString:url,schema:'pgboss',migrate:true,supervise:false});
 await migrationBoss.start();await migrationBoss.createQueue('faultline');await migrationBoss.stop();
 console.log('Explicit versioned schema migrations applied; runtime services do not migrate.');
}finally{await lock.query("SELECT pg_advisory_unlock(hashtextextended('faultline.migrations',0))");lock.release();await admin.end();await authAdmin.end();}

