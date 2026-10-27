import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {request, verifyRequest, response, verifyResponse, rpcSignature, exactKeys, requireNativeFixtureMode} from './protocol.js';

test('signed finite fixture RPC binds path, payload, nonce, expiry and production refusal',()=>{
 const key=randomBytes(32),value=request('/v1/prepare',{objective:'mechanism'},key);
 assert.doesNotThrow(()=>verifyRequest('/v1/prepare',value,key));
 assert.throws(()=>verifyRequest('/v1/execute',value,key),/unauthenticated/);
 assert.throws(()=>verifyRequest('/v1/prepare',{...value,payload:{objective:'correction'}},key),/unauthenticated/);
 const body={version:1 as const,nonce:value.nonce,expires_at:'2000-01-01T00:00:00.000Z',payload:value.payload};
 assert.throws(()=>verifyRequest('/v1/prepare',{...body,signature:rpcSignature({method:'POST',path:'/v1/prepare',...body},key)},key),/Expired/);
 const reply=response(value.nonce,{scope:'trusted_fixture'},null,key);assert.doesNotThrow(()=>verifyResponse(reply,value.nonce,key));
 assert.throws(()=>verifyResponse(reply,'another-task',key),/Malformed/);
 assert.throws(()=>verifyResponse({...reply,payload:{scope:'external'}},value.nonce,key),/unauthenticated/);
 assert.throws(()=>exactKeys({objective:'mechanism',javascript:'fetch(...)'},['objective']),/finite fields/);
 const before={node:process.env.NODE_ENV,mode:process.env.RUNNER_MODE,enabled:process.env.ALLOW_FIXTURE_ADAPTERS};
 try{process.env.NODE_ENV='production';process.env.RUNNER_MODE='trusted_fixture';process.env.ALLOW_FIXTURE_ADAPTERS='true';assert.throws(()=>requireNativeFixtureMode(),/unavailable in production/);process.env.NODE_ENV='development';assert.doesNotThrow(()=>requireNativeFixtureMode());process.env.RUNNER_MODE='external';assert.throws(()=>requireNativeFixtureMode(),/Explicitly configure/);}finally{for(const [key,value]of Object.entries({NODE_ENV:before.node,RUNNER_MODE:before.mode,ALLOW_FIXTURE_ADAPTERS:before.enabled})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
