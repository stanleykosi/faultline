import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {betterAuth} from 'better-auth';
import {getMigrations} from 'better-auth/db/migration';
import {demand} from '../../packages/core/src/errors.js';
import {runtimeMigrations} from '../../packages/database/src/runtime-migrations.js';

type Counts={users:string;workspaces:string;cases:string;snapshots:string};
type Queryable=pg.Pool|pg.PoolClient;

const required=(name:string)=>{
 const value=process.env[name];
 demand(value,'CONFIGURATION','Configure '+name+' in the private operator environment.');
 return value;
};
const migrationUrl=required('MIGRATION_DATABASE_URL');
const allowedPending=new Set(['0030-external-browser-bindings','0031-case-agent','0032-agent-retention-cascade']);
const authTimestampParsers=new Map([1114,1184].map(oid=>[oid,pg.types.getTypeParser(oid,'text')]));
const authDatabaseTypes:pg.CustomTypesConfig={getTypeParser(oid,format){return format==='binary'?pg.types.getTypeParser(oid,'binary'):authTimestampParsers.get(oid)??pg.types.getTypeParser(oid,'text');}};
const checksum=(value:string)=>createHash('sha256').update(value).digest('hex');

const readCounts=async(database:Queryable):Promise<Counts>=>{
 const row=(await database.query(`SELECT
  (SELECT count(*) FROM auth."user")::text AS users,
  (SELECT count(*) FROM faultline.workspaces)::text AS workspaces,
  (SELECT count(*) FROM faultline.cases)::text AS cases,
  (SELECT count(*) FROM faultline.snapshots)::text AS snapshots`)).rows[0] as Counts|undefined;
 demand(row,'SCHEMA_UNSUPPORTED','Hosted tenant-count preflight returned no row.',503);
 return row;
};

const readLedger=async(database:Queryable)=>
 (await database.query('SELECT id,checksum FROM faultline.schema_migrations ORDER BY id')).rows as {id:string;checksum:string}[];

const demandExactPrefix=(rows:{id:string;checksum:string}[])=>{
 demand(rows.length>=29&&rows.length<=runtimeMigrations.length,'SCHEMA_UNSUPPORTED','Hosted migration ledger is outside the reviewed external-browser and agent-first upgrade boundary.',503);
 demand(rows.every((row,index)=>row.id===runtimeMigrations[index]?.id&&row.checksum===runtimeMigrations[index]?.checksum),'MIGRATION_CHANGED','Hosted migration ledger does not match the reviewed runtime prefix.',409);
 const pending=runtimeMigrations.slice(rows.length).map(item=>item.id);
 demand(pending.every(id=>allowedPending.has(id)),'SCHEMA_UNSUPPORTED','An unreviewed hosted migration would be applied.',503);
 return pending;
};

const demandQueueCurrent=async(database:Queryable)=>{
 const row=(await database.query("SELECT (SELECT version FROM pgboss.version)::int AS version, EXISTS(SELECT 1 FROM pgboss.queue WHERE name='faultline') AS queue_exists")).rows[0];
 demand(row?.version===45&&row?.queue_exists===true,'SCHEMA_UNSUPPORTED','pg-boss schema or the Faultline queue has an unrelated pending change.',503);
};

const demandNoJobOrphans=async(database:Queryable,agentTablesExist:boolean)=>{
 if(!agentTablesExist)return;
 const row=(await database.query(`SELECT
  (SELECT count(*) FROM faultline.agent_turns t LEFT JOIN faultline.jobs j ON j.workspace_id=t.workspace_id AND j.case_id=t.case_id AND j.id=t.job_id WHERE t.job_id IS NOT NULL AND j.id IS NULL)::int AS turn_job,
  (SELECT count(*) FROM faultline.agent_actions a LEFT JOIN faultline.jobs j ON j.workspace_id=a.workspace_id AND j.case_id=a.case_id AND j.id=a.target_job_id WHERE a.target_job_id IS NOT NULL AND j.id IS NULL)::int AS action_job`)).rows[0];
 demand(row?.turn_job===0&&row?.action_job===0,'SCHEMA_UNSUPPORTED','Agent job bindings contain rows that migration 0032 would reject.',503);
};

const database=new pg.Pool({connectionString:migrationUrl,max:1,connectionTimeoutMillis:10_000,query_timeout:15_000});
const authDatabase=new pg.Pool({connectionString:migrationUrl,max:1,types:authDatabaseTypes,options:'-c search_path=auth'});
let beforeCounts:Counts;
let beforeIds:string[];
let pending:string[];
const lock=await database.connect();
try{
 await lock.query("SELECT pg_advisory_lock(hashtextextended('faultline.migrations',0))");
 const before=await readLedger(lock);
 pending=demandExactPrefix(before);
 beforeIds=before.map(row=>row.id);
 beforeCounts=await readCounts(lock);
 await demandQueueCurrent(lock);
 const agentTablesExist=(await lock.query("SELECT to_regclass('faultline.agent_turns') IS NOT NULL AS present")).rows[0]?.present===true;
 await demandNoJobOrphans(lock,agentTablesExist);
 const migrationAuth=betterAuth({
  database:authDatabase,baseURL:'https://migration.invalid',basePath:'/api/auth',secret:'migration-schema-check-only-secret',trustedOrigins:['https://migration.invalid'],
  emailAndPassword:{enabled:true,minPasswordLength:12,autoSignIn:true},
  user:{additionalFields:{enrollmentHash:{type:'string',required:false,input:false,returned:false}}},
  session:{expiresIn:60*60*24*7,updateAge:60*60*24,cookieCache:{enabled:false}},
  advanced:{database:{joins:true},useSecureCookies:true,defaultCookieAttributes:{httpOnly:true,sameSite:'lax',path:'/'}}
 });
 const authMigrations=await getMigrations(migrationAuth.options);
 const authSql=await authMigrations.compileMigrations();
 demand(authMigrations.unsafeChanges.length===0,'UNSAFE_MIGRATION','Better Auth reported an unsafe change outside the reviewed agent-first database upgrade.');
 demand(authSql.trim()===';','UNSAFE_MIGRATION','Better Auth has pending SQL outside the reviewed agent-first database upgrade.');
 for(const id of pending){
  const file='packages/database/migrations/'+id+'.sql';
  const stat=await fs.lstat(file);
  demand(stat.isFile()&&!stat.isSymbolicLink(),'MIGRATION_FILE','Only reviewed regular migration files can execute.');
  const sql=await fs.readFile(file,'utf8');
  const expected=runtimeMigrations.find(item=>item.id===id)?.checksum;
  demand(expected===checksum(sql),'MIGRATION_CHANGED','A pending reviewed migration changed: '+id,409);
  try{
   await lock.query('BEGIN');
   await lock.query(sql);
   await lock.query('INSERT INTO faultline.schema_migrations(id,checksum) VALUES($1,$2)',[id,expected]);
   await lock.query('COMMIT');
  }catch(error){await lock.query('ROLLBACK');throw error;}
 }
 const after=await readLedger(lock);
 demand(after.length===runtimeMigrations.length&&after.every((row,index)=>row.id===runtimeMigrations[index]?.id&&row.checksum===runtimeMigrations[index]?.checksum),'SCHEMA_UNSUPPORTED','Hosted migration ledger does not exactly match the current runtime.',503);
 await demandQueueCurrent(lock);
 const afterCounts=await readCounts(lock);
 demand(JSON.stringify(afterCounts)===JSON.stringify(beforeCounts),'MIGRATION_CHANGED','Tenant row counts changed during the reviewed schema-only upgrade.',409);
 const names=['agent_turns_workspace_id_case_id_revision_id_fkey','agent_turns_workspace_id_case_id_job_id_fkey','agent_actions_workspace_id_case_id_target_job_id_fkey'];
 const constraints=(await lock.query("SELECT conname,confdeltype,condeferrable FROM pg_constraint WHERE connamespace='faultline'::regnamespace AND conname=ANY($1::text[]) ORDER BY conname",[names])).rows;
 demand(constraints.length===3,'SCHEMA_UNSUPPORTED','Agent retention constraints are missing after migration.',503);
 const revision=constraints.find(row=>row.conname===names[0]);
 demand(revision?.confdeltype==='c','SCHEMA_UNSUPPORTED','Agent revision cleanup is not cascading.',503);
 demand(constraints.filter(row=>row.conname!==names[0]).every(row=>row.condeferrable===true),'SCHEMA_UNSUPPORTED','Agent job bindings are not deferrable.',503);
 const external=(await lock.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='faultline' AND table_name='browser_plans' AND column_name='external_binding') AS column_exists, EXISTS(SELECT 1 FROM pg_constraint WHERE connamespace='faultline'::regnamespace AND conname='external_browser_binding') AS constraint_exists")).rows[0];
 demand(external?.column_exists===true&&external?.constraint_exists===true,'SCHEMA_UNSUPPORTED','External browser plan bindings are missing after migration.',503);
 console.log(JSON.stringify({
  operation:'migrate_agent_first_hosted',status:'passed',before_migrations:beforeIds.length,
  pending,after_migrations:after.length,counts:afterCounts,
  external_browser_binding:true,
  constraints:constraints.map(row=>({name:row.conname,cascade:row.confdeltype==='c',deferrable:row.condeferrable===true}))
 }));
}finally{
 await lock.query("SELECT pg_advisory_unlock(hashtextextended('faultline.migrations',0))").catch(()=>undefined);
 lock.release();
 await authDatabase.end();
 await database.end();
}
