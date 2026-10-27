import fs from 'node:fs/promises';
import pg from 'pg';
import {validateOperatorRegistration} from '../../../packages/core/src/targets/operator-profile.js';
import {rejectDuplicateJsonKeys} from '../../../packages/core/src/imports/duplicate-json-keys.js';
import {hash} from '../../../packages/core/src/canonical.js';
import {demand} from '../../../packages/core/src/errors.js';
import {localOperatorUrl,regularBytes,writeReport} from '../backup.js';
const args=process.argv.slice(2);demand((args.length===1||args.length===2&&args[1]==='--required-kind=attester')&&args[0]!.startsWith('--profile-file='),'OPERATOR_INPUT_REQUIRED','Pass one reviewed --profile-file=<path>.');
const bytes=await regularBytes(args[0]!.slice('--profile-file='.length),131072);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{demand(false,'INVALID_OPERATOR_PROFILE','Operator profile must be strict UTF8.');}
rejectDuplicateJsonKeys(text!,12);const input=validateOperatorRegistration(JSON.parse(text!));if(args.length===2)demand(input.kind==='attester','INVALID_OPERATOR_PROFILE','The attester entry point accepts only current public-key registrations.');const contentHash=hash(input),pool=new pg.Pool({connectionString:localOperatorUrl().toString(),max:1,options:'-c statement_timeout=5000'}),client=await pool.connect();
try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.workspace_id+':operator-staging:'+input.kind+':'+input.id]);
 demand((await client.query('SELECT id FROM faultline.workspaces WHERE id=$1 AND deletion_requested_at IS NULL FOR UPDATE',[input.workspace_id])).rowCount,'WORKSPACE_UNAVAILABLE','Register an existing active exact workspace.',404);
 const dependency=input.kind==='runner'?{kind:'network',id:input.profile.network_profile_id}:input.kind==='environment'?{kind:'runner',id:input.profile.runner_id}:null;
 if(dependency)demand((await client.query('SELECT id FROM faultline.staging_catalog WHERE workspace_id=$1 AND kind=$2 AND id=$3 AND registered_by_operator AND NOT revoked',[input.workspace_id,dependency.kind,dependency.id])).rowCount,'OPERATOR_DEPENDENCY_REQUIRED','Register the exact same-workspace operator dependency first.',409);
 if(input.kind==='attester')for(const scope of input.profile.deployment_scopes as {environment_id:string}[])demand((await client.query("SELECT id FROM faultline.staging_catalog WHERE workspace_id=$1 AND kind='environment' AND id=$2 AND registered_by_operator AND NOT revoked",[input.workspace_id,scope.environment_id])).rowCount,'OPERATOR_DEPENDENCY_REQUIRED','Register each exact scoped deployment environment first.',409);
 const prior=(await client.query('SELECT content_hash,revoked FROM faultline.staging_catalog WHERE workspace_id=$1 AND kind=$2 AND id=$3',[input.workspace_id,input.kind,input.id])).rows[0];
 demand(!prior||(prior.content_hash===contentHash&&!prior.revoked),'IMMUTABLE_OPERATOR_PROFILE','Use a new ID for changed or revoked operator registrations.',409);
 if(!prior){demand((await client.query('SELECT count(*)::int AS count FROM faultline.staging_catalog WHERE workspace_id=$1 AND kind=$2',[input.workspace_id,input.kind])).rows[0].count<100,'STAGING_CATALOG_LIMIT','Register at most100 immutable resources per finite operator catalog.',409);await client.query('INSERT INTO faultline.staging_catalog(id,workspace_id,kind,value,content_hash,registered_by_operator,created_by) VALUES($1,$2,$3,$4,$5,true,$6)',[input.id,input.workspace_id,input.kind,input,contentHash,'operator_cli']);}
 await client.query('COMMIT');
 const report=await writeReport('register-staging-profile',{status:'registered_not_verified',workspace_id:input.workspace_id,kind:input.kind,id:input.id,content_hash:contentHash,replayed:Boolean(prior),network_calls:0,isolation_verification:'not_run',deployment_observation:'not_run',scope:'Operator-reviewed immutable scoped metadata only; registration grants no target execution or passing capability.'});console.log('Registered scoped operator metadata; evidence '+report);
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
