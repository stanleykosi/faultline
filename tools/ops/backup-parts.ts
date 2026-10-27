import {gzipSync,gunzipSync} from 'node:zlib';
import {constants as bufferConstants} from 'node:buffer';
import {byteHash} from '../../packages/core/src/canonical.js';
import {demand,DomainError} from '../../packages/core/src/errors.js';
export const MAX_RECOVERY_PART_BYTES=256*1024*1024;
export const MAX_RECOVERY_LOGICAL_BYTES=1024*1024*1024;
export const MAX_RECOVERY_STORED_BYTES=512*1024*1024;
export const MAX_RECOVERY_FRAME_BYTES=Math.min(bufferConstants.MAX_STRING_LENGTH,1024*1024*1024);
export interface BackupPart {name:string;sha256:string;size_bytes:number;bytes_base64:string;encoding?:'gzip';}
export function partDescriptor({name,sha256,size_bytes,encoding}:BackupPart):Omit<BackupPart,'bytes_base64'>{return {name,sha256,size_bytes,...(encoding?{encoding}:{})};}
export function encodeBackupPart(name:string,bytes:Buffer):BackupPart{
 demand(bytes.length<=MAX_RECOVERY_PART_BYTES,'BACKUP_SIZE_LIMIT','Individual recovery part exceeds256 MiB.');
 return {name,sha256:byteHash(bytes),size_bytes:bytes.length,encoding:'gzip',bytes_base64:gzipSync(bytes,{level:6}).toString('base64')};
}
export function assertPartMetadata(part:BackupPart,schemaVersion:1|2|3):void{
 const ceiling=schemaVersion===1?MAX_RECOVERY_LOGICAL_BYTES:MAX_RECOVERY_PART_BYTES;
 demand(Number.isSafeInteger(part.size_bytes)&&part.size_bytes>=0&&part.size_bytes<=ceiling&&typeof part.sha256==='string'&&/^[a-f0-9]{64}$/.test(part.sha256),'BACKUP_FORMAT','Invalid bounded recovery part descriptor.');
 demand(schemaVersion===1?part.encoding===undefined:part.encoding==='gzip','BACKUP_FORMAT','Unsupported recovery part encoding for manifest version.');
 demand(typeof part.bytes_base64==='string'&&part.bytes_base64.length<=Math.ceil((ceiling+1024*1024)/3)*4,'BACKUP_SIZE_LIMIT','Stored recovery part exceeds its finite ceiling.');
}
export function decodeBackupPart(part:BackupPart,schemaVersion:1|2|3):Buffer{
 assertPartMetadata(part,schemaVersion);
 const stored=Buffer.from(part.bytes_base64,'base64');demand(stored.toString('base64')===part.bytes_base64,'BACKUP_FORMAT','Recovery part requires canonical base64.');
 let bytes:Buffer;try{bytes=part.encoding==='gzip'?gunzipSync(stored,{maxOutputLength:Math.max(1,part.size_bytes)}):stored;}catch{throw new DomainError('BACKUP_DECOMPRESSION_FAILED','Compressed recovery part is invalid or exceeds its declared original size.');}
 demand(bytes.length===part.size_bytes&&byteHash(bytes)===part.sha256,'BACKUP_CHECKSUM_FAILED','Original recovery bytes do not match their signed size/hash.');return bytes;
}
export function assertPartInventoryLimits(parts:BackupPart[],schemaVersion:1|2|3):void{
 let original=0,stored=0;demand(parts.length<=20_000,'BACKUP_SIZE_LIMIT','Too many recovery parts.');
 for(const part of parts){assertPartMetadata(part,schemaVersion);original+=part.size_bytes;stored+=Buffer.byteLength(part.bytes_base64,'base64');demand(original<=MAX_RECOVERY_LOGICAL_BYTES&&(schemaVersion===1||stored<=MAX_RECOVERY_STORED_BYTES),'BACKUP_SIZE_LIMIT','Recovery logical or stored bytes exceed finite archive limits.');}
}
export function serializeBackupFrame<T extends {parts:BackupPart[]}>(bundle:T):string{
 const metadata=JSON.stringify({...bundle,parts:bundle.parts.map(part=>({...part,bytes_base64:''}))});
 assertBackupFrameCapacity(Buffer.byteLength(metadata),bundle.parts.reduce((sum,part)=>sum+part.bytes_base64.length,0));
 return JSON.stringify(bundle);
}
export function assertBackupFrameCapacity(metadataBytes:number,base64Bytes:number):void{
 const size=metadataBytes+base64Bytes;
 demand(Number.isSafeInteger(metadataBytes)&&metadataBytes>=0&&Number.isSafeInteger(base64Bytes)&&base64Bytes>=0&&Number.isSafeInteger(size)&&size<=MAX_RECOVERY_FRAME_BYTES,'BACKUP_SIZE_LIMIT','Encoded recovery document exceeds the installed Node finite string/frame ceiling.');
}
