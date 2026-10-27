import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SupabaseObjects} from './supabase-objects.js';

const wid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',uid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const origin='https://project.supabase.co',bucket='evidence',secret='synthetic-service-only';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function fixture(options:{public?:boolean;corrupt?:boolean;redirect?:boolean;sign?:string;fileLimit?:unknown}={}){
 const calls:{url:URL;init:RequestInit}[]=[],objects=new Map<string,Buffer>();
 const fetcher:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input));calls.push({url,init});assert.equal(url.origin,origin);assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${secret}`);
  if(url.pathname===`/storage/v1/bucket/${bucket}`)return json({id:bucket,public:options.public??false,file_size_limit:options.fileLimit});
  if(options.redirect)return new Response(null,{status:302,headers:{location:'https://elsewhere.invalid'}});
  if(url.pathname.includes('/object/upload/sign/'))return json({url:options.sign??`/object/upload/sign/${bucket}/staging/${wid}/${uid}?token=synthetic-token`});
  if(init.method==='DELETE'){const body=JSON.parse(String(init.body));assert.equal(body.prefixes.length,1);objects.delete(body.prefixes[0]);return json([]);}
  const path=url.pathname.slice(`/storage/v1/object/${bucket}/`.length);
  if(init.method==='POST'){if(objects.has(path))return json({message:'already exists'},400);objects.set(path,Buffer.from(init.body as Uint8Array));return json({Key:path});}
  const bytes=objects.get(path);if(!bytes)return json({message:secret},404);return new Response(new Uint8Array(options.corrupt?Buffer.from('wrong bytes'):bytes));
 };
 const store=new SupabaseObjects({url:origin,bucket,serviceKey:secret,fetch:fetcher});return {store,calls,objects};
}

test('private immutable objects use exact workspace scope, preserve bytes and deduplicate concurrent writes',async()=>{
 const {store,calls,objects}=fixture(),bytes=Buffer.from('independent evidence');
 const results=await Promise.all([store.put(wid,bytes),store.put(wid,bytes)]);
 assert.deepEqual(results[0],{key:hash(bytes),sha256:hash(bytes),size_bytes:bytes.length});assert.deepEqual(results[0],results[1]);
 assert.equal(objects.size,1);assert.deepEqual(await store.read(wid,hash(bytes)),bytes);
 const posts=calls.filter(call=>call.init.method==='POST');assert.equal(posts.length,2);assert.equal(new Headers(posts[0]!.init.headers).get('x-upsert'),'false');
 assert.equal(posts[0]!.url.pathname,`/storage/v1/object/${bucket}/${wid}/${hash(bytes)}`);
 await store.remove(wid,hash(bytes));assert.equal(objects.size,0);
});

test('durable bucket file ceiling rejects oversized writes before POST and accepts the exact limit',async()=>{
 const {store,calls,objects}=fixture({fileLimit:4});
 await assert.rejects(store.put(wid,Buffer.from('12345')),{code:'BYTE_LIMIT',status:413});
 await assert.rejects(store.putStream(wid,(async function*(){yield Buffer.from('12345');})(),10),{code:'BYTE_LIMIT',status:413});
 assert.equal(calls.filter(call=>call.init.method==='POST').length,0);assert.equal(objects.size,0);
 const bytes=Buffer.from('1234');assert.equal((await store.put(wid,bytes)).size_bytes,4);
 assert.deepEqual(await store.read(wid,hash(bytes)),bytes);
 assert.equal(calls.filter(call=>call.init.method==='POST').length,1);
});

test('malformed declared durable file ceilings fail closed before any object POST',async()=>{
 for(const fileLimit of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'4',false,{},[]]){
  const {store,calls}=fixture({fileLimit});
  await assert.rejects(store.put(wid,Buffer.from('x')),{code:'UNSAFE_STORAGE'});
  assert.equal(calls.filter(call=>call.init.method==='POST').length,0);
 }
});

test('missing or null durable file ceiling retains the adapter hard ceiling',async()=>{
 const overHardLimit=Buffer.allocUnsafe(256*1024*1024+1);
 for(const fileLimit of [undefined,null]){
  const {store,calls}=fixture({fileLimit});
  await store.health();
  const bytes=Buffer.from('fallback limit');assert.equal((await store.put(wid,bytes)).size_bytes,bytes.length);
  assert.equal(calls.filter(call=>call.init.method==='POST').length,1);
  await assert.rejects(store.put(wid,overHardLimit),{code:'BYTE_LIMIT',status:413});
 }
});
test('corrupt stored bytes and duplicate collision never become accepted evidence',async()=>{
 const {store,objects}=fixture({corrupt:true}),bytes=Buffer.from('expected');objects.set(`${wid}/${hash(bytes)}`,bytes);
 await assert.rejects(store.read(wid,hash(bytes)),{code:'ARTIFACT_CORRUPT'});
 await assert.rejects(store.put(wid,bytes),{code:'ARTIFACT_CORRUPT'});
});
test('public buckets fail closed before writes; redirects and provider details are not exposed',async()=>{
 const publicFixture=fixture({public:true});await assert.rejects(publicFixture.store.put(wid,Buffer.from('x')),{code:'UNSAFE_STORAGE'});assert.equal(publicFixture.calls.length,1);
 await assert.rejects(fixture({redirect:true}).store.read(wid,'0'.repeat(64)),{code:'STORAGE_UNAVAILABLE'});
 await assert.rejects(fixture().store.read(wid,'0'.repeat(64)),error=>error instanceof Error&&!error.message.includes(secret));
 const store=new SupabaseObjects({url:origin,bucket,serviceKey:secret,fetch:async()=>{throw new Error(secret);}});
 await assert.rejects(store.health(),error=>error instanceof Error&&!error.message.includes(secret));
});
test('bounded streams reject oversized, infinite ceilings and truncated declarations',async()=>{
 const {store,objects}=fixture(),bytes=Buffer.from('12345');objects.set(`${wid}/${hash(bytes)}`,bytes);
 await assert.rejects(async()=>{for await(const _ of store.readStream(wid,hash(bytes),4)){}},{code:'BYTE_LIMIT'});
 await assert.rejects(store.putStream(wid,(async function*(){yield bytes;})(),4),{code:'BYTE_LIMIT'});
 await assert.rejects(store.putStream(wid,(async function*(){yield bytes;})(),Infinity),{code:'BYTE_LIMIT'});
 await assert.rejects(store.putStream(wid,(async function*(){yield bytes;})(),51*1024*1024),{code:'BYTE_LIMIT'});
 const truncated=new SupabaseObjects({url:origin,bucket,serviceKey:secret,fetch:async(input)=>String(input).includes('/bucket/')?json({id:bucket,public:false}):new Response(new Uint8Array(bytes),{headers:{'content-length':'7'}})});
 await assert.rejects(truncated.read(wid,hash(bytes)),{code:'ARTIFACT_CORRUPT'});
});
test('signed uploads use immutable generated staging path and reject scope changes',async()=>{
 const {store,calls,objects}=fixture(),signed=await store.createUpload(wid,uid);
 assert.deepEqual(signed,{url:`${origin}/storage/v1/object/upload/sign/${bucket}/staging/${wid}/${uid}?token=synthetic-token`,token:'synthetic-token',path:`staging/${wid}/${uid}`});
 const request=calls.at(-1)!;assert.equal(request.init.method,'POST');assert.equal(request.init.body,'{}');assert.equal(new Headers(request.init.headers).get('x-upsert'),'false');
 objects.set(signed.path,Buffer.from('upload'));const chunks=[];for await(const chunk of store.readUpload(wid,uid,20))chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'upload');await store.removeUpload(wid,uid);assert.equal(objects.size,0);
 await assert.rejects(fixture({sign:`/object/upload/sign/${bucket}/staging/other/${uid}?token=x`}).store.createUpload(wid,uid),{code:'STORAGE_UNAVAILABLE'});
 await assert.rejects(store.createUpload(wid,'../escape'),{code:'INVALID_OBJECT'});
});
test('configuration rejects insecure origins, paths and invalid bucket identities',()=>{
 for(const url of ['http://project.supabase.co','https://project.supabase.co/path','https://project.supabase.co?x=1','https://supabase.co.attacker.invalid'])assert.throws(()=>new SupabaseObjects({url,bucket,serviceKey:secret}),{code:'INVALID_STORAGE_CONFIG'});
 assert.throws(()=>new SupabaseObjects({url:origin,bucket:'../public',serviceKey:secret}),{code:'INVALID_STORAGE_CONFIG'});
});
test('stream consumers must reach EOF for hash validation and early return cancels provider body',async()=>{
 let cancelled=false;
 const bytes=Buffer.from('separate oracle'),key=hash(bytes);
 const store=new SupabaseObjects({url:origin,bucket,serviceKey:secret,fetch:async(input)=>String(input).includes('/bucket/')?json({id:bucket,public:false}):new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(bytes));},cancel(){cancelled=true;}}))});
 for await(const chunk of store.readStream(wid,key)){assert.deepEqual(chunk,bytes);break;}
 assert.equal(cancelled,true);
 const wrong=fixture({corrupt:true});wrong.objects.set(`${wid}/${key}`,bytes);let emitted=false;
 await assert.rejects(async()=>{for await(const _ of wrong.store.readStream(wid,key))emitted=true;},{code:'ARTIFACT_CORRUPT'});
 assert.equal(emitted,true,'stream only establishes integrity at EOF');
});
test('separate staging bucket signs, reads and removes only staging objects, preserving durable evidence',async()=>{
 const uploadBucket='incoming',calls:{url:URL;init:RequestInit}[]=[],objects=new Map<string,Buffer>();
 const store=new SupabaseObjects({url:origin,bucket,uploadBucket,serviceKey:secret,fetch:async(input,init={})=>{
  const url=new URL(String(input));calls.push({url,init});
  if(url.pathname===`/storage/v1/bucket/${bucket}`)return json({id:bucket,public:false,file_size_limit:256*1024*1024});
  if(url.pathname===`/storage/v1/bucket/${uploadBucket}`)return json({id:uploadBucket,public:false,file_size_limit:50*1024*1024});
  if(url.pathname===`/storage/v1/object/upload/sign/${uploadBucket}/staging/${wid}/${uid}`)return json({url:`/object/upload/sign/${uploadBucket}/staging/${wid}/${uid}?token=staging-only`});
  if(init.method==='DELETE'){assert.equal(url.pathname,`/storage/v1/object/${uploadBucket}`);const value=JSON.parse(String(init.body));assert.deepEqual(value,{prefixes:[`staging/${wid}/${uid}`]});objects.delete(`${uploadBucket}/${value.prefixes[0]}`);return json([]);}
  const object=url.pathname.slice('/storage/v1/object/'.length);
  if(init.method==='POST'){assert.ok(object.startsWith(`${bucket}/${wid}/`));objects.set(object,Buffer.from(init.body as Uint8Array));return json({Key:object});}
  assert.equal(init.method,'GET');assert.ok(object.startsWith(`${uploadBucket}/staging/${wid}/`));return new Response(new Uint8Array(objects.get(object)!));
 }});
 const durable=await store.put(wid,Buffer.from('retained evidence'));const signed=await store.createUpload(wid,uid);
 assert.equal(signed.url,`${origin}/storage/v1/object/upload/sign/incoming/staging/${wid}/${uid}?token=staging-only`);
 objects.set(`incoming/staging/${wid}/${uid}`,Buffer.from('staged evidence'));
 const chunks=[];for await(const chunk of store.readUpload(wid,uid,100))chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'staged evidence');
 await store.removeUpload(wid,uid);assert.equal(objects.size,1);assert.equal(objects.get(`${bucket}/${wid}/${durable.key}`)?.toString(),'retained evidence');
 const sign=calls.find(call=>call.url.pathname.includes('/upload/sign/'))!;assert.equal(new Headers(sign.init.headers).get('x-upsert'),'false');
});
test('explicit staging bucket must be private and enforce a numeric finite upload ceiling',async()=>{
 for(const metadata of [{public:true,file_size_limit:50*1024*1024},{public:false},{public:false,file_size_limit:null},{public:false,file_size_limit:0},{public:false,file_size_limit:-1},{public:false,file_size_limit:50*1024*1024+1},{public:false,file_size_limit:'52428800'}]){
  let writes=0;
  const store=new SupabaseObjects({url:origin,bucket,uploadBucket:'incoming',serviceKey:secret,fetch:async(input,init={})=>{
   if(init.method!=='GET'){writes++;return json({});}
   return String(input).endsWith('/bucket/evidence')?json({id:bucket,public:false}):json({id:'incoming',...metadata});
  }});
  await assert.rejects(store.health(),{code:'UNSAFE_STORAGE'});
  await assert.rejects(store.createUpload(wid,uid),{code:'UNSAFE_STORAGE'});
  await assert.rejects(store.put(wid,Buffer.from('private evidence')),{code:'UNSAFE_STORAGE'});
  assert.equal(writes,0);
 }
 assert.throws(()=>new SupabaseObjects({url:origin,bucket,uploadBucket:'../incoming',serviceKey:secret}),{code:'INVALID_STORAGE_CONFIG'});
});
test('bucket privacy is freshly checked before each write or signing operation',async()=>{
 let durablePublic=false,stagingPublic=false,writes=0;
 const store=new SupabaseObjects({url:origin,bucket,uploadBucket:'incoming',serviceKey:secret,fetch:async(input,init={})=>{
  const url=String(input);
  if(url.endsWith('/bucket/evidence'))return json({id:bucket,public:durablePublic});
  if(url.endsWith('/bucket/incoming'))return json({id:'incoming',public:stagingPublic,file_size_limit:50*1024*1024});
  writes++;return url.includes('/upload/sign/')?json({url:`/object/upload/sign/incoming/staging/${wid}/${uid}?token=bound`}):json({});
 }});
 await store.put(wid,Buffer.from('before visibility change'));assert.equal(writes,1);
 durablePublic=true;await assert.rejects(store.put(wid,Buffer.from('must never be uploaded')),{code:'UNSAFE_STORAGE'});assert.equal(writes,1);
 durablePublic=false;await store.createUpload(wid,uid);assert.equal(writes,2);
 stagingPublic=true;await assert.rejects(store.createUpload(wid,uid),{code:'UNSAFE_STORAGE'});assert.equal(writes,2);
});
