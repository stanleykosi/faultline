import {transaction,type Tx} from '../../../database/src/client.js';
import type {FaultlineConnectorCapabilities} from '../../../contracts/src/generated.js';
import {validateContract} from '../../../contracts/src/validate.js';
import {command,access,audit,expected} from '../workspaces/service.js';
import {newId,hash} from '../canonical.js';
import {demand,DomainError} from '../errors.js';
import {checkActive,type ExecutionControl} from '../connectors/wire.js';
import {sourceReplacementResourceTx,probeSourceCredential,activateSourceCredentialTx} from '../integrations/service.js';
import {modelReplacementResourceTx,probeModelCredential,activateModelCredentialTx} from '../models/service.js';
import {loadKeyring,seal,open} from './keyring.js';

type Row=Record<string,any>;
export interface ReplacementProbeObservation {capabilities:FaultlineConnectorCapabilities;repository_id:number|null;}
const probeDeadlineMs=60_000,reviewLifetimeMs=10*60_000;

async function secretTx(tx:Tx,wid:string,id:string,lock=false):Promise<Row> {
 const row=(await tx.query('SELECT id,purpose,active_version,revision,revoked FROM faultline.secrets WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[wid,id])).rows[0];
 demand(row,'NOT_FOUND','Credential unavailable.',404);return row;
}
async function replacementTx(tx:Tx,wid:string,sid:string,id:string,lock=false):Promise<Row> {
 const row=(await tx.query('SELECT * FROM faultline.secret_replacements WHERE workspace_id=$1 AND secret_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[wid,sid,id])).rows[0];
 demand(row,'NOT_FOUND','Credential replacement unavailable.',404);return row;
}
async function resourceTx(tx:Tx,wid:string,secret:Row) {
 const match=/^(source|model):([a-f0-9-]{36})$/i.exec(secret.purpose);
 demand(match,'REPLACEMENT_UNSUPPORTED','Only a registered source or model credential can be replaced.',409);
 const kind=match[1] as 'source'|'model',id=match[2]!;
 const resource=kind==='source'?await sourceReplacementResourceTx(tx,wid,id):await modelReplacementResourceTx(tx,wid,id);
 demand(resource.row.secret_id===secret.id,'STALE_CREDENTIAL_SCOPE','The resource no longer uses this credential.',409);
 return {...resource,kind,id};
}
/** Pure guard shared by probe fencing and activation. No caller-supplied success flag is accepted. */
export function assertReplacementCurrent(row:Row,secret:Row,currentBinding:object) {
 demand(!secret.revoked,'SECRET_UNAVAILABLE','Credential was revoked; replacement cannot reactivate it.',409);
 demand(secret.revision===row.base_secret_revision,'STALE_SECRET_REPLACEMENT','The active credential changed after staging.',409);
 demand(row.resource_binding_hash===hash(row.resource_binding)&&hash(currentBinding)===row.resource_binding_hash,'STALE_SECRET_REPLACEMENT','The exact provider configuration, revision or declaration changed; stage a new replacement.',409);
}
export function replacementProbeBinding(row:Row,observation:ReplacementProbeObservation) {
 return hash({replacement_id:row.id,secret_id:row.secret_id,version:row.version,base_secret_revision:row.base_secret_revision,resource_binding_hash:row.resource_binding_hash,observation});
}
export function assertReplacementActivation(row:Row,secret:Row,currentBinding:object,acknowledgedHash:string,clock=Date.now()) {
 assertReplacementCurrent(row,secret,currentBinding);
 const observation=row.capabilities as ReplacementProbeObservation|null;
 demand(row.status==='probed'&&observation?.capabilities.status==='available'&&Date.parse(row.probe_expires_at)>clock,'REPLACEMENT_PROBE_REQUIRED','A current successful candidate probe is required before activation.',409);
 validateContract('connector-capabilities',observation.capabilities);
 demand(row.probe_binding_hash===replacementProbeBinding(row,observation)&&acknowledgedHash===row.probe_binding_hash,'REPLACEMENT_REVIEW_REQUIRED','Review and acknowledge this exact successful replacement probe binding.',409);
}
export function replacementMetadata(row:Row,secret:Row) {
 return {id:row.id,secret_id:row.secret_id,version:row.version,base_secret_revision:row.base_secret_revision,status:row.status,revision:row.revision,resource_kind:row.resource_kind,resource_id:row.resource_id,resource_revision:row.resource_revision,resource_binding:row.resource_binding,resource_binding_hash:row.resource_binding_hash,probe_binding_hash:row.probe_binding_hash??null,probe_expires_at:row.probe_expires_at??null,capabilities:row.capabilities?.capabilities??null,observed_repository_id:row.capabilities?.repository_id??null,active_version:secret.active_version,secret_revision:secret.revision,revoked:secret.revoked,hint:'•••• stored',activated_at:row.activated_at??null,created_at:row.created_at};
}
export async function stageSecretReplacement(wid:string,pid:string,key:string,secretId:string,value:string,match:string) {
 demand(typeof value==='string'&&value.length>0&&value.length<=2000&&!/[\s\x00-\x1f\x7f]/.test(value),'INVALID_CREDENTIAL','Provide a finite credential without invalid header bytes.');
 return command(wid,pid,'secret.replacement.stage',key,{secretId,value,match},async tx=>{
  const secret=await secretTx(tx,wid,secretId,true);expected(match,secret.revision);demand(!secret.revoked,'SECRET_UNAVAILABLE','A revoked credential cannot stage a replacement.',409);
  const resource=await resourceTx(tx,wid,secret),version=Number((await tx.query('SELECT COALESCE(max(version),0)+1 AS version FROM faultline.secret_versions WHERE workspace_id=$1 AND secret_id=$2',[wid,secretId])).rows[0].version),id=newId(),ring=await loadKeyring();
  const ciphertext=seal(value,`${wid}:${secretId}:${version}`,ring);
  await tx.query('INSERT INTO faultline.secret_versions(id,workspace_id,secret_id,version,key_version,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',[newId(),wid,secretId,version,ring.active,ciphertext]);
  await tx.query('INSERT INTO faultline.secret_replacements(id,workspace_id,secret_id,version,base_secret_revision,resource_kind,resource_id,resource_revision,resource_binding_hash,resource_binding,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,wid,secretId,version,secret.revision,resource.kind,resource.id,resource.row.revision,hash(resource.binding),resource.binding,pid]);
  await audit(tx,wid,pid,'secret.replacement.stage',{secret_id:secretId,replacement_id:id,version,resource_binding_hash:hash(resource.binding)});
  return replacementMetadata(await replacementTx(tx,wid,secretId,id),secret);
 },['owner']);
}
export async function getSecretReplacement(wid:string,pid:string,secretId:string,replacementId:string) {
 return transaction(wid,async tx=>{await access(tx,wid,pid,['owner']);return replacementMetadata(await replacementTx(tx,wid,secretId,replacementId),await secretTx(tx,wid,secretId));});
}
async function activeProbeTx(tx:Tx,wid:string,pid:string,sid:string,id:string,nonce:string) {
 await access(tx,wid,pid,['owner']);const secret=await secretTx(tx,wid,sid),row=await replacementTx(tx,wid,sid,id);
 demand(row.status==='probing'&&row.probe_nonce===nonce&&Date.parse(row.probe_expires_at)>Date.now(),'FENCED_REPLACEMENT_PROBE','Replacement probe lost its finite attempt authority.',409);
 const resource=await resourceTx(tx,wid,secret);assertReplacementCurrent(row,secret,resource.binding);return {secret,row,resource};
}
/** Tests may inject observations here; production calls always use the genuine registered adapter. */
export async function observeReplacementProbe(run:()=>Promise<ReplacementProbeObservation>,control:ExecutionControl) {
 await checkActive(control);const result=await run();await checkActive(control);
 validateContract('connector-capabilities',result.capabilities);
 demand(result.repository_id===null||Number.isSafeInteger(result.repository_id)&&result.repository_id>0,'INVALID_REPOSITORY_IDENTITY','Probe must preserve the selected immutable repository identity.',409);
 return result;
}
export async function probeSecretReplacement(wid:string,pid:string,key:string,secretId:string,replacementId:string,match:string) {
 const nonce=newId();
 await command(wid,pid,'secret.replacement.probe',key,{secretId,replacementId,match},async tx=>{
  const secret=await secretTx(tx,wid,secretId,true),row=await replacementTx(tx,wid,secretId,replacementId,true);expected(match,row.revision);
  demand(row.status!=='activated'&&(row.status!=='probing'||Date.parse(row.probe_expires_at)<=Date.now()),'REPLACEMENT_PROBE_ACTIVE','Replacement is already activated or has an active bounded probe.',409);
  const resource=await resourceTx(tx,wid,secret);assertReplacementCurrent(row,secret,resource.binding);
  await tx.query("UPDATE faultline.secret_replacements SET status='probing',revision=revision+1,capabilities=NULL,probe_binding_hash=NULL,probe_nonce=$4,probe_expires_at=$5,updated_at=now() WHERE workspace_id=$1 AND secret_id=$2 AND id=$3",[wid,secretId,replacementId,nonce,new Date(Date.now()+probeDeadlineMs+30_000).toISOString()]);
  await audit(tx,wid,pid,'secret.replacement.probe',{secret_id:secretId,replacement_id:replacementId,resource_binding_hash:row.resource_binding_hash});
  return replacementMetadata(await replacementTx(tx,wid,secretId,replacementId),secret);
 },['owner']);
 // A replay returns its receipt without sending the provider another request.
 const ownsAttempt=await transaction(wid,async tx=>{await access(tx,wid,pid,['owner']);const row=await replacementTx(tx,wid,secretId,replacementId);return row.status==='probing'&&row.probe_nonce===nonce;});
 if(!ownsAttempt)return getSecretReplacement(wid,pid,secretId,replacementId);
 const controller=new AbortController(),control={signal:AbortSignal.any([controller.signal,AbortSignal.timeout(probeDeadlineMs)]),assertActive:()=>transaction(wid,tx=>activeProbeTx(tx,wid,pid,secretId,replacementId,nonce).then(()=>{}))};
 const monitor=setInterval(()=>{void control.assertActive().catch(()=>controller.abort());},2000);
 try{
  const initial=await transaction(wid,async tx=>{
   const current=await activeProbeTx(tx,wid,pid,secretId,replacementId,nonce),version=(await tx.query('SELECT ciphertext FROM faultline.secret_versions WHERE workspace_id=$1 AND secret_id=$2 AND version=$3',[wid,secretId,current.row.version])).rows[0];
   demand(version,'SECRET_UNAVAILABLE','Staged encrypted candidate is unavailable.',409);return {...current,token:open(version.ciphertext,`${wid}:${secretId}:${current.row.version}`,await loadKeyring())};
  });
  const observation=await observeReplacementProbe(async()=>{
   if(initial.resource.kind==='source')return probeSourceCredential(initial.resource.row,initial.token,control,'declaration' in initial.resource?initial.resource.declaration:undefined);
   const result=await probeModelCredential(initial.resource.row,initial.token,control);return {capabilities:result.capabilities,repository_id:null};
  },control);
  return await transaction(wid,async tx=>{
   await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid]);const {row,secret}=await activeProbeTx(tx,wid,pid,secretId,replacementId,nonce),passed=observation.capabilities.status==='available';
   await tx.query('UPDATE faultline.secret_replacements SET status=$4,capabilities=$5,probe_binding_hash=$6,probe_expires_at=$7,probe_nonce=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND secret_id=$2 AND id=$3',[wid,secretId,replacementId,passed?'probed':'failed',observation,passed?replacementProbeBinding(row,observation):null,new Date(Date.now()+reviewLifetimeMs).toISOString()]);
   await audit(tx,wid,pid,'secret.replacement.probe.result',{secret_id:secretId,replacement_id:replacementId,status:passed?'probed':'failed',reason_code:observation.capabilities.reason_code});return replacementMetadata(await replacementTx(tx,wid,secretId,replacementId),secret);
  });
 }catch(error){
  // A failed/stale/demoted attempt never publishes capabilities or switches the active version.
  await transaction(wid,async tx=>{await tx.query("UPDATE faultline.secret_replacements SET status='failed',capabilities=NULL,probe_binding_hash=NULL,probe_nonce=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND secret_id=$2 AND id=$3 AND status='probing' AND probe_nonce=$4",[wid,secretId,replacementId,nonce]);});
  if(control.signal.aborted)throw new DomainError('REPLACEMENT_PROBE_CANCELLED','Candidate probe was cancelled or reached its finite deadline; the previous active credential is unchanged.',409);
  throw error;
 }finally{clearInterval(monitor);controller.abort();}
}
export async function activateSecretReplacement(wid:string,pid:string,key:string,secretId:string,replacementId:string,input:{acknowledged_binding_hash:string},match:string) {
 return command(wid,pid,'secret.replacement.activate',key,{secretId,replacementId,input,match},async tx=>{
  const secret=await secretTx(tx,wid,secretId,true),row=await replacementTx(tx,wid,secretId,replacementId,true);expected(match,row.revision);
  const resource=await resourceTx(tx,wid,secret);assertReplacementActivation(row,secret,resource.binding,input.acknowledged_binding_hash);
  const version=(await tx.query('SELECT key_version,ciphertext FROM faultline.secret_versions WHERE workspace_id=$1 AND secret_id=$2 AND version=$3',[wid,secretId,row.version])).rows[0];demand(version,'SECRET_UNAVAILABLE','Encrypted candidate is unavailable.',409);
  await tx.query('UPDATE faultline.secrets SET active_version=$3,key_version=$4,ciphertext=$5,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[wid,secretId,row.version,version.key_version,version.ciphertext]);
  const observation=row.capabilities as ReplacementProbeObservation;
  if(resource.kind==='source')await activateSourceCredentialTx(tx,wid,resource.id,row.version,observation);else await activateModelCredentialTx(tx,wid,resource.id,row.version,observation.capabilities);
  await tx.query("UPDATE faultline.secret_replacements SET status='activated',activated_at=now(),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND secret_id=$2 AND id=$3",[wid,secretId,replacementId]);
  await audit(tx,wid,pid,'secret.replacement.activate',{secret_id:secretId,replacement_id:replacementId,version:row.version,probe_binding_hash:row.probe_binding_hash});
  return replacementMetadata(await replacementTx(tx,wid,secretId,replacementId),await secretTx(tx,wid,secretId));
 },['owner']);
}
