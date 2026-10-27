import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalArrayBytes,hashCanonicalArray} from './canonical.js';

test('bounded canonical array output preserves independently specified UTF8 bytes and digest',()=>{
 const input=[{z:'café',a:[true,null,-1]},{b:'\\"',a:'λ'}];
 const expected=Buffer.from('[{"a":[true,null,-1],"z":"café"},{"a":"λ","b":"\\\\\\\""}]');
 assert.deepEqual(canonicalArrayBytes(input),expected);
 assert.equal(hashCanonicalArray(input),createHash('sha256').update(expected).digest('hex'));
 assert.equal(hashCanonicalArray([]),createHash('sha256').update('[]').digest('hex'));
 assert.deepEqual(canonicalArrayBytes([]),Buffer.from('[]'));
 const many=Array.from({length:1000},(_,i)=>({i,text:'é'.repeat(160)}));
 const explicit='['+many.map(v=>'{'+'"i":'+v.i+',"text":'+JSON.stringify(v.text)+'}').join(',')+']';
 assert.deepEqual(canonicalArrayBytes(many),Buffer.from(explicit));
 assert.equal(hashCanonicalArray(many),createHash('sha256').update(explicit).digest('hex'));
});
test('bounded canonical array helpers preserve unsafe/nonfinite rejection',()=>{
 for(const value of [Infinity,NaN,undefined,JSON.parse('{"__proto__":{"elevated":true}}')]){
  assert.throws(()=>canonicalArrayBytes([value]));assert.throws(()=>hashCanonicalArray([value]));
 }
});
