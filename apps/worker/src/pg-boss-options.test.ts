import assert from 'node:assert/strict';
import test from 'node:test';
import {createPgBossOptions,createPgBossSendOptions,FAULTLINE_DELIVERY_EXPIRY_SECONDS} from './pg-boss-options.js';

test('omitting an instance name preserves the existing pg-boss constructor options exactly',()=>{
 assert.deepEqual(createPgBossOptions('postgresql://worker.invalid/faultline',undefined),{
  connectionString:'postgresql://worker.invalid/faultline',schema:'pgboss',max:4,migrate:false,supervise:true,
 });
});

test('a configured instance name is the only added pg-boss constructor option',()=>{
 assert.deepEqual(createPgBossOptions('postgresql://worker.invalid/faultline','faultline-worker-rehearsal-20261014-a1'),{
  connectionString:'postgresql://worker.invalid/faultline',schema:'pgboss',max:4,migrate:false,supervise:true,instanceName:'faultline-worker-rehearsal-20261014-a1',
 });
});

test('job delivery cannot expire before the longest authenticated external runner request',()=>{
 assert.ok(FAULTLINE_DELIVERY_EXPIRY_SECONDS>660);
 assert.deepEqual(createPgBossSendOptions('outbox-1'),{id:'outbox-1',retryLimit:2,expireInSeconds:720});
});
