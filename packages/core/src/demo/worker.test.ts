import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {byteHash} from '../canonical.js';
import {demoFixtureFiles,requireDemoSeedJob} from './domain.js';

test('pinned local demo source files match their reviewed fixture digests and stay bounded', async()=>{
 for(const [fixture,metadata] of Object.entries(demoFixtureFiles)){
  const bytes=await fs.readFile(path.resolve(process.cwd(),metadata.path));
  assert.ok(bytes.length>0&&bytes.length<=50*1024*1024,`${fixture} exceeds the finite seed-input bound`);
  assert.equal(byteHash(bytes),metadata.sha256,`${fixture} changed without a fixture version update`);
 }
});

test('demo seed work is bound to one known case and the two supplied fixtures',()=>{
 const caseId='11111111-1111-4111-8111-111111111111';
 requireDemoSeedJob({fixture:'mix-shift',actorId:'fixture-owner',caseId});
 for(const input of [
  {fixture:'../workspace',actorId:'fixture-owner',caseId},
  {fixture:'regression',actorId:'',caseId},
  {fixture:'regression',actorId:'fixture-owner',caseId:'../../cases'}
 ]) assert.throws(()=>requireDemoSeedJob(input));
});
