import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {retainedKeyring} from './rotate-keys.js';
import {seal,open} from '../../packages/core/src/secrets/keyring.js';
import {sessionPseudonym} from '../../packages/core/src/privacy/identity.js';
test('retained AES version rotation preserves old ciphertext, authenticated scope and pinned source identity',()=>{
 const before={active:'aes-v1',keys:{'aes-v0':randomBytes(32).toString('base64'),'aes-v1':randomBytes(32).toString('base64')}},aad='workspace:secret:3',sealed=seal('Explicit test-only credential',aad,before),next=retainedKeyring(before,'aes-v2',randomBytes(32));assert.equal(next.active,'aes-v2');assert.equal(Object.keys(next.keys).length,3);assert.equal(open(sealed,aad,next),'Explicit test-only credential');assert.throws(()=>open(sealed,'another-workspace:secret:3',next));const fresh=seal('New test-only credential',aad,next);assert.equal(open(fresh,aad,next),'New test-only credential');assert.throws(()=>open(fresh,aad,before),/Unknown encryption key/);
 const pinned=Buffer.from(before.keys['aes-v1'],'base64'),policy={key_version:'aes-v1',version:'workspace-source-hmac-sha256-v1'};assert.equal(sessionPseudonym(pinned,'wid','source',policy.version,'raw-session'),sessionPseudonym(Buffer.from(next.keys[policy.key_version]!,'base64'),'wid','source',policy.version,'raw-session'));assert.notEqual(sessionPseudonym(pinned,'wid','source',policy.version,'raw-session'),sessionPseudonym(pinned,'other','source',policy.version,'raw-session'));assert.throws(()=>retainedKeyring(before,'aes-v1',randomBytes(32)),/distinct/);assert.throws(()=>retainedKeyring(before,'aes-v3',Buffer.alloc(12)),/256/);assert.equal(before.active,'aes-v1');
});

test('rotation rejects a thirty-third retained version before changing an archived recovery ceiling',()=>{const keys=Object.fromEntries(Array.from({length:32},(_,i)=>['v'+i,randomBytes(32).toString('base64')]));assert.throws(()=>retainedKeyring({active:'v31',keys},'v32',randomBytes(32)));assert.equal(Object.keys(keys).length,32);});
