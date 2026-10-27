import {resource} from '../../api';
import type {ImportRecord,RecordKind} from './types';

/** The application authorizes storage scope, then independently verifies bytes before staging an import. */
export async function uploadSource({base,csrf,file,kind,sourceId,contentHash,idempotencyKey}:{base:string;csrf:string;file:File;kind:RecordKind;sourceId:string;contentHash:string;idempotencyKey:string}):Promise<ImportRecord>{
 const options=await resource<{mode:'direct'|'multipart';max_bytes:number}>(`${base}/upload-options`);
 if(!options||!['direct','multipart'].includes(options.mode)||file.size>options.max_bytes)throw Error('This file exceeds the current upload limit.');
 if(options.mode==='multipart'){
  const body=new FormData();body.set('kind',kind);if(sourceId)body.set('source_id',sourceId);body.set('file',file);
  return resource<ImportRecord>(`${base}/imports`,{method:'POST',csrf,body,idempotencyKey});
 }
 const prepare=await resource<{upload_url:string;token:string;method:string;headers:Record<string,string>;completed_import?:ImportRecord|null}>(`${base}/uploads`,{method:'POST',csrf,idempotencyKey,body:{kind,...(sourceId?{source_id:sourceId}:{}),name:file.name,sha256:contentHash,size_bytes:file.size}});
 if(prepare.completed_import)return prepare.completed_import;
 const url=new URL(prepare.upload_url);
 if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')&&!url.hostname.endsWith('.supabase.in')&&!url.hostname.endsWith('.supabase.red')||url.username||url.password||prepare.method!=='PUT'||!url.pathname.startsWith('/storage/v1/object/upload/sign/'))throw Error('The upload destination is unavailable.');
 const uploaded=await fetch(url.href,{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120_000)});
 // A previous attempt may have uploaded successfully but lost its response. Acceptance verifies the exact bytes.
 if(!uploaded.ok&&![400,409].includes(uploaded.status))throw Error('The file could not be uploaded. Try again.');
 return resource<ImportRecord>(`${base}/uploads/accept`,{method:'POST',csrf,idempotencyKey:'accept:'+idempotencyKey,body:{token:prepare.token}});
}
