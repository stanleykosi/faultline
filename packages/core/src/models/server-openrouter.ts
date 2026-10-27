import {createHmac} from 'node:crypto';
import type {Tx} from '../../../database/src/client.js';
import {hash} from '../canonical.js';
import {demand} from '../errors.js';
import {access,audit} from '../workspaces/service.js';

export const SERVER_MODEL_ACTOR='system:openrouter-env-v1';
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
export function isServerModel(row:Row){return row.created_by===SERVER_MODEL_ACTOR;}
export function currentServerModelId(wid:string){const config=serverOpenRouter(process.env,wid);return config?.workspace_id===wid.toLowerCase()?config.profile_id:null;}
export function bindServerModel(row:Row,wid:string):Row{
 if(!isServerModel(row))return row;
 const config=serverOpenRouter(process.env,wid);
 demand(config&&config.workspace_id===wid.toLowerCase()&&row.workspace_id===config.workspace_id&&row.id===config.profile_id&&row.profile_hash===config.profile_hash&&row.provider===config.provider&&row.base_url===config.base_url&&row.model_name===config.model_name&&!row.secret_id,'SERVER_MODEL_CHANGED','The hosted model configuration changed. Choose its current profile and test the connection again.',409);
 // No database secret version exists. The full immutable profile hash binds the env key.
 return {...row,active_version:null,secret_revoked:false,credential_source:'server'};
}
export function serverModelToken(row:Row,wid:string){if(!isServerModel(row))return undefined;bindServerModel(row,wid);return serverOpenRouter(process.env,wid)!.token;}
/** Owner-only, idempotent registration. Credentials stay in the process environment.
 * Immutable generations prevent an old deployment from overwriting a newer key/model.
 * Registration never probes or marks a provider available.
 */
export async function ensureServerModelTx(tx:Tx,wid:string,pid:string){
 const config=serverOpenRouter(process.env,wid);if(!config||config.workspace_id!==wid.toLowerCase())return;
 if(await access(tx,wid,pid)!=='owner')return;
 const inserted=await tx.query('INSERT INTO faultline.model_profiles(id,workspace_id,name,provider,base_url,model_name,profile_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id',[config.profile_id,wid,'Hosted OpenRouter',config.provider,config.base_url,config.model_name,config.profile_hash,SERVER_MODEL_ACTOR]);
 if(inserted.rowCount)await audit(tx,wid,pid,'model.server.register',{profile_id:config.profile_id,provider:config.provider,model_name:config.model_name,credential_source:'server',capability_status:'not_run'});
}
