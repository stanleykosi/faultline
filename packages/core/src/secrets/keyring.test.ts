import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {seal,open} from './keyring.js';
const keyring={active:'v1',keys:{v1:randomBytes(32).toString('base64')}};
test('authenticated encryption preserves private bytes and binds workspace/purpose',()=>{const sealed=seal('private credential','workspace-a:source',keyring);assert.equal(open(sealed,'workspace-a:source',keyring),'private credential');assert.ok(!sealed.includes('private credential'));assert.throws(()=>open(sealed,'workspace-b:source',keyring));});
test('tampered ciphertext and missing key cannot decrypt',()=>{const sealed=JSON.parse(seal('secret','scope',keyring));sealed.ciphertext=Buffer.from('tampered').toString('base64');assert.throws(()=>open(JSON.stringify(sealed),'scope',keyring));assert.throws(()=>open(seal('secret','scope',keyring),'scope',{active:'v2',keys:{}}));});

