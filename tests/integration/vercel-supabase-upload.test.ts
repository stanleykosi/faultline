import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

test('isolated Supabase-profile API identity and large direct upload acceptance',{
  skip:process.env.FAULTLINE_SUPABASE_ACCEPTANCE_FIXTURE!=='generated-cluster',timeout:90_000,
},async()=>{
  const storage=new Map<string,Buffer>(),requests:{method:string;path:string;bytes:number}[]=[];
  let failDownload=false,failCleanup=false;
  const originalFetch=globalThis.fetch;
  const syntheticFetch:typeof fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    assert.equal(url.origin,'https://synthetic.supabase.co','the fixture must never contact another origin');
    const method=init.method??'GET',key=url.pathname.replace('/storage/v1/object/','');
    const body=init.body instanceof Uint8Array?Buffer.from(init.body):typeof init.body==='string'?Buffer.from(init.body):Buffer.alloc(0);
    requests.push({method,path:url.pathname,bytes:body.length});
    if(url.pathname.startsWith('/storage/v1/bucket/')){
      const id=url.pathname.split('/').at(-1)!;
      return Response.json({id,public:false,file_size_limit:id==='synthetic-uploads'?50*1024*1024:256*1024*1024});
    }
    if(url.pathname.includes('/object/upload/sign/')){
      if(method==='POST')return Response.json({url:url.pathname.replace('/storage/v1','')+'?token=synthetic-fixture-upload-token'});
      assert.equal(method,'PUT');assert.equal(url.searchParams.get('token'),'synthetic-fixture-upload-token');
      const identity=url.pathname.split('/object/upload/sign/')[1]!;
      if(storage.has(identity))return Response.json({message:'Already exists'},{status:400});
      storage.set(identity,body);return Response.json({Key:identity});
    }
    if(method==='POST'){
      if(storage.has(key))return Response.json({message:'Already exists'},{status:400});
      storage.set(key,body);return Response.json({Key:key});
    }
    if(method==='GET'){
      if(failDownload){failDownload=false;return Response.json({message:'Synthetic temporary outage'},{status:503});}
      const bytes=storage.get(key);return bytes?new Response(new Uint8Array(bytes),{headers:{'content-length':String(bytes.length)}}):new Response(null,{status:404});
    }
    if(method==='DELETE'){
      if(failCleanup){failCleanup=false;return Response.json({message:'Synthetic cleanup outage'},{status:503});}
      const input=JSON.parse(body.toString()) as {prefixes:string[]};
      for(const prefix of input.prefixes)storage.delete(key+'/'+prefix);
      return Response.json([]);
    }
    throw new Error('Unexpected synthetic storage operation');
  };
  globalThis.fetch=syntheticFetch;
  const {buildServer}=await import('../../apps/api/src/server.js');
  const {closeRuntimePools}=await import('../../packages/database/src/client.js');
  const app=await buildServer();
  app.addHook('onError',async(_request,_reply,error)=>{console.error('Synthetic API failure:',error.code,error.message);});
  const admin=new pg.Client({connectionString:process.env.SYNTHETIC_ASSERTION_DATABASE_URL});await admin.connect();
  let cookie='',csrf='';const origin='http://localhost:3000';
  const request=async(method:'GET'|'POST',url:string,payload?:unknown,extra:Record<string,string>={})=>app.inject({method,url,headers:{origin,cookie,'x-csrf-token':csrf,'idempotency-key':randomUUID(),...(payload===undefined?{}:{'content-type':'application/json'}),...extra},...(payload===undefined?{}:{payload:JSON.stringify(payload)})});
  const data=(response:Awaited<ReturnType<typeof request>>,status=200)=>{assert.equal(response.statusCode,status,response.body.slice(0,1000));return response.json().data;};
  const cookies=(response:Awaited<ReturnType<typeof request>>)=>{const values=response.headers['set-cookie'];cookie=(Array.isArray(values)?values:values?[values]:[]).map(value=>String(value).split(';')[0]).join('; ');};
  try{
    const email='analyst-'+randomUUID()+'@example.test',password='Synthetic-'+randomUUID()+'-only';
    const signup=await request('POST','/api/auth/sign-up/email',{email,password,name:'Synthetic analyst',workspace_name:'Synthetic signup workspace'});
    assert.equal(signup.statusCode,200,signup.body.slice(0,1000));
    const wrong=await request('POST','/api/auth/sign-in/email',{email,password:'Intentionally incorrect password'});assert.equal(wrong.statusCode,401);
    const login=await request('POST','/api/auth/sign-in/email',{email,password});assert.equal(login.statusCode,200,login.body.slice(0,1000));cookies(login);
    const session=data(await request('GET','/api/v1/session'));csrf=session.csrf_token;
    assert.equal(session.user.email,email);
    assert.ok(data(await request('GET','/api/v1/workspaces')).length>=1);
    const workspace=data(await request('POST','/api/v1/workspaces',{name:'Synthetic connected API workspace'}),201);
    const base='/api/v1/workspaces/'+workspace.id;
    const item=data(await request('POST',base+'/cases',{title:'Large import acceptance',question:'Can a reviewed direct import survive failure and retry?',affected_flow:'Synthetic checkout'}),201);
    const caseBase=base+'/cases/'+item.id;
    assert.equal(data(await request('GET',caseBase)).id,item.id);
    assert.equal(data(await request('GET',caseBase+'/upload-options')).mode,'direct');
    const bytes=Buffer.from(JSON.stringify({event_id:'synthetic-event',event_name:'checkout_started',session_id:'synthetic-session',occurred_at:'2026-10-20T00:00:00.000Z'})+'\n'+' '.repeat(5*1024*1024));
    assert.ok(bytes.length>4.5*1024*1024);
    const details={kind:'analytics',name:'synthetic-large.jsonl',sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length};
    const denied=await request('POST',caseBase+'/uploads',details,{'x-csrf-token':'incorrect'});assert.equal(denied.statusCode,403);
    const prepareKey=randomUUID();
    const upload=data(await request('POST',caseBase+'/uploads',details,{'idempotency-key':prepareKey}),201);
    assert.equal(Number((await admin.query('SELECT amount FROM faultline.storage_reservations WHERE id=$1',[upload.upload_id])).rows[0].amount),50*1024*1024,'signed capability reserves its full provider byte ceiling');
    const sent=await syntheticFetch(upload.upload_url,{method:'PUT',headers:upload.headers,body:new Uint8Array(bytes)});assert.equal(sent.status,200);
    assert.equal((await syntheticFetch(upload.upload_url,{method:'PUT',headers:upload.headers,body:new Uint8Array(bytes)})).status,400,'signed staging upload must be create-only');
    failDownload=true;
    assert.equal((await request('POST',caseBase+'/uploads/accept',{token:upload.token})).statusCode,503);
    const accepted=data(await request('POST',caseBase+'/uploads/accept',{token:upload.token}),201);
    assert.equal(accepted.raw_key,details.sha256);assert.equal(Number(accepted.raw_bytes),bytes.length);
    const duplicate=data(await request('POST',caseBase+'/uploads/accept',{token:upload.token}),201);assert.equal(duplicate.id,accepted.id);
    assert.equal(Number((await admin.query('SELECT amount FROM faultline.storage_reservations WHERE id=$1',[upload.upload_id])).rows[0].amount),bytes.length,'verified immutable staging shrinks its reservation to its actual byte count');
    const prepareReplay=data(await request('POST',caseBase+'/uploads',details,{'idempotency-key':prepareKey}),201);assert.equal(prepareReplay.completed_import.id,accepted.id);
    const forgedToken=upload.token.slice(0,-1)+(upload.token.endsWith('a')?'b':'a');
    assert.equal((await request('POST',caseBase+'/uploads/accept',{token:forgedToken})).statusCode,403);
    const mismatch=data(await request('POST',caseBase+'/uploads',{...details,sha256:'0'.repeat(64)}),201);
    assert.equal((await syntheticFetch(mismatch.upload_url,{method:'PUT',body:new Uint8Array(bytes)})).status,200);
    const mismatchResponse=await request('POST',caseBase+'/uploads/accept',{token:mismatch.token});
    assert.equal(mismatchResponse.statusCode,409,mismatchResponse.body);assert.equal(mismatchResponse.json().error.code,'UPLOAD_CONTENT_MISMATCH');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM faultline.imports WHERE case_id=$1',[item.id])).rows[0].count,1);
    const tiny=data(await request('POST',caseBase+'/uploads',{...details,name:'tiny.jsonl',size_bytes:1,sha256:createHash('sha256').update('x').digest('hex')}),201);
    assert.equal(Number((await admin.query('SELECT amount FROM faultline.storage_reservations WHERE id=$1',[tiny.upload_id])).rows[0].amount),50*1024*1024,'one declared byte cannot underreserve a 50MiB signed token');
    const {cleanExpiredDirectUploads}=await import('../../packages/core/src/captures/direct-uploads.js');
    await admin.query("UPDATE faultline.direct_uploads SET expires_at=now()-interval '4 hours',cleanup_after=now()-interval '1 hour' WHERE workspace_id=$1",[workspace.id]);
    failCleanup=true;
    await assert.rejects(cleanExpiredDirectUploads(workspace.id),(error:unknown)=>(error as {code?:string}).code==='STORAGE_UNAVAILABLE');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM faultline.storage_reservations WHERE id=ANY($1::uuid[])',[[upload.upload_id,mismatch.upload_id,tiny.upload_id]])).rows[0].count,3,'provider cleanup failure must retain quota reservations');
    for(let remaining=2;remaining>=0;remaining--){
      await cleanExpiredDirectUploads(workspace.id);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM faultline.direct_uploads WHERE workspace_id=$1 AND cleaned_at IS NULL',[workspace.id])).rows[0].count,remaining,'each bounded cleanup tick clears one staging reservation');
    }
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM faultline.direct_uploads WHERE workspace_id=$1 AND cleaned_at IS NULL',[workspace.id])).rows[0].count,0);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM faultline.storage_reservations WHERE id=ANY($1::uuid[])',[[upload.upload_id,mismatch.upload_id,tiny.upload_id]])).rows[0].count,0);
    assert.equal(data(await request('POST',caseBase+'/uploads/accept',{token:upload.token}),201).id,accepted.id,'accepted receipt survives expired staging cleanup');
    await admin.query("UPDATE faultline.memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace.id,session.user.id]);
    assert.equal((await request('POST',caseBase+'/uploads',details)).statusCode,403,'viewer cannot obtain an upload capability');
    await admin.query("UPDATE faultline.memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace.id,session.user.id]);
    await fs.writeFile(path.join(process.env.SYNTHETIC_EVIDENCE_DIR!,'api-upload-result.json'),JSON.stringify({status:'passed_generated_postgres_fixture_storage_not_live_supabase',workspace_id:workspace.id,case_id:item.id,import_id:accepted.id,bytes:bytes.length,raw_sha256:details.sha256,checks:['signup','wrong-password-denied','login','workspace','case','refresh-read','csrf-denied','large-direct-upload','create-only-provider-upload','503-retry','duplicate-receipt','prepare-completed-receipt','forged-token-denied','content-hash-mismatch-denied','full-signed-token-reservation','verified-staging-reservation-shrink','expired-staging-cleanup','accepted-receipt-after-cleanup','viewer-denied'],storage_requests:requests},null,2)+'\n',{flag:'wx'});
  }finally{await admin.end();await app.close();await closeRuntimePools();globalThis.fetch=originalFetch;}
});
