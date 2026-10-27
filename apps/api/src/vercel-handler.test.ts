import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import Fastify from 'fastify';
import {createVercelHandler} from './vercel-handler.js';

test('Node function preserves original route, cookies, JSON body and streaming lifetime',async()=>{
 const app=Fastify();let complete:()=>void=()=>{},resolved=false,initializations=0;
 app.post('/api/echo',async r=>({url:r.url,body:r.body,cookie:r.headers.cookie}));
 app.get('/api/stream',async(_r,reply)=>{reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream','set-cookie':['one=1; HttpOnly','two=2; HttpOnly']});reply.raw.write('id: 1\ndata: first\n\n');await new Promise<void>(resolve=>{complete=resolve;});reply.raw.end('id: 2\ndata: second\n\n');});
 await app.ready();const handler=createVercelHandler(async()=>{initializations++;return app;});
 const server=createServer((req,res)=>{void handler(req,res).then(()=>{if(req.url==='/api/stream')resolved=true;});});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 try{
  const echo=await fetch(origin+'/api/echo?retained=yes',{method:'POST',headers:{'content-type':'application/json',cookie:'synthetic=session'},body:JSON.stringify({value:'preserved'})});assert.deepEqual(await echo.json(),{url:'/api/echo?retained=yes',body:{value:'preserved'},cookie:'synthetic=session'});
  const response=await fetch(origin+'/api/stream');assert.deepEqual(response.headers.getSetCookie(),['one=1; HttpOnly','two=2; HttpOnly']);const reader=response.body!.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/id: 1/);assert.equal(resolved,false,'function promise must wait for the stream to finish');complete();let tail='';for(;;){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}assert.match(tail,/id: 2/);assert.equal(initializations,1);
 }finally{complete();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();}
});
test('failed initialization is sanitized and can recover on a later invocation',async()=>{
 let attempts=0;const app=Fastify();app.get('/health/ready',async()=>({status:'ready'}));await app.ready();
 const handler=createVercelHandler(async()=>{if(++attempts===1)throw Error('private-provider-credential');return app;});const server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 try{const url='http://127.0.0.1:'+address.port+'/health/ready',failure=await fetch(url);assert.equal(failure.status,503);assert.doesNotMatch(await failure.text(),/private-provider/);assert.deepEqual(await(await fetch(url)).json(),{status:'ready'});assert.equal(attempts,2);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();}
});

test('liveness needs no backend initialization and only bypasses exact GET or HEAD requests',async()=>{
 let attempts=0;const handler=createVercelHandler(async()=>{attempts++;throw Error('missing synthetic configuration');});
 const server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 try{
  for(const path of ['/health/live','/health/live?probe=host']){const response=await fetch(origin+path);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-type'),'application/json');assert.deepEqual(await response.json(),{status:'alive'});}
  const head=await fetch(origin+'/health/live?probe=head',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('cache-control'),'no-store');assert.equal(await head.text(),'');assert.equal(attempts,0);
  for(const [path,method] of [['/health/live','POST'],['/health/live/extra','GET'],['/health/ready','GET']]){const response=await fetch(origin+path,{method});assert.equal(response.status,503);assert.equal((await response.json()).error.code,'DEPENDENCY_UNAVAILABLE');}
  assert.equal(attempts,3,'other routes and methods still require actual backend readiness');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
