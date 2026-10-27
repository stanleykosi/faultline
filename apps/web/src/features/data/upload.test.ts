import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadSource} from './upload';
const base='/api/v1/workspaces/w/cases/c',file=new File(['synthetic'],'data.jsonl'),args={base,file,kind:'analytics' as const,sourceId:'source-1',contentHash:'a'.repeat(64),csrf:'synthetic-csrf',idempotencyKey:'synthetic-command'};
const reply=(data:unknown)=>new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
test('multipart host retains normal file import and source identity',async()=>{
 const original=globalThis.fetch;const calls:{url:string;init?:RequestInit}[]=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return calls.length===1?reply({mode:'multipart',max_bytes:52428800}):reply({id:'import-1'});};
 try{assert.equal((await uploadSource(args)).id,'import-1');assert.equal(calls[1]!.url,base+'/imports');const body=calls[1]!.init!.body as FormData;assert.equal(body.get('source_id'),'source-1');assert.equal(body.get('kind'),'analytics');assert.equal((body.get('file') as File).name,'data.jsonl');}finally{globalThis.fetch=original;}
});
test('direct upload sends no app cookies or CSRF to storage and accepts only verified receipt',async()=>{
 const original=globalThis.fetch;const calls:{url:string;init?:RequestInit}[]=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});switch(calls.length){case 1:return reply({mode:'direct',max_bytes:52428800});case 2:return reply({upload_url:'https://synthetic.supabase.co/storage/v1/object/upload/sign/private/staging/w/id?token=synthetic',token:'signed-receipt',method:'PUT'});case 3:return new Response('',{status:409});default:return reply({id:'verified-import'});}};
 try{assert.equal((await uploadSource(args)).id,'verified-import');assert.equal(calls[2]!.init!.credentials,'omit');assert.equal(new Headers(calls[2]!.init!.headers).get('x-csrf-token'),null);assert.equal(new Headers(calls[2]!.init!.headers).get('authorization'),null);assert.equal(calls[3]!.url,base+'/uploads/accept');assert.deepEqual(JSON.parse(String(calls[3]!.init!.body)),{token:'signed-receipt'});}finally{globalThis.fetch=original;}
});
test('unsafe upload destination fails before transferring the file',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>++calls===1?reply({mode:'direct',max_bytes:52428800}):reply({upload_url:'https://foreign.invalid/storage/v1/object/upload/sign/x',token:'x',method:'PUT'});
 try{await assert.rejects(()=>uploadSource(args));assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
test('completed upload retry returns its existing import without retransferring bytes',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>++calls===1?reply({mode:'direct',max_bytes:52428800}):reply({completed_import:{id:'original-import'}});
 try{assert.equal((await uploadSource(args)).id,'original-import');assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
