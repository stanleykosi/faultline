import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import Fastify from 'fastify';
import {installRequestWorkTracking} from './request-work.js';
import {createVercelHandler} from './vercel-handler.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

for(const fail of [false,true])test(`disconnected invocation drains route resources before returning (${fail?'rejected':'successful'} work)`,async()=>{
 const entered=deferred(),release=deferred(),closed=deferred(),invoked=deferred();
 let released=false,returned=false;
 const app=Fastify();installRequestWorkTracking(app);
 app.setErrorHandler((_error,_request,reply)=>reply.code(503).send({error:'unavailable'}));
 app.get('/slow',async()=>{
  try{entered.resolve();await release.promise;if(fail)throw Error('synthetic-private-failure');return {ok:true};}
  finally{released=true;}
 });
 app.get('/unrelated',()=>({ok:true}));await app.ready();
 const handler=createVercelHandler(async()=>app);
 const server=createServer((req,res)=>{
  if(req.url==='/slow')res.once('close',closed.resolve);
  void handler(req,res).then(()=>{if(req.url==='/slow'){returned=true;invoked.resolve();}});
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const origin='http://127.0.0.1:'+address.port;
 const request=httpRequest(origin+'/slow');request.on('error',()=>{});request.end();
 try{
  await entered.promise;request.destroy();await closed.promise;
  await new Promise<void>(r=>setImmediate(r));
  assert.equal(returned,false,'response close must not complete the invocation while backend work holds a resource');
  assert.equal(released,false);
  assert.deepEqual(await(await fetch(origin+'/unrelated')).json(),{ok:true},'a different request must not wait for the aborted route');
  release.resolve();await invoked.promise;
  assert.equal(released,true);assert.equal(returned,true);
  assert.deepEqual(await(await fetch(origin+'/unrelated')).json(),{ok:true});
 }finally{
  release.resolve();request.destroy();server.closeAllConnections();
  await new Promise<void>(r=>server.close(()=>r()));await app.close();
 }
});

test('tracked synchronous and async routes preserve response semantics and rejection handling',async()=>{
 const app=Fastify();installRequestWorkTracking(app);
 app.get('/sync',()=>({kind:'sync'}));app.get('/async',async()=>({kind:'async'}));
 app.get('/reject',async()=>{throw Error('synthetic failure');});
 app.setErrorHandler((_e,_r,reply)=>reply.code(503).send({error:'sanitized'}));
 await app.ready();const handler=createVercelHandler(async()=>app);
 const server=createServer((req,res)=>{void handler(req,res);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 try{
  assert.deepEqual(await(await fetch(origin+'/sync')).json(),{kind:'sync'});
  assert.deepEqual(await(await fetch(origin+'/async')).json(),{kind:'async'});
  const failed=await fetch(origin+'/reject');assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{error:'sanitized'});
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await app.close();}
});

test('disconnect during cold initialization completes without dispatching on a closed response',async()=>{
 const entered=deferred(),initialize=deferred(),closed=deferred(),invoked=deferred();let calls=0;
 const app=Fastify();installRequestWorkTracking(app);app.get('/cold',async()=>{calls++;return {ok:true};});await app.ready();
 const handler=createVercelHandler(async()=>{entered.resolve();await initialize.promise;return app;});
 const server=createServer((req,res)=>{res.once('close',closed.resolve);void handler(req,res).then(invoked.resolve);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const request=httpRequest('http://127.0.0.1:'+address.port+'/cold');request.on('error',()=>{});request.end();
 try{
  await entered.promise;request.destroy();await closed.promise;initialize.resolve();await invoked.promise;assert.equal(calls,0);
 }finally{initialize.resolve();request.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await app.close();}
});
