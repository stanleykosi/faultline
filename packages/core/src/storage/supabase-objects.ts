import {createHash} from 'node:crypto';
import {DomainError,demand} from '../errors.js';
import type {ObjectStore} from './object-store.js';

const MAX_READ=256*1024*1024;
const MAX_UPLOAD=50*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function ceiling(limit:number,max=MAX_READ){demand(Number.isSafeInteger(limit)&&limit>0&&limit<=max,'BYTE_LIMIT','Storage requires a finite byte ceiling.',413);return limit;}

/** Supabase Storage REST; no provider SDK, disk, or public object URLs.
 * Wire contracts: supabase/storage-js StorageFileApi upload, download,
 * createSignedUploadUrl, remove and StorageBucketApi.getBucket.
 * https://github.com/supabase/storage-js/tree/master/src/packages
 */
export class SupabaseObjects implements ObjectStore {
 private readonly origin:string;
 private readonly bucket:string;
 private readonly uploadBucket:string;
 private readonly enforceUploadLimit:boolean;
 private readonly serviceKey:string;
 private readonly fetcher:typeof fetch;
 constructor(options:{url:string;bucket:string;uploadBucket?:string;serviceKey:string;fetch?:typeof fetch}){
  let parsed:URL;try{parsed=new URL(options.url);}catch{throw new DomainError('INVALID_STORAGE_CONFIG','Invalid Supabase origin.',503);}
  demand(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&parsed.pathname==='/'&&!parsed.search&&!parsed.hash&&parsed.port==='','INVALID_STORAGE_CONFIG','Supabase requires an exact HTTPS origin.',503);
  demand(/^[a-z0-9][a-z0-9.-]*\.(?:supabase\.co|supabase\.in|supabase\.red)$/.test(parsed.hostname),'INVALID_STORAGE_CONFIG','Storage must use a Supabase project origin.',503);
  demand(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(options.bucket),'INVALID_STORAGE_CONFIG','Invalid private storage bucket.',503);
  demand(options.uploadBucket===undefined||/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(options.uploadBucket),'INVALID_STORAGE_CONFIG','Invalid private upload bucket.',503);
  demand(options.serviceKey.length>0&&!/[\r\n]/.test(options.serviceKey),'INVALID_STORAGE_CONFIG','Storage service credential is required.',503);
  this.origin=parsed.origin;this.bucket=options.bucket;this.uploadBucket=options.uploadBucket??options.bucket;this.enforceUploadLimit=options.uploadBucket!==undefined;this.serviceKey=options.serviceKey;this.fetcher=options.fetch??fetch;
 }
 private identity(wid:string,key:string){demand(UUID.test(wid)&&/^[a-f0-9]{64}$/.test(key),'INVALID_OBJECT','Invalid object identity.');return `${wid}/${key}`;}
 private staging(wid:string,uploadId:string){demand(UUID.test(wid)&&UUID.test(uploadId),'INVALID_OBJECT','Invalid upload identity.');return `staging/${wid}/${uploadId}`;}
 private async request<T>(path:string,init:RequestInit,consume:(response:Response)=>Promise<T>):Promise<T>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30_000);timer.unref();
  try{
   const response=await this.fetcher(`${this.origin}/storage/v1/${path}`,{...init,headers:{authorization:`Bearer ${this.serviceKey}`,apikey:this.serviceKey,...init.headers},redirect:'error',signal:abort.signal});
   demand(!response.redirected&&!(response.status>=300&&response.status<400),'STORAGE_UNAVAILABLE','Storage redirect rejected.',503);
   return await consume(response);
  }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('STORAGE_UNAVAILABLE','Private storage request failed.',503);}
  finally{clearTimeout(timer);abort.abort();}
 }
 private status(response:Response){demand(response.ok,'STORAGE_UNAVAILABLE','Private storage request failed.',503);}
 private async *body(response:Response,limit:number):AsyncGenerator<Buffer>{
  ceiling(limit);this.status(response);
  const declared=response.headers.get('content-length');
  if(declared!==null)demand(/^\d+$/.test(declared)&&Number(declared)<=limit,'BYTE_LIMIT','Stored source exceeds its byte ceiling.',413);
  demand(response.body,'STORAGE_UNAVAILABLE','Private storage returned no body.',503);
  const reader=response.body.getReader();let size=0,complete=false;
  try{while(true){const item=await reader.read();if(item.done){complete=true;break;}size+=item.value.byteLength;demand(size<=limit,'BYTE_LIMIT','Stored source exceeds its byte ceiling.',413);yield Buffer.from(item.value);}
   if(declared!==null)demand(size===Number(declared),'ARTIFACT_CORRUPT','Stored artifact size mismatch.');
  }finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 private async json(response:Response){const parts:Buffer[]=[];for await(const part of this.body(response,64*1024))parts.push(part);try{return JSON.parse(Buffer.concat(parts).toString()) as Record<string,unknown>;}catch{throw new DomainError('STORAGE_UNAVAILABLE','Invalid storage response.',503);}}
 private async *download(path:string,limit:number,expectedHash?:string,bucket=this.bucket):AsyncGenerator<Buffer>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30_000);timer.unref();
  try{
   const response=await this.fetcher(`${this.origin}/storage/v1/object/${bucket}/${path}`,{method:'GET',headers:{authorization:`Bearer ${this.serviceKey}`,apikey:this.serviceKey},redirect:'error',signal:abort.signal});
   demand(!response.redirected&&!(response.status>=300&&response.status<400),'STORAGE_UNAVAILABLE','Storage redirect rejected.',503);
   const hasher=createHash('sha256');
   for await(const part of this.body(response,limit)){hasher.update(part);yield part;}
   if(expectedHash)demand(hasher.digest('hex')===expectedHash,'ARTIFACT_CORRUPT','Stored artifact hash mismatch.');
  }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('STORAGE_UNAVAILABLE','Private storage request failed.',503);}
  finally{clearTimeout(timer);abort.abort();}
 }
 private async checkBucket(id:string,uploadLimit=false){return this.request(`bucket/${id}`,{method:'GET'},async response=>{
  const bucket=await this.json(response);demand(bucket.id===id&&bucket.public===false,'UNSAFE_STORAGE','Storage bucket must exist and remain private.',503);
  if(uploadLimit)demand(typeof bucket.file_size_limit==='number'&&Number.isSafeInteger(bucket.file_size_limit)&&bucket.file_size_limit>0&&bucket.file_size_limit<=MAX_UPLOAD,'UNSAFE_STORAGE','Upload bucket requires a finite upload size ceiling.',503);
  const declared=bucket.file_size_limit;
  demand(declared===undefined||declared===null||(typeof declared==='number'&&Number.isSafeInteger(declared)&&declared>0),'UNSAFE_STORAGE','Storage bucket has an invalid file size ceiling.',503);
  return typeof declared==='number'?Math.min(declared,MAX_READ):MAX_READ;
 });}
 async health(){await this.ready();}
 // Recheck immediately before operations: provider bucket visibility can change
 // independently of an application instance's lifetime.
 private async ready(){const durableLimit=await this.checkBucket(this.bucket);if(this.uploadBucket!==this.bucket||this.enforceUploadLimit)await this.checkBucket(this.uploadBucket,this.enforceUploadLimit);return durableLimit;}
 async put(wid:string,bytes:Buffer){
  demand(bytes.length<=MAX_READ,'BYTE_LIMIT','Stored object exceeds its byte ceiling.',413);const key=digest(bytes),path=this.identity(wid,key),bucketLimit=await this.ready();
  demand(bytes.length<=bucketLimit,'BYTE_LIMIT','Stored object exceeds the storage bucket file size limit.',413);
  await this.request(`object/${this.bucket}/${path}`,{method:'POST',headers:{'content-type':'application/octet-stream','x-upsert':'false'},body:new Uint8Array(bytes)},async response=>{
   if(response.ok){await response.body?.cancel();return;}
   // Supabase returns 400 for an existing object; 409 is also accepted only
   // after the immutable existing bytes have independently passed their hash.
   if(response.status===400||response.status===409){await response.body?.cancel();let size=0;for await(const part of this.readStream(wid,key,MAX_READ))size+=part.length;demand(size===bytes.length,'ARTIFACT_CORRUPT','Existing object size mismatch.');return;}
   this.status(response);
  });return {key,sha256:key,size_bytes:bytes.length};
 }
 async putStream(wid:string,input:AsyncIterable<Uint8Array>,limit=MAX_UPLOAD){
  ceiling(limit,MAX_UPLOAD);demand(UUID.test(wid),'INVALID_OBJECT','Invalid workspace identity.');const parts:Buffer[]=[];let size=0;
  for await(const chunk of input){size+=chunk.byteLength;demand(size<=limit,'BYTE_LIMIT','Source upload exceeds policy.',413);parts.push(Buffer.from(chunk));}
  return this.put(wid,Buffer.concat(parts,size));
 }
 async *readStream(wid:string,key:string,limit=50*1024*1024):AsyncGenerator<Buffer>{
  ceiling(limit);const path=this.identity(wid,key);await this.ready();
  // Private parser input only: drain to EOF before committing derived evidence.
  yield* this.download(path,limit,key);
 }
 async read(wid:string,key:string){const parts:Buffer[]=[];for await(const part of this.readStream(wid,key,MAX_READ))parts.push(part);return Buffer.concat(parts);}
 private async removePath(path:string,bucket=this.bucket){await this.ready();return this.request(`object/${bucket}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({prefixes:[path]})},async response=>{this.status(response);await response.body?.cancel();return {removed:true};});}
 async remove(wid:string,key:string){return this.removePath(this.identity(wid,key));}
 async createUpload(wid:string,uploadId:string){
  const path=this.staging(wid,uploadId);await this.ready();return this.request(`object/upload/sign/${this.uploadBucket}/${path}`,{method:'POST',headers:{'content-type':'application/json','x-upsert':'false'},body:'{}'},async response=>{
   const data=await this.json(response);demand(typeof data.url==='string','STORAGE_UNAVAILABLE','Invalid signed upload response.',503);
   let url:URL;try{url=new URL(`${this.origin}/storage/v1${data.url}`);}catch{throw new DomainError('STORAGE_UNAVAILABLE','Invalid signed upload response.',503);}
   const token=url.searchParams.get('token');demand(url.origin===this.origin&&!url.hash&&!url.username&&!url.password&&url.pathname===`/storage/v1/object/upload/sign/${this.uploadBucket}/${path}`&&token&&url.searchParams.size===1,'STORAGE_UNAVAILABLE','Signed upload scope mismatch.',503);
   return {url:url.href,token,path};
  });
 }
 async *readUpload(wid:string,uploadId:string,limit:number):AsyncGenerator<Buffer>{
  ceiling(limit,MAX_UPLOAD);const path=this.staging(wid,uploadId);await this.ready();
  yield* this.download(path,limit,undefined,this.uploadBucket);
 }
 async removeUpload(wid:string,uploadId:string){return this.removePath(this.staging(wid,uploadId),this.uploadBucket);}
}
