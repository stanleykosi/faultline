import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createServer} from 'node:http';
import {resourceRevision} from './resource-revision.js';
import {expected} from '../../../packages/core/src/workspaces/service.js';
import {DomainError} from '../../../packages/core/src/errors.js';
import {createVercelHandler} from './vercel-handler.js';

test('hosted adapter preserves application revision checks on the real HTTP mutation path',async()=>{
 const app=Fastify();let revision=1,changes=0;
 app.setErrorHandler((error,_r,reply)=>reply.code(error instanceof DomainError?error.status:500).send({code:error instanceof DomainError?error.code:'INTERNAL_ERROR'}));
 app.patch('/api/review',async r=>{expected(resourceRevision(r.headers),revision);changes++;return {revision:++revision};});
 await app.ready();const handler=createVercelHandler(async()=>app),server=createServer((req,res)=>void handler(req,res));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/review`;
 try{
  const send=(headers:Record<string,string>)=>fetch(url,{method:'PATCH',headers});
  const valid=await send({'X-Faultline-Revision':'1'});assert.equal(valid.status,200);assert.deepEqual(await valid.json(),{revision:2});
  for(const [headers,status,code] of [[{'X-Faultline-Revision':'1'},409,'STALE_INPUTS'],[{},400,'REVISION_REQUIRED'],[{'X-Faultline-Revision':'2','If-Match':'1'},400,'REVISION_CONFLICT'],[{'X-Faultline-Revision':'2, 3'},400,'REVISION_REQUIRED']] as [Record<string,string>,number,string][]){const response=await send(headers);assert.equal(response.status,status);assert.deepEqual(await response.json(),{code});assert.equal(changes,1);assert.equal(revision,2);}
  const legacy=await send({'If-Match':'2'});assert.equal(legacy.status,200);assert.deepEqual(await legacy.json(),{revision:3});
  const agree=await send({'X-Faultline-Revision':'3','If-Match':'3'});assert.equal(agree.status,200);assert.equal(changes,3);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();}
});

test('optional parent revision accepts absence but rejects malformed or conflicting bindings',()=>{
 assert.equal(resourceRevision({},false),undefined);assert.equal(resourceRevision({'x-faultline-revision':'a'.repeat(64)}),'a'.repeat(64));
 for(const value of [[],['1','1'],'','1 2','1\n2'])assert.throws(()=>resourceRevision({'x-faultline-revision':value as any},false),{code:'REVISION_REQUIRED'});
 assert.throws(()=>resourceRevision({'x-faultline-revision':'1','if-match':'2'},false),{code:'REVISION_CONFLICT'});
});
