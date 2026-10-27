import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePgBossInstanceName} from './pg-boss-instance.js';

test('an absent pg-boss instance name preserves the unnamed default',()=>{
 assert.equal(parsePgBossInstanceName(undefined),undefined);
});

test('a bounded stable pg-boss instance name is accepted unchanged',()=>{
 assert.equal(parsePgBossInstanceName('faultline-worker-rehearsal-20261014-a1'),'faultline-worker-rehearsal-20261014-a1');
});

test('empty, whitespace, control, unsupported and overlong names are rejected',()=>{
 for(const invalid of ['', 'has space', 'UPPER/name', 'bad\nname', 'x'.repeat(64)]) {
  assert.throws(()=>parsePgBossInstanceName(invalid),(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='CONFIGURATION');
 }
});
