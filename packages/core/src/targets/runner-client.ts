import https from 'node:https';
import dns from 'node:dns/promises';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {TLSSocket} from 'node:tls';
import {canonical,newId} from '../canonical.js';
import {DomainError,demand} from '../errors.js';
import {publicAddress} from '../network/http.js';
import {rejectDuplicateJsonKeys} from '../imports/duplicate-json-keys.js';

const PROBE_ROUTE='/v1/probe',TASK_ROUTE='/v1/tasks/execute',STATUS_ROUTE='/v1/tasks/status',CANCEL_ROUTE='/v1/tasks/cancel',DIGEST=/^[a-f0-9]{64}$/,MAX_BYTES=1024*1024;
const sha256=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const exact=(value:unknown,keys:string[])=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const identifier=(value:unknown,maximum=200)=>typeof value==='string'&&value.length>0&&value.length<=maximum&&!/[\u0000-\u001f\u007f]/.test(value);

export interface ExternalRunnerProfile {endpoint:string;implementation_digest:string;transport_ca_sha256:string;peer_certificate_sha256:string}
export interface RunnerProbeBinding {profile_hash:string;network_hash:string}
export interface RunnerExecutionBinding {
 adapter_id:string;adapter_version:string;provider_id:string;provider_version:string;
 provider_configuration_hash:string;isolation_configuration_hash:string;execution_program_sha256:string;
}
export interface RunnerTaskReceipt<T=unknown> {
 version:1;status:'completed';adapter_id:string;adapter_version:string;provider_id:string;provider_version:string;provider_configuration_hash:string;
 implementation_digest:string;isolation_configuration_hash:string;execution_id:string;task_sha256:string;program_sha256:string;result_sha256:string;
 /** Authenticated transport output only. The caller must apply the domain result contract before admission. */
 result:T;
}
export interface RunnerExecutionCommand {execution_key:string;task_sha256:string}
export interface RunnerTaskStateReceipt {
 version:1;status:'reserved'|'running'|'cancel_requested'|'containment_unknown'|'cancelled';adapter_id:string;adapter_version:string;provider_id:string;provider_version:string;provider_configuration_hash:string;
 implementation_digest:string;isolation_configuration_hash:string;execution_key:string;task_sha256:string;updated_at:string;
}
export type RunnerTaskStatusReceipt<T=unknown> = RunnerTaskReceipt<T>|RunnerTaskStateReceipt;
export interface RunnerCapabilityReceipt {
 version:1;status:'available';checked_at:string;adapter_id:string;adapter_version:string;provider_id:string;provider_version:string;provider_configuration_hash:string;
 implementation_digest:string;isolation_configuration_hash:string;capability_program_sha256:string;execution_program_sha256:string;network_calls:2;
 cleanup_verification:boolean;crash_reconciliation:boolean;
 runs:Array<{execution_id:string;result_sha256:string;evidence:Record<string,unknown>}>;
}
interface TransportInput {url:URL;body:string;signal:AbortSignal;profile:ExternalRunnerProfile;timeoutMs:number}
interface TransportResult {status:number;body:string;leafSha256:string;rootSha256:string}
export interface RunnerClientDependencies {transport?:(input:TransportInput)=>Promise<TransportResult>;now?:()=>number;nonce?:()=>string;environment?:Readonly<Record<string,string|undefined>>}

function key(environment:Readonly<Record<string,string|undefined>>):Buffer{
 const value=environment.EXTERNAL_RUNNER_AUTH_KEY_B64;demand(typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value),'RUNNER_AUTH_KEY_UNAVAILABLE','Runner authentication is not configured.',503);
 const bytes=Buffer.from(value,'base64');demand(bytes.length===32&&bytes.toString('base64')===value,'RUNNER_AUTH_KEY_UNAVAILABLE','Runner authentication is not configured.',503);return bytes;
}
function sign(value:unknown,secret:Buffer){return createHmac('sha256',secret).update(canonical(value)).digest('hex');}
function signed(value:unknown,candidate:unknown,secret:Buffer){return typeof candidate==='string'&&DIGEST.test(candidate)&&timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(sign(value,secret),'hex'));}
function fresh(value:unknown,nowMs:number){const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)&&parsed>=nowMs-60_000&&parsed<=nowMs+60_000;}

function certificateHashes(socket:TLSSocket):{leafSha256:string;rootSha256:string}{
 const leaf=socket.getPeerCertificate(true);demand(leaf?.raw instanceof Buffer,'RUNNER_TLS_IDENTITY_MISSING','Runner TLS peer identity is unavailable.',503);
 let root=leaf,current=leaf;const seen=new Set<string>();
 while(current?.raw instanceof Buffer){const digest=sha256(current.raw);if(seen.has(digest))break;seen.add(digest);root=current;const issuer=current.issuerCertificate;if(!issuer?.raw||sha256(issuer.raw)===digest)break;current=issuer;}
 return {leafSha256:sha256(leaf.raw),rootSha256:sha256(root.raw)};
}

async function httpsTransport(input:TransportInput):Promise<TransportResult>{
 const answers=await dns.lookup(input.url.hostname,{all:true,verbatim:true});demand(answers.length>0&&answers.length<=16&&answers.every(item=>publicAddress(item.address)),'SSRF_DENIED','Runner DNS resolved outside permitted public networks.',403);const selected=answers[0]!;
 return new Promise((resolve,reject)=>{
  const request=https.request(input.url,{method:'POST',signal:input.signal,timeout:input.timeoutMs,headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(input.body))},lookup:(_host,_options,callback)=>callback(null,selected.address,selected.family)},response=>{
   const socket=response.socket as TLSSocket;let identities:{leafSha256:string;rootSha256:string};try{identities=certificateHashes(socket);demand(identities.leafSha256===input.profile.peer_certificate_sha256&&identities.rootSha256===input.profile.transport_ca_sha256,'RUNNER_TLS_IDENTITY_MISMATCH','Runner TLS identity does not match the registered profile.',503);}catch(error){response.destroy();reject(error);return;}
   const chunks:Buffer[]=[];let size=0,failed=false;const declared=Number(response.headers['content-length']??0);if(declared>MAX_BYTES){response.destroy();reject(new DomainError('RUNNER_RESPONSE_TOO_LARGE','Runner response exceeds its finite bound.',503));return;}
   response.on('data',(chunk:Buffer)=>{if(failed)return;size+=chunk.length;if(size>MAX_BYTES){failed=true;response.destroy();reject(new DomainError('RUNNER_RESPONSE_TOO_LARGE','Runner response exceeds its finite bound.',503));}else chunks.push(chunk);});
   response.on('error',reject);response.on('end',()=>{if(!failed)resolve({status:response.statusCode??502,body:Buffer.concat(chunks).toString('utf8'),...identities});});
  });
  request.on('timeout',()=>request.destroy(new DomainError('RUNNER_TIMEOUT','Runner request exceeded its finite deadline.',504)));request.on('error',reject);request.end(input.body);
 });
}

function validateProfile(profile:ExternalRunnerProfile,environment:Readonly<Record<string,string|undefined>>):URL{
 demand(environment.RUNNER_MODE==='external'&&environment.EXTERNAL_RUNNER_URL===profile.endpoint,'RUNNER_ENDPOINT_UNAVAILABLE','The registered runner endpoint is not the configured external runner.',503);
 const base=new URL(profile.endpoint);demand(base.origin===profile.endpoint&&base.protocol==='https:'&&!base.username&&!base.password&&!base.port,'RUNNER_ENDPOINT_UNAVAILABLE','Runner endpoint must be one exact public HTTPS origin.',503);
 demand([profile.implementation_digest,profile.transport_ca_sha256,profile.peer_certificate_sha256].every(value=>DIGEST.test(value)),'RUNNER_PROFILE_INVALID','Runner profile hashes are invalid.',503);return base;
}

async function requestPayload(profile:ExternalRunnerProfile,path:string,payload:unknown,signal:AbortSignal,dependencies:RunnerClientDependencies,timeoutMs=180_000):Promise<{payload:unknown;nowMs:number}>{
 const environment=dependencies.environment??process.env,secret=key(environment),clock=dependencies.now??Date.now,nowMs=clock(),base=validateProfile(profile,environment),nonce=(dependencies.nonce??newId)();
 demand(identifier(nonce,128),'RUNNER_AUTHENTICATION_FAILED','Runner request nonce is invalid.',503);
 const expires_at=new Date(nowMs+30_000).toISOString(),unsigned={method:'POST',path,version:1,nonce,expires_at,payload},requestBody=JSON.stringify({version:1,nonce,expires_at,payload,signature:sign(unsigned,secret)});
 demand(Buffer.byteLength(requestBody)<=MAX_BYTES,'RUNNER_REQUEST_TOO_LARGE','Runner request exceeds its finite bound.',413);
 const response=await (dependencies.transport??httpsTransport)({url:new URL(path,base),body:requestBody,signal,profile,timeoutMs}),receivedAtMs=clock();
 demand(response.leafSha256===profile.peer_certificate_sha256&&response.rootSha256===profile.transport_ca_sha256,'RUNNER_TLS_IDENTITY_MISMATCH','Runner TLS identity does not match the registered profile.',503);
 demand(Buffer.byteLength(response.body)<=MAX_BYTES,'RUNNER_RESPONSE_TOO_LARGE','Runner response exceeds its finite bound.',503);rejectDuplicateJsonKeys(response.body,16);
 let value:unknown;try{value=JSON.parse(response.body);}catch{throw new DomainError('RUNNER_RESPONSE_INVALID','Runner response is not valid JSON.',503);}
 demand(exact(value,['version','nonce','at','ok','payload','error_code','signature']),'RUNNER_RESPONSE_INVALID','Runner response has unexpected fields.',503);const envelope=value as any,body={version:envelope.version,nonce:envelope.nonce,at:envelope.at,ok:envelope.ok,payload:envelope.payload,error_code:envelope.error_code};
 demand(response.status===200&&envelope.version===1&&envelope.nonce===nonce&&envelope.ok===true&&envelope.error_code===null&&fresh(envelope.at,receivedAtMs)&&signed(body,envelope.signature,secret),'RUNNER_AUTHENTICATION_FAILED','Runner response authentication or freshness failed.',503);return {payload:envelope.payload,nowMs:receivedAtMs};
}

function validEvidence(value:any):boolean{
 return value!==null&&typeof value==='object'&&!Array.isArray(value)&&value.kind==='hardened_isolation_probe'&&
  value.private_network_denied===true&&value.firewall_default_deny===true&&value.approved_https===true&&value.unrelated_public_denied===true&&
  value.loopback_denied===true&&value.metadata_denied===true&&value.private_address_denied===true&&value.privilege_dropped===true&&
  value.before!==null&&typeof value.before==='object'&&!Array.isArray(value.before)&&value.before.docker_socket_present===false&&
  value.before.control_plane_credential_present===false&&identifier(value.before.boot_id,200)&&identifier(value.before.network_ns,200);
}

function validateAvailablePayload(value:unknown,profile:ExternalRunnerProfile,nowMs:number):RunnerCapabilityReceipt{
 demand(exact(value,['version','status','checked_at','adapter_id','adapter_version','provider_id','provider_version','provider_configuration_hash','implementation_digest','isolation_configuration_hash','capability_program_sha256','execution_program_sha256','cleanup_verification','crash_reconciliation','network_calls','runs']),'RUNNER_RESPONSE_INVALID','Runner capability payload has unexpected fields.',503);const payload=value as any;
 demand(payload.version===1&&payload.status==='available'&&fresh(payload.checked_at,nowMs)&&payload.implementation_digest===profile.implementation_digest&&identifier(payload.adapter_id)&&identifier(payload.adapter_version)&&identifier(payload.provider_id)&&identifier(payload.provider_version)&&DIGEST.test(payload.provider_configuration_hash)&&DIGEST.test(payload.isolation_configuration_hash)&&DIGEST.test(payload.capability_program_sha256)&&DIGEST.test(payload.execution_program_sha256)&&typeof payload.cleanup_verification==='boolean'&&typeof payload.crash_reconciliation==='boolean'&&payload.network_calls===2&&Array.isArray(payload.runs)&&payload.runs.length===2,'RUNNER_CAPABILITY_FAILED','Runner capability payload did not prove the registered implementation.',503);
 for(const run of payload.runs)demand(exact(run,['execution_id','result_sha256','evidence'])&&identifier(run.execution_id)&&DIGEST.test(run.result_sha256)&&validEvidence(run.evidence)&&run.result_sha256===sha256(Buffer.from(canonical(run.evidence),'utf8')),'RUNNER_CAPABILITY_FAILED','Runner isolation evidence is incomplete.',503);
 demand(payload.runs[0].execution_id!==payload.runs[1].execution_id&&payload.runs[0].evidence.before.boot_id!==payload.runs[1].evidence.before.boot_id&&payload.runs[0].evidence.before.network_ns!==payload.runs[1].evidence.before.network_ns,'RUNNER_ISOLATION_NOT_DISTINCT','Runner capability evidence is not independent.',503);return payload;
}

export async function requestRunnerProbe(profile:ExternalRunnerProfile,binding:RunnerProbeBinding,signal:AbortSignal,dependencies:RunnerClientDependencies={}):Promise<RunnerCapabilityReceipt>{
 demand([binding.profile_hash,binding.network_hash].every(value=>DIGEST.test(value)),'RUNNER_PROFILE_INVALID','Runner profile hashes are invalid.',503);
 const response=await requestPayload(profile,PROBE_ROUTE,{profile_hash:binding.profile_hash,network_hash:binding.network_hash,implementation_digest:profile.implementation_digest},signal,dependencies);
 return validateAvailablePayload(response.payload,profile,response.nowMs);
}

export async function requestRunnerTask<T=unknown>(profile:ExternalRunnerProfile,task:unknown,binding:RunnerExecutionBinding,signal:AbortSignal,dependencies:RunnerClientDependencies={}):Promise<RunnerTaskReceipt<T>>{
 demand(identifier(binding.adapter_id)&&identifier(binding.adapter_version)&&identifier(binding.provider_id)&&identifier(binding.provider_version)&&DIGEST.test(binding.provider_configuration_hash)&&DIGEST.test(binding.isolation_configuration_hash)&&DIGEST.test(binding.execution_program_sha256),'RUNNER_PROFILE_INVALID','Runner execution binding is invalid.',503);
 const taskJson=canonical(task),task_sha256=sha256(Buffer.from(taskJson,'utf8')),stableTask=JSON.parse(taskJson) as unknown;
 const response=await requestPayload(profile,TASK_ROUTE,{implementation_digest:profile.implementation_digest,isolation_configuration_hash:binding.isolation_configuration_hash,task:stableTask,task_sha256},signal,dependencies,660_000),value=response.payload;
 return validateCompleted<T>(value,profile,binding,task_sha256);
}

function validateCompleted<T>(value:unknown,profile:ExternalRunnerProfile,binding:RunnerExecutionBinding,taskSha256:string):RunnerTaskReceipt<T>{
 demand(exact(value,['version','status','adapter_id','adapter_version','provider_id','provider_version','provider_configuration_hash','implementation_digest','isolation_configuration_hash','execution_id','task_sha256','program_sha256','result_sha256','result']),'RUNNER_RESPONSE_INVALID','Runner task payload has unexpected fields.',503);const receipt=value as any;
 demand(receipt.version===1&&receipt.status==='completed'&&receipt.adapter_id===binding.adapter_id&&receipt.adapter_version===binding.adapter_version&&receipt.provider_id===binding.provider_id&&receipt.provider_version===binding.provider_version&&receipt.provider_configuration_hash===binding.provider_configuration_hash&&receipt.implementation_digest===profile.implementation_digest&&receipt.isolation_configuration_hash===binding.isolation_configuration_hash&&identifier(receipt.execution_id)&&receipt.task_sha256===taskSha256&&receipt.program_sha256===binding.execution_program_sha256&&DIGEST.test(receipt.result_sha256),'RUNNER_TASK_FAILED','Runner task response did not bind the requested task, capability and implementation.',503);
 demand(receipt.result_sha256===sha256(Buffer.from(canonical(receipt.result),'utf8')),'RUNNER_TASK_FAILED','Runner task result digest does not match its result.',503);return receipt as RunnerTaskReceipt<T>;
}

async function requestRunnerCommand<T>(route:string,profile:ExternalRunnerProfile,command:RunnerExecutionCommand,binding:RunnerExecutionBinding,signal:AbortSignal,dependencies:RunnerClientDependencies):Promise<RunnerTaskStatusReceipt<T>>{
 demand(identifier(binding.adapter_id)&&identifier(binding.adapter_version)&&identifier(binding.provider_id)&&identifier(binding.provider_version)&&DIGEST.test(binding.provider_configuration_hash)&&DIGEST.test(binding.isolation_configuration_hash)&&DIGEST.test(binding.execution_program_sha256),'RUNNER_PROFILE_INVALID','Runner execution binding is invalid.',503);
 demand(identifier(command.execution_key,128)&&DIGEST.test(command.task_sha256),'RUNNER_PROFILE_INVALID','Runner execution command is invalid.',503);
 const response=await requestPayload(profile,route,{implementation_digest:profile.implementation_digest,isolation_configuration_hash:binding.isolation_configuration_hash,execution_key:command.execution_key,task_sha256:command.task_sha256},signal,dependencies,30_000),value=response.payload;
 if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&(value as any).status==='completed')return validateCompleted<T>(value,profile,binding,command.task_sha256);
 demand(exact(value,['version','status','adapter_id','adapter_version','provider_id','provider_version','provider_configuration_hash','implementation_digest','isolation_configuration_hash','execution_key','task_sha256','updated_at']),'RUNNER_RESPONSE_INVALID','Runner status payload has unexpected fields.',503);const receipt=value as any;
 const updatedAt=typeof receipt.updated_at==='string'?Date.parse(receipt.updated_at):NaN;
 demand(receipt.version===1&&['reserved','running','cancel_requested','containment_unknown','cancelled'].includes(receipt.status)&&receipt.adapter_id===binding.adapter_id&&receipt.adapter_version===binding.adapter_version&&receipt.provider_id===binding.provider_id&&receipt.provider_version===binding.provider_version&&receipt.provider_configuration_hash===binding.provider_configuration_hash&&receipt.implementation_digest===profile.implementation_digest&&receipt.isolation_configuration_hash===binding.isolation_configuration_hash&&receipt.execution_key===command.execution_key&&receipt.task_sha256===command.task_sha256&&Number.isFinite(updatedAt)&&updatedAt<=response.nowMs+60_000,'RUNNER_TASK_FAILED','Runner status did not bind the requested task, capability and implementation.',503);
 return receipt as RunnerTaskStateReceipt;
}

export function requestRunnerTaskStatus<T=unknown>(profile:ExternalRunnerProfile,command:RunnerExecutionCommand,binding:RunnerExecutionBinding,signal:AbortSignal,dependencies:RunnerClientDependencies={}):Promise<RunnerTaskStatusReceipt<T>>{
 return requestRunnerCommand<T>(STATUS_ROUTE,profile,command,binding,signal,dependencies);
}

export function cancelRunnerTask<T=unknown>(profile:ExternalRunnerProfile,command:RunnerExecutionCommand,binding:RunnerExecutionBinding,signal:AbortSignal,dependencies:RunnerClientDependencies={}):Promise<RunnerTaskStatusReceipt<T>>{
 return requestRunnerCommand<T>(CANCEL_ROUTE,profile,command,binding,signal,dependencies);
}
