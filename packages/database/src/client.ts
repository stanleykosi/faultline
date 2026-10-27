import {identitySql} from "./identity-schema.js";
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {config} from '../../core/src/config.js';
import {DomainError,demand} from '../../core/src/errors.js';
import {runtimePoolSize,warmPool} from './warm-pool.js';
import {withVerificationScope} from '../../core/src/verification/scope.js';
const authTimestampParsers=new Map([1114,1184].map(oid=>[oid,pg.types.getTypeParser(oid,'text')]));
export const authDatabaseTypes:pg.CustomTypesConfig={getTypeParser(oid:number,format?:'text'|'binary'){return format==='binary'?pg.types.getTypeParser(oid,'binary'):authTimestampParsers.get(oid)??pg.types.getTypeParser(oid,'text');}};
pg.types.setTypeParser(1184,(value:string)=>value); // Event instants never hydrate through Date.
pg.types.setTypeParser(1114,(value:string)=>value);
const apiProcess=process.env.PROCESS_ROLE==='api';
const serverless=process.env.FAULTLINE_HOSTING_PROFILE==='vercel-supabase'&&apiProcess;
const domainSize=runtimePoolSize(process.env.DOMAIN_POOL_MAX,serverless?1:process.env.PROCESS_ROLE==='worker'?4:6),authSize=runtimePoolSize(process.env.AUTH_POOL_MAX,serverless?1:process.env.PROCESS_ROLE==='worker'?2:4);
const lifecycle=serverless?{idleTimeoutMillis:5000,allowExitOnIdle:true}:{};
export const pool=config.databaseUrl?new pg.Pool({connectionString:config.databaseUrl,max:domainSize,min:apiProcess&&!serverless?domainSize:0,connectionTimeoutMillis:3000,...lifecycle}):null;
export const authPool=config.authDatabaseUrl?new pg.Pool({connectionString:config.authDatabaseUrl,max:authSize,min:apiProcess&&!serverless?authSize:0,types:authDatabaseTypes,options:identitySql('-c search_path=auth'),connectionTimeoutMillis:3000,...lifecycle}):null;
for(const connection of [pool,authPool])connection?.on('error',()=>console.warn('Faultline database idle connection lost; subsequent requests require a fresh connection and authority check.'));
export async function closeRuntimePools(){await Promise.allSettled([pool?.end(),authPool?.end()]);}
export async function warmApiPools(){
 const results=await Promise.allSettled([pool?warmPool(pool,domainSize):Promise.resolve(),authPool?warmPool(authPool,authSize):Promise.resolve()]);
 demand(results.every(result=>result.status==='fulfilled'),'DEPENDENCY_UNAVAILABLE','Database startup pools unavailable.',503);
}
export const orm=pool?drizzle(pool):null;
export type Tx=pg.PoolClient;
export function requireDatabase(){if(!pool)throw new DomainError('DEPENDENCY_UNAVAILABLE','PostgreSQL is not configured.',503);return pool;}
export async function transaction<T>(workspaceId:string,fn:(tx:Tx)=>Promise<T>):Promise<T>{
 return withVerificationScope(async()=>{
 const tx=await requireDatabase().connect();
 try{await tx.query('BEGIN');await tx.query("SELECT set_config('faultline.workspace_id',$1,true)",[workspaceId]);const result=await fn(tx);await tx.query('COMMIT');return result;}
 catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 });
}
export async function verifyRuntimeRole(connection:Pick<pg.Pool,'query'>=requireDatabase()){
 const result=await connection.query("SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolinherit,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS has_memberships,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='faultline' AND c.relowner=r.oid) AS owns_tables FROM pg_roles r WHERE rolname=current_user");
 const row=result.rows[0];demand(row&&!row.rolsuper&&!row.rolbypassrls&&!row.rolcreatedb&&!row.rolcreaterole&&!row.rolinherit&&!row.has_memberships&&!row.owns_tables,'UNSAFE_DATABASE_ROLE','Runtime role must not bypass row security',503);
}


export async function verifyAuthRuntimeRole(){
 if(!authPool)throw new DomainError('DEPENDENCY_UNAVAILABLE','Authentication database unavailable.',503);
 const row=(await authPool.query(identitySql("SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolinherit,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS has_memberships,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relowner=r.oid) AS owns_tables,has_schema_privilege(current_user,'faultline','USAGE') AS tenant_access FROM pg_roles r WHERE rolname=current_user"))).rows[0];
 demand(row&&!row.rolsuper&&!row.rolbypassrls&&!row.rolcreatedb&&!row.rolcreaterole&&!row.rolinherit&&!row.has_memberships&&!row.owns_tables&&!row.tenant_access,'UNSAFE_DATABASE_ROLE','Authentication requires an isolated non-owner runtime role',503);
}

export async function verifyWorkerRole(connection:pg.Pool,kind:'queue'|'dispatcher'){
 const row=(await connection.query(identitySql("SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolinherit,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS has_memberships,r.rolcreaterole,r.rolcreatedb,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('auth','faultline','pgboss') AND c.relowner=r.oid) AS owns_tables,EXISTS(SELECT 1 FROM pg_roles powerful WHERE powerful.oid<>r.oid AND (powerful.rolsuper OR powerful.rolbypassrls OR powerful.rolcreaterole OR powerful.rolcreatedb OR EXISTS(SELECT 1 FROM pg_class owned JOIN pg_namespace space ON space.oid=owned.relnamespace WHERE space.nspname IN ('auth','faultline','pgboss') AND owned.relowner=powerful.oid)) AND pg_has_role(r.oid,powerful.oid,'MEMBER')) AS role_escalation,has_schema_privilege(current_user,'auth','USAGE') AS auth_access,has_schema_privilege(current_user,'faultline','USAGE') AS tenant_access,has_schema_privilege(current_user,'pgboss','USAGE') AS queue_access,EXISTS(SELECT 1 FROM pg_class restricted JOIN pg_namespace space ON space.oid=restricted.relnamespace WHERE space.nspname='faultline' AND restricted.relkind IN ('r','p') AND restricted.relname<>'job_outbox' AND (has_any_column_privilege(current_user,restricted.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege(current_user,restricted.oid,'DELETE,TRUNCATE,TRIGGER'))) AS cases_access,has_any_column_privilege(current_user,(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='faultline' AND c.relname='jobs'),'SELECT') AS job_input_access FROM pg_roles r WHERE rolname=current_user"))).rows[0];
 demand(row&&!row.rolsuper&&!row.rolbypassrls&&!row.rolcreaterole&&!row.rolcreatedb&&!row.rolinherit&&!row.has_memberships&&!row.owns_tables&&!row.role_escalation&&!row.auth_access&&(kind==='queue'?!row.tenant_access&&row.queue_access:row.tenant_access&&!row.queue_access&&!row.cases_access&&!row.job_input_access),'UNSAFE_DATABASE_ROLE','Worker pools require isolated non-owner roles with bounded grants',503);
}
