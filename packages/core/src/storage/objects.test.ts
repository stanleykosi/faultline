import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {PrivateObjects} from './objects.js';
import {DomainError} from '../errors.js';
import {SupabaseObjects} from './supabase-objects.js';
import {planStorageReconciliation} from './reconciliation.js';

// objects
{
 const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;
 const consume=async(input:AsyncIterable<Buffer>)=>{const parts:Buffer[]=[];for await(const part of input)parts.push(part);return Buffer.concat(parts);};
 async function fixture(){const root=path.resolve('.runtime/acceptance/object-stream-'+randomUUID()),wid=randomUUID(),objects=new PrivateObjects(root);await fs.mkdir(root,{recursive:true});return{root,wid,objects};}
 
 test("local immutable objects preserve exact bytes, verify EOF and reject corruption", async () => {
  // stored stream preserves original binary bytes with bounded chunks and verified EOF
  {
   const {wid,objects}=await fixture(),bytes=Buffer.alloc(196613);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
     const stored=await objects.put(wid,bytes),parts:Buffer[]=[];for await(const chunk of objects.readStream(wid,stored.key,bytes.length)){assert.ok(chunk.length<=65536);parts.push(chunk);}
     assert.ok(parts.length>1);assert.deepEqual(Buffer.concat(parts),bytes);
     await assert.rejects(consume(objects.readStream(wid,stored.key,bytes.length-1)),code('BYTE_LIMIT'));
     for(const limit of [0,-1,NaN,Infinity,1.5,256*1024*1024+1])await assert.rejects(consume(objects.readStream(wid,stored.key,limit)),code('BYTE_LIMIT'));
  }
  // same-length corruption and truncation cannot complete an authenticated stream
  {
   const {root,wid,objects}=await fixture(),original=Buffer.from('independent original bytes'),stored=await objects.put(wid,original),file=path.join(root,wid,stored.key);
     const altered=Buffer.from(original);altered[0]=altered[0]!^1;await fs.writeFile(file,altered);
     await assert.rejects(consume(objects.readStream(wid,stored.key)),code('ARTIFACT_CORRUPT'));
     await fs.writeFile(file,original.subarray(0,original.length-1));await assert.rejects(consume(objects.readStream(wid,stored.key)),code('ARTIFACT_CORRUPT'));
  }
  // early iterator return closes the file and subsequent complete reads remain valid
  {
   const {root,wid,objects}=await fixture(),bytes=Buffer.alloc(196608,73),stored=await objects.put(wid,bytes),iterator=objects.readStream(wid,stored.key);
     assert.equal((await iterator.next()).value?.length,65536);assert.equal((await iterator.return(undefined)).done,true);
     const file=path.join(root,wid,stored.key),moved=file+'.closure-proof';await fs.rename(file,moved);await fs.rename(moved,file);
     assert.deepEqual(await consume(objects.readStream(wid,stored.key)),bytes);
  }
  // empty immutable object validates at EOF and invalid identities fail before access
  {
   const {wid,objects}=await fixture(),stored=await objects.put(wid,Buffer.alloc(0));assert.equal((await consume(objects.readStream(wid,stored.key))).length,0);
     await assert.rejects(consume(objects.readStream('../escape',stored.key)),code('INVALID_OBJECT'));
     await assert.rejects(consume(objects.readStream(wid,'../escape')),code('INVALID_OBJECT'));
  }
 });

}

// supabase objects
{
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
 
 test("durable object ceilings accept exact bounds and reject malformed or oversized writes", async () => {
  // durable bucket file ceiling rejects oversized writes before POST and accepts the exact limit
  {
   const {store,calls,objects}=fixture({fileLimit:4});
     await assert.rejects(store.put(wid,Buffer.from('12345')),{code:'BYTE_LIMIT',status:413});
     await assert.rejects(store.putStream(wid,(async function*(){yield Buffer.from('12345');})(),10),{code:'BYTE_LIMIT',status:413});
     assert.equal(calls.filter(call=>call.init.method==='POST').length,0);assert.equal(objects.size,0);
     const bytes=Buffer.from('1234');assert.equal((await store.put(wid,bytes)).size_bytes,4);
     assert.deepEqual(await store.read(wid,hash(bytes)),bytes);
     assert.equal(calls.filter(call=>call.init.method==='POST').length,1);
  }
  // malformed declared durable file ceilings fail closed before any object POST
  {
   for(const fileLimit of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'4',false,{},[]]){
      const {store,calls}=fixture({fileLimit});
      await assert.rejects(store.put(wid,Buffer.from('x')),{code:'UNSAFE_STORAGE'});
      assert.equal(calls.filter(call=>call.init.method==='POST').length,0);
     }
  }
  // missing or null durable file ceiling retains the adapter hard ceiling
  {
   const overHardLimit=Buffer.allocUnsafe(256*1024*1024+1);
     for(const fileLimit of [undefined,null]){
      const {store,calls}=fixture({fileLimit});
      await store.health();
      const bytes=Buffer.from('fallback limit');assert.equal((await store.put(wid,bytes)).size_bytes,bytes.length);
      assert.equal(calls.filter(call=>call.init.method==='POST').length,1);
      await assert.rejects(store.put(wid,overHardLimit),{code:'BYTE_LIMIT',status:413});
     }
  }
 });

 test("remote objects reject corruption, public buckets, redirects and unbounded streams", async () => {
  // corrupt stored bytes and duplicate collision never become accepted evidence
  {
   const {store,objects}=fixture({corrupt:true}),bytes=Buffer.from('expected');objects.set(`${wid}/${hash(bytes)}`,bytes);
     await assert.rejects(store.read(wid,hash(bytes)),{code:'ARTIFACT_CORRUPT'});
     await assert.rejects(store.put(wid,bytes),{code:'ARTIFACT_CORRUPT'});
  }
  // public buckets fail closed before writes; redirects and provider details are not exposed
  {
   const publicFixture=fixture({public:true});await assert.rejects(publicFixture.store.put(wid,Buffer.from('x')),{code:'UNSAFE_STORAGE'});assert.equal(publicFixture.calls.length,1);
     await assert.rejects(fixture({redirect:true}).store.read(wid,'0'.repeat(64)),{code:'STORAGE_UNAVAILABLE'});
     await assert.rejects(fixture().store.read(wid,'0'.repeat(64)),error=>error instanceof Error&&!error.message.includes(secret));
     const store=new SupabaseObjects({url:origin,bucket,serviceKey:secret,fetch:async()=>{throw new Error(secret);}});
     await assert.rejects(store.health(),error=>error instanceof Error&&!error.message.includes(secret));
  }
  // bounded streams reject oversized, infinite ceilings and truncated declarations
  {
   const {store,objects}=fixture(),bytes=Buffer.from('12345');objects.set(`${wid}/${hash(bytes)}`,bytes);
     await assert.rejects(async()=>{for await(const _ of store.readStream(wid,hash(bytes),4)){}},{code:'BYTE_LIMIT'});
     await assert.rejects(store.putStream(wid,(async function*(){yield bytes;})(),4),{code:'BYTE_LIMIT'});
     await assert.rejects(store.putStream(wid,(async function*(){yield bytes;})(),Infinity),{code:'BYTE_LIMIT'});
     await assert.rejects(store.putStream(wid,(async function*(){yield bytes;})(),51*1024*1024),{code:'BYTE_LIMIT'});
     const truncated=new SupabaseObjects({url:origin,bucket,serviceKey:secret,fetch:async(input)=>String(input).includes('/bucket/')?json({id:bucket,public:false}):new Response(new Uint8Array(bytes),{headers:{'content-length':'7'}})});
     await assert.rejects(truncated.read(wid,hash(bytes)),{code:'ARTIFACT_CORRUPT'});
  }
 });

 test("remote staging signatures bind safe configuration and exact immutable scope", async () => {
  // signed uploads use immutable generated staging path and reject scope changes
  {
   const {store,calls,objects}=fixture(),signed=await store.createUpload(wid,uid);
     assert.deepEqual(signed,{url:`${origin}/storage/v1/object/upload/sign/${bucket}/staging/${wid}/${uid}?token=synthetic-token`,token:'synthetic-token',path:`staging/${wid}/${uid}`});
     const request=calls.at(-1)!;assert.equal(request.init.method,'POST');assert.equal(request.init.body,'{}');assert.equal(new Headers(request.init.headers).get('x-upsert'),'false');
     objects.set(signed.path,Buffer.from('upload'));const chunks=[];for await(const chunk of store.readUpload(wid,uid,20))chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'upload');await store.removeUpload(wid,uid);assert.equal(objects.size,0);
     await assert.rejects(fixture({sign:`/object/upload/sign/${bucket}/staging/other/${uid}?token=x`}).store.createUpload(wid,uid),{code:'STORAGE_UNAVAILABLE'});
     await assert.rejects(store.createUpload(wid,'../escape'),{code:'INVALID_OBJECT'});
  }
  // configuration rejects insecure origins, paths and invalid bucket identities
  {
   for(const url of ['http://project.supabase.co','https://project.supabase.co/path','https://project.supabase.co?x=1','https://supabase.co.attacker.invalid'])assert.throws(()=>new SupabaseObjects({url,bucket,serviceKey:secret}),{code:'INVALID_STORAGE_CONFIG'});
     assert.throws(()=>new SupabaseObjects({url:origin,bucket:'../public',serviceKey:secret}),{code:'INVALID_STORAGE_CONFIG'});
  }
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
 test("staging buckets remain private, bounded and distinct from durable evidence", async () => {
  // separate staging bucket signs, reads and removes only staging objects, preserving durable evidence
  {
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
  }
  // explicit staging bucket must be private and enforce a numeric finite upload ceiling
  {
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
  }
  // bucket privacy is freshly checked before each write or signing operation
  {
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
  }
 });

}

// reconciliation
{
 test('offline reconciliation restores missing accounting only from verified bytes and preserves ambiguous orphan reservations',()=>{
  const cid=randomUUID(),other=randomUUID(),a='a'.repeat(64),b='b'.repeat(64),inventory=[{key:a,sha256:a,size_bytes:20,kind:'object' as const},{key:b,sha256:b,size_bytes:30,kind:'object' as const}],refs=[{case_id:other,object_key:b,size_bytes:30}],durable=[{case_id:cid,object_key:a,size_bytes:20}],account={used_bytes:0,reserved_bytes:200,ceiling:1000};
  const complete=planStorageReconciliation(cid,inventory,refs,durable,account,[100,100]);assert.equal(complete.used_bytes,20);assert.equal(complete.reserved_bytes,0);assert.equal(complete.release_reservations,true);assert.deepEqual(complete.add_references,[{object_key:a,size_bytes:20}]);
  const partial={key:'.partial-'+randomUUID(),sha256:'c'.repeat(64),size_bytes:50,kind:'partial' as const},ambiguous=planStorageReconciliation(cid,[...inventory,partial],refs,durable,account,[100,100]);assert.equal(ambiguous.release_reservations,false);assert.equal(ambiguous.reserved_bytes,200);assert.equal(ambiguous.retained_unreferenced_bytes,50);assert.equal(ambiguous.retained_partial_count,1);
  assert.throws(()=>planStorageReconciliation(cid,[inventory[0]!],refs,durable,account,[]),/no verified/);assert.throws(()=>planStorageReconciliation(cid,inventory,refs,[{...durable[0]!,size_bytes:21}],account,[]),/length differs/);assert.throws(()=>planStorageReconciliation(cid,[...inventory,partial],refs,durable,{...account,ceiling:100},[200]),/budget/);assert.equal(refs.length,1);assert.equal(inventory.length,2);
 });
}
