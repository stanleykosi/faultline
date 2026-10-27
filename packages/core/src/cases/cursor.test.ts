import test from 'node:test';import assert from 'node:assert/strict';import {encodeCursor,decodeCursor} from './cursor.js';
const position={created_at:'2026-10-11T10:00:00.000Z',id:'11111111-1111-4111-8111-111111111111'};
test('keyset cursor binds the exact workspace/principal/filter',()=>{const scope={workspace:'alpha',principal:'analyst',filter:'open'},cursor=encodeCursor(scope,position);assert.deepEqual(decodeCursor(cursor,scope),position);assert.throws(()=>decodeCursor(cursor,{...scope,workspace:'beta'}));assert.throws(()=>decodeCursor(cursor.slice(0,-3)+'xxx',scope));});

