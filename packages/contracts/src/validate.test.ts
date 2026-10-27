import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ajv,validateContract} from './validate.js';
test('all 24 canonical draft-2020-12 contracts compile under strict installed Ajv',()=>{
 const files=fs.readdirSync('contracts').filter(f=>f.endsWith('.schema.json'));assert.equal(files.length,24);
 for(const name of files)assert.ok(ajv.getSchema('https://faultline.invalid/contracts/'+name),name);
});
test('model and client cannot provide an extra verified verdict on a canonical metric',()=>{
 const metric=JSON.parse(fs.readFileSync('fixtures/regression/metric.json','utf8'));
 assert.ok(validateContract('metric',metric));assert.throws(()=>validateContract('metric',{...metric,verified:true}));
});

