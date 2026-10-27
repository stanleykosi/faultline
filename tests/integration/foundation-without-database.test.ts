import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../../apps/api/src/server.js';
test('real API separates process liveness from unavailable database/worker readiness',async()=>{
 const app=await buildServer();try{const live=await app.inject('/health/live'),ready=await app.inject('/health/ready');assert.equal(live.statusCode,200);assert.equal(live.json().status,'alive');if(!process.env.DATABASE_URL){assert.equal(ready.statusCode,503);assert.equal(ready.json().components.database,'unconfigured');assert.notEqual(ready.json().components.worker,'ready');}}finally{await app.close();}
});
test('strict business body rejects unknown protected fields and numeric coercion before touching persistence',async()=>{
 const app=await buildServer();try{for(const payload of [{name:'test',role:'owner'},{name:123},{name:'x'.repeat(201)}]){const response=await app.inject({method:'POST',url:'/api/v1/workspaces',payload});assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_INPUT');}}finally{await app.close();}
});
test('unconfigured auth does not accept public signup or turn a session error into an empty workspace list',async()=>{
 const app=await buildServer();try{if(!process.env.AUTH_DATABASE_URL){const signup=await app.inject({method:'POST',url:'/api/auth/sign-up/email',payload:{email:'nobody@example.test',password:'long-enough-password',name:'nobody'}});assert.equal(signup.statusCode,503);const workspaces=await app.inject('/api/v1/workspaces');assert.equal(workspaces.statusCode,503);assert.ok(workspaces.json().error);assert.equal(workspaces.json().data,undefined);}}finally{await app.close();}
});
test('malformed JSON and excessive request sizes remain client failures',async()=>{
 const app=await buildServer();try{const response=await app.inject({method:'POST',url:'/api/v1/workspaces',headers:{'content-type':'application/json'},payload:'{'});assert.equal(response.statusCode,400);const huge=await app.inject({method:'POST',url:'/api/v1/workspaces',payload:{name:'x'.repeat(6*1024*1024)}});assert.equal(huge.statusCode,413);}finally{await app.close();}
});

