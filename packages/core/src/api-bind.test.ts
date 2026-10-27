import test from 'node:test';
import assert from 'node:assert/strict';
import {apiReadinessUrl,parseApiBind,parseApiBindHost,parseApiPort} from './api-bind.js';

test('bind defaults to loopback and does not derive its address from APP_ORIGIN',()=>{
 const env={APP_ORIGIN:'https://untrusted.example.invalid',API_BIND_HOST:undefined,PORT:undefined};
 assert.deepEqual(parseApiBind(env),{host:'127.0.0.1',port:3000});
});

test('explicit loopback and ingress wildcard addresses are accepted',()=>{
 assert.equal(parseApiBindHost('127.0.0.1'),'127.0.0.1');
 assert.equal(parseApiBindHost('::1'),'::1');
 assert.equal(parseApiBindHost('0.0.0.0'),'0.0.0.0');
 assert.equal(parseApiBindHost('::'),'::');
 assert.equal(apiReadinessUrl('0.0.0.0',3600),'http://127.0.0.1:3600/health/ready');
 assert.equal(apiReadinessUrl('::',3600),'http://[::1]:3600/health/ready');
});

test('malformed, hostname, wildcard-origin, and non-loopback bind values reject without echoing input',()=>{
 for(const host of ['', ' localhost ', 'localhost', 'https://0.0.0.0', '192.0.2.9', '0.0.0.0/0', 'not an address', '::ffff:127.0.0.1']){
  assert.throws(()=>parseApiBindHost(host),error=>error instanceof Error&&error.message==='API_BIND_HOST must be a supported loopback or ingress IP literal.');
 }
});

test('port parser rejects malformed, privileged sentinel, and out-of-range ports',()=>{
 for(const port of ['', '0', '-1', '+3000', '3.5', ' 3000', '65536', '100000']){
  assert.throws(()=>parseApiPort(port),error=>error instanceof Error&&error.message==='PORT must be an integer from 1 through 65535.');
 }
 assert.equal(parseApiPort('1'),1);
 assert.equal(parseApiPort('65535'),65535);
});
