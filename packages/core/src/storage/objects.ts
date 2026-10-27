import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {config} from '../config.js';
import {byteHash} from '../canonical.js';
import {demand} from '../errors.js';
import {SupabaseObjects} from './supabase-objects.js';
import type {ObjectStore} from './object-store.js';
export class PrivateObjects{
 constructor(private root=config.objectPath){}
 async health(){await fs.mkdir(this.root,{recursive:true,mode:0o700});const probe=path.join(this.root,'.health-'+randomUUID());await fs.writeFile(probe,'probe',{flag:'wx',mode:0o600});await fs.unlink(probe);}
 private file(wid:string,key:string){demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(wid)&&/^[a-f0-9]{64}$/.test(key),'INVALID_OBJECT','Invalid object identity.');return path.join(this.root,wid,key);}
 private async safe(wid:string,key:string){
  const file=this.file(wid,key);await fs.mkdir(this.root,{recursive:true,mode:0o700});const root=await fs.realpath(this.root),folder=path.dirname(file);
  await fs.mkdir(folder,{recursive:true,mode:0o700});const stat=await fs.lstat(folder);demand(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE','Object directory must be a private real directory.',503);
  const resolved=await fs.realpath(folder),relative=path.relative(root,resolved);demand(relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative),'UNSAFE_STORAGE','Object directory escapes private root.',503);
  try{const item=await fs.lstat(file);demand(item.isFile()&&!item.isSymbolicLink(),'UNSAFE_STORAGE','Object must be a private regular file.',503);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return file;
 }
 async put(wid:string,bytes:Buffer){
  const key=byteHash(bytes),file=await this.safe(wid,key);
  try{const existing=await fs.readFile(file);demand(byteHash(existing)===key,'ARTIFACT_CORRUPT','Stored object hash mismatch.');return {key,sha256:key,size_bytes:bytes.length};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=file+'.partial-'+randomUUID(),handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();await handle.close();await this.safe(wid,key);await fs.rename(temporary,file);}catch(error){await handle.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});throw error;}
  return {key,sha256:key,size_bytes:bytes.length};
 }
 async putStream(wid:string,input:AsyncIterable<Uint8Array>,limit=50*1024*1024){
  const folder=path.dirname(await this.safe(wid,'0'.repeat(64))),temporary=path.join(folder,'.partial-'+randomUUID()),file=await fs.open(temporary,'wx',0o600),digest=createHash('sha256');let bytes=0;
  try{for await(const chunk of input){bytes+=chunk.length;demand(bytes<=limit,'BYTE_LIMIT','Source upload exceeds policy.',413);digest.update(chunk);let offset=0;while(offset<chunk.length){const written=await file.write(chunk,offset,chunk.length-offset);demand(written.bytesWritten>0,'STORAGE_WRITE_FAILED','Object write made no progress.',503);offset+=written.bytesWritten;}}
   await file.sync();await file.close();const key=digest.digest('hex'),destination=await this.safe(wid,key);
   try{const stored=await fs.readFile(destination);demand(byteHash(stored)===key,'ARTIFACT_CORRUPT','Existing object corrupted.');await fs.unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await fs.rename(temporary,destination);}
   return {key,sha256:key,size_bytes:bytes};
  }catch(error){await file.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});throw error;}
 }
 async remove(wid:string,key:string){const file=await this.safe(wid,key);try{await fs.unlink(file);return {removed:true};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {removed:false,already_absent:true};throw error;}}
 /** Private parser input only: drain to EOF before publishing any derived result. */
 async *readStream(wid:string,key:string,limit=50*1024*1024):AsyncGenerator<Buffer>{
  demand(Number.isSafeInteger(limit)&&limit>0&&limit<=256*1024*1024,'BYTE_LIMIT','Object stream requires a finite input ceiling.',413);
  const file=await this.safe(wid,key),handle=await fs.open(file,'r');let stream:ReturnType<typeof handle.createReadStream>|undefined;
  try{const stat=await handle.stat();demand(stat.isFile()&&stat.size<=limit,'BYTE_LIMIT','Stored source exceeds its finite input ceiling.',413);stream=handle.createReadStream({autoClose:false,highWaterMark:64*1024});const digest=createHash('sha256');let bytes=0;
   for await(const chunk of stream){demand(Buffer.isBuffer(chunk),'ARTIFACT_CORRUPT','Stored input requires original binary bytes.');bytes+=chunk.length;demand(bytes<=limit,'BYTE_LIMIT','Stored source exceeds its finite input ceiling.',413);digest.update(chunk);yield chunk;}
   demand(bytes===stat.size&&digest.digest('hex')===key,'ARTIFACT_CORRUPT','Stored artifact hash/size mismatch.');
  }finally{stream?.destroy();await handle.close();}
 }
 async read(wid:string,key:string){const bytes=await fs.readFile(await this.safe(wid,key));demand(byteHash(bytes)===key,'ARTIFACT_CORRUPT','Stored artifact hash mismatch.');return bytes;}
}
if(process.env.OBJECT_STORE==='supabase')demand(process.env.SUPABASE_UPLOAD_BUCKET&&process.env.SUPABASE_UPLOAD_BUCKET!==process.env.SUPABASE_STORAGE_BUCKET,'CONFIGURATION','Use separate private evidence and temporary upload buckets.');
export const objects:ObjectStore=process.env.OBJECT_STORE==='supabase'?new SupabaseObjects({url:process.env.SUPABASE_URL??'',bucket:process.env.SUPABASE_STORAGE_BUCKET??'',uploadBucket:process.env.SUPABASE_UPLOAD_BUCKET,serviceKey:process.env.SUPABASE_STORAGE_SERVICE_KEY??''}):new PrivateObjects();
