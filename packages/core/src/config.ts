import path from 'node:path';
import {demand} from './errors.js';
import {parsePgBossInstanceName} from './pg-boss-instance.js';
import {parseApiBind} from './api-bind.js';
const origin=process.env.APP_ORIGIN??'http://localhost:3000';
const production=process.env.NODE_ENV==='production';
const pgBossInstanceName=parsePgBossInstanceName(process.env.PG_BOSS_INSTANCE_NAME);
const apiBind=parseApiBind({API_BIND_HOST:process.env.API_BIND_HOST,PORT:process.env.PORT});
demand(new URL(origin).origin===origin,'CONFIGURATION','APP_ORIGIN must be an exact origin');
if(production){demand(origin.startsWith('https://'),'CONFIGURATION','Production origin must use HTTPS');demand(process.env.AUTH_SECRET&&process.env.AUTH_SECRET.length>=32,'CONFIGURATION','Configure AUTH_SECRET');demand(process.env.DATABASE_URL&&process.env.AUTH_DATABASE_URL&&process.env.QUEUE_DATABASE_URL&&process.env.DISPATCHER_DATABASE_URL,'CONFIGURATION','Configure distinct restricted runtime database pools');demand(process.env.ALLOW_FIXTURE_ADAPTERS!=='true','CONFIGURATION','Fixtures forbidden in production');}
if(production&&process.env.FAULTLINE_HOSTING_PROFILE==='vercel-supabase'){
 demand(process.env.AUTH_DATABASE_SCHEMA==='faultline_identity'&&process.env.OBJECT_STORE==='supabase','CONFIGURATION','Vercel requires the isolated Supabase hosting profile.');
 for(const [name,role] of [['DATABASE_URL','faultline_api'],['AUTH_DATABASE_URL','faultline_auth'],['QUEUE_DATABASE_URL','faultline_queue'],['DISPATCHER_DATABASE_URL','faultline_dispatcher']] as const){
  const value=new URL(process.env[name]!);
  demand(['postgres:','postgresql:'].includes(value.protocol)&&value.port!=='6543'&&value.searchParams.get('sslmode')==='verify-full'&&(decodeURIComponent(value.username)===role||decodeURIComponent(value.username).startsWith(role+'.')),'CONFIGURATION','Use verified-TLS Supabase session/direct connections and restricted runtime roles.');
 }
}
export const config={origin,production,port:apiBind.port,apiBindHost:apiBind.host,databaseUrl:process.env.DATABASE_URL,authDatabaseUrl:process.env.AUTH_DATABASE_URL,queueDatabaseUrl:process.env.QUEUE_DATABASE_URL,pgBossInstanceName,authSecret:process.env.AUTH_SECRET??'development-only-unconfigured-secret-do-not-deploy',objectPath:path.resolve(process.env.OBJECT_STORE_PATH??'.runtime/objects'),modelProvider:process.env.MODEL_PROVIDER??'none',runnerMode:process.env.RUNNER_MODE??'disabled',publicSignupEnabled:process.env.PUBLIC_SIGNUP_ENABLED==='true'};
demand(['filesystem','supabase'].includes(process.env.OBJECT_STORE??'filesystem'),'CONFIGURATION','Use a reviewed object store.');

