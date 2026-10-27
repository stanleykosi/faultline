import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {config} from '../config.js';
import {demand} from '../errors.js';
import {newId} from '../canonical.js';
import {command} from '../workspaces/service.js';
import {getCaseTx} from '../cases/service.js';
import {transaction} from '../../../database/src/client.js';
import {objects} from '../storage/objects.js';
import {SupabaseObjects} from '../storage/supabase-objects.js';
import {storeBounded} from '../storage/capacity.js';
import {createImport,importTx} from './service.js';

const MAX=50*1024*1024,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type UploadInput={kind:'analytics'|'support'|'release';source_id?:string;name:string;sha256:string;size_bytes:number};
type UploadClaim=UploadInput&{version:1;wid:string;pid:string;caseId:string;uploadId:string;expires_at:number};
function signature(encoded:string){return createHmac('sha256',config.authSecret).update('direct-import:'+encoded).digest('base64url');}
export function validateUploadInput(value:unknown):UploadInput{
 demand(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_UPLOAD','Provide file details.',400);const input=value as UploadInput;
 demand(Object.keys(input).every(key=>['kind','source_id','name','sha256','size_bytes'].includes(key))&&['analytics','support','release'].includes(input.kind)&&typeof input.name==='string'&&input.name.length>0&&input.name.length<=200&&!/[\x00-\x1f/\\]/.test(input.name)&&typeof input.sha256==='string'&&/^[a-f0-9]{64}$/.test(input.sha256)&&Number.isSafeInteger(input.size_bytes)&&input.size_bytes>0&&input.size_bytes<=MAX&&(input.source_id===undefined||typeof input.source_id==='string'&&UUID.test(input.source_id)),'INVALID_UPLOAD','Provide a supported file, type, hash and size.',400);
 uploadFormat(input.name);return input;
}
export function uploadFormat(name:string){const format=name.toLowerCase().endsWith('.jsonl.gz')?'gzip_jsonl':name.toLowerCase().split('.').at(-1)??'';demand(['csv','json','jsonl','gzip_jsonl'].includes(format),'UNSUPPORTED_FORMAT','Upload CSV, JSON, JSONL or gzip JSONL.',400);return format;}
function remote(){demand(objects instanceof SupabaseObjects,'DIRECT_UPLOAD_UNAVAILABLE','Direct upload is unavailable on this host.',409);return objects;}
export function encodeUploadClaim(claim:UploadClaim){const encoded=Buffer.from(JSON.stringify(claim)).toString('base64url');return encoded+'.'+signature(encoded);}
export function decodeUploadClaim(token:unknown,wid:string,pid:string,caseId:string,now=Date.now(),allowExpiredReceipt=false):UploadClaim{
 demand(typeof token==='string'&&token.length<=4096,'INVALID_UPLOAD','Invalid upload receipt.',400);const pieces=token.split('.'),[encoded,sig]=pieces,wanted=signature(encoded??'');
 demand(pieces.length===2&&sig&&sig.length===wanted.length&&timingSafeEqual(Buffer.from(sig),Buffer.from(wanted)),'INVALID_UPLOAD','Invalid upload receipt.',403);
 let value:UploadClaim;try{value=JSON.parse(Buffer.from(encoded!,'base64url').toString('utf8'));}catch{demand(false,'INVALID_UPLOAD','Invalid upload receipt.',400);}
 demand(value!.version===1&&value!.wid===wid&&value!.pid===pid&&value!.caseId===caseId&&UUID.test(value!.uploadId)&&Number.isSafeInteger(value!.expires_at)&&(allowExpiredReceipt||value!.expires_at>now),'UPLOAD_EXPIRED_OR_FOREIGN','Upload expired or belongs to another case or person.',403);
 validateUploadInput({kind:value!.kind,...(value!.source_id?{source_id:value!.source_id}:{}),name:value!.name,sha256:value!.sha256,size_bytes:value!.size_bytes});return value!;
}
export async function* verifyUploadBytes(input:AsyncIterable<Uint8Array>,sha256:string,size:number){let received=0;const digest=createHash('sha256');for await(const chunk of input){received+=chunk.length;demand(received<=size,'BYTE_LIMIT','Uploaded file exceeds its reviewed size.',413);digest.update(chunk);yield chunk;}demand(received===size&&digest.digest('hex')===sha256,'UPLOAD_CONTENT_MISMATCH','Uploaded file differs from its reviewed hash or size.',409);}
export async function prepareDirectUpload(wid:string,pid:string,key:string,caseId:string,value:unknown){
 const input=validateUploadInput(value),store=remote();
 return command(wid,pid,'import.upload.prepare',key,{caseId,...input},async tx=>{
  await getCaseTx(tx,wid,pid,caseId,true);
  if(input.source_id)demand((await tx.query('SELECT id FROM faultline.sources WHERE workspace_id=$1 AND id=$2',[wid,input.source_id])).rowCount,'NOT_FOUND','Source unavailable.',404);
  const claim:UploadClaim={...input,version:1,wid,pid,caseId,uploadId:newId(),expires_at:Date.now()+15*60*1000};
  demand(Number((await tx.query('SELECT count(*) AS n FROM faultline.direct_uploads WHERE workspace_id=$1 AND cleaned_at IS NULL',[wid])).rows[0].n)<20,'UPLOAD_LIMIT','Temporary upload limit reached. Try after old uploads expire.',429);
  await tx.query('INSERT INTO faultline.case_storage(workspace_id,case_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[wid,caseId]);
  // The provider capability enforces the bucket ceiling, not the caller's declared size.
  demand((await tx.query('UPDATE faultline.case_storage SET reserved_bytes=reserved_bytes+$3 WHERE workspace_id=$1 AND case_id=$2 AND used_bytes+reserved_bytes+$3<=ceiling RETURNING case_id',[wid,caseId,MAX])).rowCount,'STORAGE_EXHAUSTED','Case storage limit reached.',429);
  await tx.query('INSERT INTO faultline.storage_reservations(id,workspace_id,case_id,amount) VALUES($1,$2,$3,$4)',[claim.uploadId,wid,caseId,MAX]);
  await tx.query("INSERT INTO faultline.direct_uploads(id,workspace_id,case_id,actor_id,reservation_id,size_bytes,expires_at,cleanup_after) VALUES($1,$2,$3,$4,$1,$5,$6,now()+interval '3 hours')",[claim.uploadId,wid,caseId,pid,input.size_bytes,new Date(claim.expires_at).toISOString()]);
  const signed=await store.createUpload(wid,claim.uploadId);
  return {upload_id:claim.uploadId,upload_url:signed.url,token:encodeUploadClaim(claim),expires_at:new Date(claim.expires_at).toISOString(),method:'PUT',headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},completed_import:null as Record<string,unknown>|null};
 },['owner','analyst'],async(tx,result,replayed)=>{
  await getCaseTx(tx,wid,pid,caseId,true);
  if(replayed){
   const old=(await tx.query("SELECT result FROM faultline.idempotency WHERE workspace_id=$1 AND principal_id=$2 AND operation='import.create' AND key=$3",[wid,pid,'direct-upload:'+result.upload_id])).rows[0];
   if(old){await importTx(tx,wid,caseId,old.result.id);result.completed_import=old.result;}
   else demand(Date.parse(result.expires_at)>Date.now(),'UPLOAD_EXPIRED_OR_FOREIGN','Upload expired. Choose the file again to start a new upload.',403);
  }
 });
}
export async function acceptDirectUpload(wid:string,pid:string,caseId:string,token:unknown){
 const claim=decodeUploadClaim(token,wid,pid,caseId,Date.now(),true),store=remote(),key='direct-upload:'+claim.uploadId;
 const previous=await transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId,true);const old=(await tx.query("SELECT result FROM faultline.idempotency WHERE workspace_id=$1 AND principal_id=$2 AND operation='import.create' AND key=$3",[wid,pid,key])).rows[0];if(old){await importTx(tx,wid,caseId,old.result.id);return old.result;}return null;});
 const settleTemporaryBytes=()=>transaction(wid,async tx=>{
  await getCaseTx(tx,wid,pid,caseId,true);
  await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid]);
  const reservation=(await tx.query('SELECT amount FROM faultline.storage_reservations WHERE workspace_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE',[wid,caseId,claim.uploadId])).rows[0];
  if(reservation&&Number(reservation.amount)>claim.size_bytes){await tx.query('UPDATE faultline.storage_reservations SET amount=$4 WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,caseId,claim.uploadId,claim.size_bytes]);await tx.query('UPDATE faultline.case_storage SET reserved_bytes=reserved_bytes-$3 WHERE workspace_id=$1 AND case_id=$2',[wid,caseId,Number(reservation.amount)-claim.size_bytes]);}
 });
 if(previous){await settleTemporaryBytes();return previous;}
 demand(claim.expires_at>Date.now(),'UPLOAD_EXPIRED_OR_FOREIGN','Upload expired. Start a new upload.',403);
 await transaction(wid,async tx=>{await getCaseTx(tx,wid,pid,caseId,true);demand((await tx.query('SELECT id FROM faultline.direct_uploads WHERE workspace_id=$1 AND case_id=$2 AND id=$3 AND actor_id=$4 AND cleaned_at IS NULL AND expires_at>now()',[wid,caseId,claim.uploadId,pid])).rowCount,'UPLOAD_EXPIRED_OR_FOREIGN','Upload is no longer available.',403);});
 const raw=await storeBounded(wid,pid,caseId,claim.size_bytes,()=>objects.putStream(wid,verifyUploadBytes(store.readUpload(wid,claim.uploadId,claim.size_bytes),claim.sha256,claim.size_bytes),claim.size_bytes));
 const result=await createImport(wid,pid,key,caseId,{kind:claim.kind,...(claim.source_id?{source_id:claim.source_id}:{}),name:claim.name,format:uploadFormat(claim.name),raw_key:raw.key,raw_bytes:raw.size_bytes});
 // Verified create-only staging bytes cannot grow after acceptance; release excess reservation.
 await settleTemporaryBytes();
 // Keep the create-only staging path until its provider token has expired.
 return result;
}
export async function cleanExpiredDirectUploads(wid:string){
 if(!(objects instanceof SupabaseObjects))return;
 const store=objects;
 const rows=await transaction(wid,tx=>tx.query('SELECT id,case_id,reservation_id FROM faultline.direct_uploads WHERE workspace_id=$1 AND cleaned_at IS NULL AND cleanup_after<now() ORDER BY cleanup_after LIMIT 1',[wid]));
 for(const row of rows.rows){
  await store.removeUpload(wid,row.id);
  await transaction(wid,async tx=>{
   await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid]);
   const changed=await tx.query('UPDATE faultline.direct_uploads SET cleaned_at=now() WHERE workspace_id=$1 AND id=$2 AND cleaned_at IS NULL RETURNING id',[wid,row.id]);
   if(!changed.rowCount)return;
   const released=await tx.query('DELETE FROM faultline.storage_reservations WHERE workspace_id=$1 AND case_id=$2 AND id=$3 RETURNING amount',[wid,row.case_id,row.reservation_id]);
   if(released.rowCount)await tx.query('UPDATE faultline.case_storage SET reserved_bytes=reserved_bytes-$3 WHERE workspace_id=$1 AND case_id=$2',[wid,row.case_id,released.rows[0].amount]);
  });
 }
}
