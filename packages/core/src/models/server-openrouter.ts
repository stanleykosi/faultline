import {createHmac} from 'node:crypto';
import type {Tx} from '../../../database/src/client.js';
import {hash} from '../canonical.js';
import {demand} from '../errors.js';
import {access,audit} from '../workspaces/service.js';
import {METERLESS_BASE_URL,normalizeMeterlessProfile,validMeterlessToken} from './meterless-profile.js';

export const SERVER_MODEL_ACTOR='system:openrouter-env-v1';
export const SERVER_METERLESS_ACTOR='system:meterless-env-v1';
export const SERVER_MODEL_ACTORS:readonly string[]=Object.freeze([SERVER_MODEL_ACTOR,SERVER_METERLESS_ACTOR]);
const base='https://openrouter.ai/api/v1',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Row=Record<string,any>;
/** Private runtime values only. Never put this object in a response or log. */
export function serverOpenRouter(env:NodeJS.ProcessEnv=process.env,workspaceId?:string){
 const token=env.OPENROUTER_API_KEY,model=env.OPENROUTER_MODEL,scope=env.OPENROUTER_WORKSPACE_ID?.trim()||workspaceId,secret=env.AUTH_SECRET;
 // Partial configuration keeps manual/workspace profiles available and makes no provider call.
 if(!token||!model||!scope||!secret||secret.length<32)return null;
 if(token.length>2000||/[\s\x00-\x1f\x7f]/.test(token)||model.length>200||/[\s\x00-\x1f\x7f]/.test(model)||!uuid.test(scope))return null;
 const workspace_id=scope.toLowerCase(),signature=createHmac('sha256',secret).update(JSON.stringify([workspace_id,model,token])).digest('hex');
 const profile_id=`${signature.slice(0,8)}-${signature.slice(8,12)}-5${signature.slice(13,16)}-a${signature.slice(17,20)}-${signature.slice(20,32)}`;
 return {workspace_id,profile_id,profile_hash:hash({provider:'openrouter',base_url:base,model_name:model,server_binding:signature}),provider:'openrouter' as const,base_url:base,model_name:model,token};
}
export function serverMeterless(env:NodeJS.ProcessEnv=process.env,workspaceId?:string){
 const token=env.METERLESS_RUNTIME_TOKEN,model=env.METERLESS_MODEL,scope=env.METERLESS_WORKSPACE_ID?.trim()||workspaceId,secret=env.AUTH_SECRET;
 if(!validMeterlessToken(token)||!model||model.length>200||!/^meterless\/[^\s\x00-\x1f\x7f]{1,190}$/.test(model)||!scope||!uuid.test(scope)||!secret||secret.length<32)return null;
 let normalized;try{normalized=normalizeMeterlessProfile(env.METERLESS_BASE_URL||METERLESS_BASE_URL,token);}catch{return null;}
 // Server URLs cannot embed credential fragments; use the dedicated secret variable.
 if((env.METERLESS_BASE_URL||'').includes('#'))return null;
 const workspace_id=scope.toLowerCase(),signature=createHmac('sha256',secret).update(JSON.stringify(['meterless',workspace_id,normalized.base_url,model,token])).digest('hex'),profile_id=`${signature.slice(0,8)}-${signature.slice(8,12)}-5${signature.slice(13,16)}-a${signature.slice(17,20)}-${signature.slice(20,32)}`;
 return {workspace_id,profile_id,profile_hash:hash({provider:'meterless',base_url:normalized.base_url,model_name:model,server_binding:signature}),provider:'meterless' as const,base_url:normalized.base_url,model_name:model,token};
}
function currentConfigs(wid:string){return [serverOpenRouter(process.env,wid),serverMeterless(process.env,wid)].filter(config=>config!==null&&config.workspace_id===wid.toLowerCase());}
export function isServerModel(row:Row){return SERVER_MODEL_ACTORS.includes(row.created_by);}
export function currentServerModelId(wid:string){const config=serverOpenRouter(process.env,wid);return config?.workspace_id===wid.toLowerCase()?config.profile_id:null;}
export function currentServerModelIds(wid:string):string[]{return currentConfigs(wid).map(config=>config!.profile_id);}
export function bindServerModel(row:Row,wid:string):Row{
 if(!isServerModel(row))return row;
 const config=row.created_by===SERVER_METERLESS_ACTOR?serverMeterless(process.env,wid):serverOpenRouter(process.env,wid);
 demand(config&&config.workspace_id===wid.toLowerCase()&&row.workspace_id===config.workspace_id&&row.id===config.profile_id&&row.profile_hash===config.profile_hash&&row.provider===config.provider&&row.base_url===config.base_url&&row.model_name===config.model_name&&!row.secret_id,'SERVER_MODEL_CHANGED','The hosted model configuration changed. Choose its current profile and test the connection again.',409);
 // No database secret version exists. The full immutable profile hash binds the env key.
 return {...row,active_version:null,secret_revoked:false,credential_source:'server'};
}
export function serverModelToken(row:Row,wid:string){if(!isServerModel(row))return undefined;bindServerModel(row,wid);return (row.created_by===SERVER_METERLESS_ACTOR?serverMeterless(process.env,wid):serverOpenRouter(process.env,wid))!.token;}
/** Owner-only, idempotent registration. Credentials stay in the process environment.
 * Immutable generations prevent an old deployment from overwriting a newer key/model.
 * Registration never probes or marks a provider available.
 */
export async function ensureServerModelTx(tx:Tx,wid:string,pid:string){
 const configs=currentConfigs(wid);if(!configs.length)return;
 if(await access(tx,wid,pid)!=='owner')return;
 for(const config of configs){if(!config)continue;
 const inserted=await tx.query('INSERT INTO faultline.model_profiles(id,workspace_id,name,provider,base_url,model_name,profile_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id',[config.profile_id,wid,config.provider==='meterless'?'Meterless Nightshift':'Hosted OpenRouter',config.provider,config.base_url,config.model_name,config.profile_hash,config.provider==='meterless'?SERVER_METERLESS_ACTOR:SERVER_MODEL_ACTOR]);
 if(inserted.rowCount)await audit(tx,wid,pid,'model.server.register',{profile_id:config.profile_id,provider:config.provider,model_name:config.model_name,credential_source:'server',capability_status:'not_run'});
 }
}
