import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {canonical,byteHash} from '../canonical.js';
import {demand} from '../errors.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
type Receipt=Record<string,any>;
export type RecoveryStatus={status:'verified'|'failed'|'unverified'|'not_run';recorded_at:string|null;manifest_hash:string|null;archive_sha256:string|null;key_versions:string[]|null;detail:'authenticated_archive'|'isolated_restore_bound_to_archive'|'receipt_failed'|'receipt_or_archive_unavailable'|'no_receipt'};
async function regularReport(file:string){const stat=await fs.lstat(file);demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=128*1024,'RECOVERY_REPORT_INVALID','Recovery receipt must be a bounded regular report.');return {value:JSON.parse(await fs.readFile(file,'utf8')) as Receipt,modified:stat.mtimeMs};}
async function archiveHash(file:string){demand(await fs.realpath(file)===path.resolve(file),'RECOVERY_ARCHIVE_PATH','Backup archive path must not traverse a symlink.');const before=await fs.lstat(file);demand(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=1024*1024*1024,'RECOVERY_ARCHIVE_INVALID','Backup archive must be a bounded regular file.');const digest=createHash('sha256');let total=0;for await(const chunk of createReadStream(file)){total+=chunk.length;demand(total<=before.size,'RECOVERY_ARCHIVE_CHANGED','Backup archive grew during validation.');digest.update(chunk);}const after=await fs.lstat(file);demand(total===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs,'RECOVERY_ARCHIVE_CHANGED','Backup archive changed during validation.');return digest.digest('hex');}
async function exactPrivateDirectory(file:string){const stat=await fs.lstat(file);demand(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(file)===path.resolve(file),'RECOVERY_ARCHIVE_PATH','Backup directory path must not traverse a symlink.');}
function reportTime(modified:number){return new Date(modified).toISOString();}
function signedTime(value:Receipt){demand(typeof value.checked_at==='string'&&Number.isFinite(Date.parse(value.checked_at))&&new Date(value.checked_at).toISOString()===value.checked_at,'RECOVERY_REPORT_TIME','Recovery receipt requires an exact signed ISO timestamp.');return value.checked_at as string;}
function keyVersions(value:unknown){demand(Array.isArray(value)&&value.length>0&&value.length<=32&&value.every(item=>typeof item==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item))&&new Set(value).size===value.length,'RECOVERY_REPORT_KEYS','Recovery receipt requires a finite unique key-version inventory.');return [...value].sort() as string[];}
async function reportFiles(directory:string,operation:'backup'|'restore'){
 const names=(await fs.readdir(directory)).filter(name=>name.startsWith('ops-'+operation+'-')&&name.endsWith('.json')).sort();demand(names.length<=256,'RECOVERY_REPORT_LIMIT','Recovery receipt inventory exceeds its finite bound.');
 return Promise.all(names.map(async name=>{const full=path.join(directory,name),read=await regularReport(full);return {name,value:read.value,modified:read.modified};}));
}
async function trustedSigner(root:string,requested?:string){const file=path.resolve(requested??process.env.REPORT_SIGNING_PUBLIC_KEY_PATH??path.join(root,'.runtime/keys/report-public.pem'));const stat=await fs.lstat(file);demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=65536&&await fs.realpath(file)===file,'RECOVERY_SIGNER_INVALID','Recovery receipt verifier must be a bounded regular trusted public-key file.');const key=createPublicKey(await fs.readFile(file));demand(key.asymmetricKeyType==='ed25519','RECOVERY_SIGNER_INVALID','Recovery receipt signer must be Ed25519.');return {key,fingerprint:byteHash(key.export({format:'der',type:'spki'}))};}
function verifyReport(value:Receipt,name:string,operation:'backup'|'restore',signer:{key:ReturnType<typeof createPublicKey>;fingerprint:string}){const {receipt_signature,...body}=value,filenameId=name.slice(('ops-'+operation+'-').length,-'.json'.length);demand(receipt_signature&&receipt_signature.schema_version===1&&receipt_signature.signer_sha256===signer.fingerprint&&typeof receipt_signature.signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(receipt_signature.signature),'RECOVERY_REPORT_SIGNATURE','Recovery receipt is not signed by the installed trusted operator key.');if(typeof body.id==='string')demand(body.id===filenameId,'RECOVERY_REPORT_ID','Recovery receipt filename and signed operation ID differ.');demand(verify(null,Buffer.from(canonical(body)),signer.key,Buffer.from(receipt_signature.signature,'base64')),'RECOVERY_REPORT_SIGNATURE','Recovery receipt signature is invalid.');return body as Receipt;}
export async function recoveryReceiptDiagnostics(root=process.cwd(),publicKeyPath?:string):Promise<{backup:RecoveryStatus;restore:RecoveryStatus}>{
 const directory=path.resolve(root,'reports/application');
 try{const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory)throw new Error('RECOVERY_REPORT_PATH');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {backup:{status:'not_run',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'no_receipt'},restore:{status:'not_run',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'no_receipt'}};return {backup:{status:'unverified',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'},restore:{status:'unverified',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'}};}
 let backups:{name:string;value:Receipt;modified:number}[]=[],restores:{name:string;value:Receipt;modified:number}[]=[],signer:{key:ReturnType<typeof createPublicKey>;fingerprint:string};
 try{[backups,restores,signer]=await Promise.all([reportFiles(directory,'backup'),reportFiles(directory,'restore'),trustedSigner(root,publicKeyPath)]);}
  catch{return {backup:{status:'unverified',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'},restore:{status:'unverified',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'}};}
  const validBackups=new Map<string,{value:Receipt;recorded_at:string;key_versions:string[]}>();let backup:RecoveryStatus={status:'not_run',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'no_receipt'};
 for(const row of backups.sort((a,b)=>a.modified-b.modified)){
   let value:Receipt;try{value=verifyReport(row.value,row.name,'backup',signer);}catch{backup={status:'unverified',recorded_at:reportTime(row.modified),manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'};continue;}let next:RecoveryStatus;
   if(value.operation==='backup'&&value.status==='failed')next={status:'failed',recorded_at:reportTime(row.modified),manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_failed'};
  else try{
   demand(value.operation==='backup'&&value.status==='complete_restore_not_run'&&uuid.test(value.id)&&sha.test(value.archive_sha256)&&sha.test(value.manifest_hash),'RECOVERY_REPORT_INVALID','Backup receipt fields are invalid.');
    const recorded_at=signedTime(value),versions=keyVersions(value.key_versions);
   const expected=path.resolve(root,'.runtime/backups/faultline-'+value.id+'.flbackup'),supplied=path.resolve(String(value.archive_path??''));demand(expected===supplied&&path.relative(path.resolve(root),supplied).startsWith('.runtime'+path.sep+'backups'+path.sep),'RECOVERY_ARCHIVE_SCOPE','Backup receipt does not name its exact private archive.');await exactPrivateDirectory(path.resolve(root,'.runtime'));await exactPrivateDirectory(path.resolve(root,'.runtime/backups'));
    demand(await archiveHash(supplied)===value.archive_sha256,'RECOVERY_ARCHIVE_HASH','Backup archive bytes differ from the recorded receipt.');validBackups.set(value.archive_sha256+'\0'+value.manifest_hash,{value,recorded_at,key_versions:versions});
    next={status:'verified',recorded_at,manifest_hash:value.manifest_hash,archive_sha256:value.archive_sha256,key_versions:versions,detail:'authenticated_archive'};
   }catch{next={status:'unverified',recorded_at:reportTime(row.modified),manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'};}
  backup=next;
 }
  let restore:RecoveryStatus={status:'not_run',recorded_at:null,manifest_hash:null,archive_sha256:null,key_versions:null,detail:'no_receipt'};
 for(const row of restores.sort((a,b)=>a.modified-b.modified)){
   let value:Receipt;try{value=verifyReport(row.value,row.name,'restore',signer);}catch{restore={status:'unverified',recorded_at:reportTime(row.modified),manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'};continue;}let next:RecoveryStatus;
   if(value.operation==='restore'&&value.status==='failed')next={status:'failed',recorded_at:reportTime(row.modified),manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_failed'};
  else try{
   demand(value.operation==='restore'&&value.status==='isolated_restore_verified'&&uuid.test(value.id)&&sha.test(value.archive_sha256)&&sha.test(value.manifest_hash)&&value.runtime_roles_verified===true&&value.auth_tenant_access===false&&value.tenant_without_scope_rows===0,'RECOVERY_REPORT_INVALID','Restore receipt fields are invalid.');
    const recorded_at=signedTime(value),versions=keyVersions(value.key_versions),bound=validBackups.get(value.archive_sha256+'\0'+value.manifest_hash);demand(bound,'RECOVERY_RESTORE_UNBOUND','Isolated restore must match a currently validated backup archive and manifest.');demand(JSON.stringify(versions)===JSON.stringify(bound.key_versions)&&Date.parse(recorded_at)>=Date.parse(bound.recorded_at),'RECOVERY_RESTORE_INVENTORY','Restore key versions and timestamp must match the completed backup evidence.');
    next={status:'verified',recorded_at,manifest_hash:value.manifest_hash,archive_sha256:value.archive_sha256,key_versions:versions,detail:'isolated_restore_bound_to_archive'};
   }catch{next={status:'unverified',recorded_at:reportTime(row.modified),manifest_hash:null,archive_sha256:null,key_versions:null,detail:'receipt_or_archive_unavailable'};}
  restore=next;
 }
 return {backup,restore};
}
