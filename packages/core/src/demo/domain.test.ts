import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoCaseCopy, requireDemoCaseBinding, requireDemoReset, requireDemoSeedJob, requireKnownDemoFixture, requireTrustedDemoRuntime, demoFixtureFiles} from './domain.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {byteHash} from '../canonical.js';
import {suppliedPatchView} from '../corrections/fixture-patch.js';

// domain
const id = '11111111-1111-4111-8111-111111111111';

test("demo fixtures are finite, explicitly synthetic and disabled in production", () => {
 // the two supplied fixtures receive explicit synthetic labels and distinct investigation questions
 {
  const regression = demoCaseCopy('regression'), mix = demoCaseCopy('mix-shift');
     assert.match(regression.title, /Local demo/); assert.match(regression.affected_flow, /synthetic fixture/);
     assert.match(mix.title, /mix-shift counterexample/); assert.match(mix.question, /within-device rates remain unchanged/);
     assert.match(demoCaseCopy('regression', 2).title, /generation 2/);
 }
 // only the finite fixture keys are accepted, and demo mode cannot run in production or a disabled runner profile
 {
  for (const value of ['../private', 'production', null, 2]) assert.throws(() => requireKnownDemoFixture(value));
     requireTrustedDemoRuntime({production: false, runnerMode: 'trusted_fixture'});
     for (const runtime of [{production: true, runnerMode: 'trusted_fixture'}, {production: false, runnerMode: 'disabled'}]) assert.throws(() => requireTrustedDemoRuntime(runtime));
 }
});

test('reset requires the exact confirmation, same marked fixture, current revision and no active work', () => {
  const valid = {fixture: 'regression', storedFixture: 'regression', confirmation: 'reset synthetic case', expectedRevision: '4', currentRevision: 4, activeJobs: 0};
  requireDemoReset(valid);
  for (const change of [
    {confirmation: 'reset workspace'},
    {storedFixture: 'mix-shift'},
    {expectedRevision: '3'},
    {activeJobs: 1},
    {fixture: 'all'}
  ]) assert.throws(() => requireDemoReset({...valid, ...change}));
});

test("demo seed authorization binds fixture, case, version and persisted generation", () => {
 // seed jobs require a finite fixture and bind an authorized actor to one case
 {
  for(const fixture of ['regression','mix-shift']) requireDemoSeedJob({fixture,actorId:'generated-actor',caseId:id});
    for(const change of [{fixture:'../workspace'},{actorId:''}]) assert.throws(()=>requireDemoSeedJob({fixture:'regression',actorId:'generated-actor',caseId:id,...change}));
     assert.throws(() => requireDemoSeedJob({fixture: 'regression', actorId: null, caseId: id}));
     assert.throws(() => requireDemoSeedJob({fixture: 'mix-shift', actorId: 'generated-actor', caseId: 'not-a-uuid'}));
 }
 // seed jobs match a finite fixture version and positive generation to their persisted marker
 {
  const binding = {fixture: 'regression', storedFixture: 'regression', fixtureVersion: 1, storedFixtureVersion: '1', generation: 2, storedGeneration: '2'};
     requireDemoCaseBinding(binding);
     for (const change of [
       {storedFixture: 'mix-shift'},
       {storedFixtureVersion: '2'},
       {generation: undefined},
       {storedGeneration: '1'},
       {generation: 0}
     ]) assert.throws(() => requireDemoCaseBinding({...binding, ...change}));
 }
});

// worker
test('pinned local demo source files match their reviewed fixture digests and stay bounded', async()=>{
 for(const [fixture,metadata] of Object.entries(demoFixtureFiles)){
  const bytes=await fs.readFile(path.resolve(process.cwd(),metadata.path));
  assert.ok(bytes.length>0&&bytes.length<=50*1024*1024,`${fixture} exceeds the finite seed-input bound`);
  assert.equal(byteHash(bytes),metadata.sha256,`${fixture} changed without a fixture version update`);
 }
});

// fixture patch
test('supplied patch lookup preserves authored before/after bytes and explicit fixture scope',async()=>{
 const before=await fs.readFile('fixtures/checkout-site/incident.js'),after=await fs.readFile('fixtures/checkout-site/candidate.js'),patch=await fs.readFile('fixtures/checkout-site/candidate.patch');
 const result=suppliedPatchView(before,after,patch);assert.equal(result.production_claim_eligible,false);assert.equal(result.scope,'supplied_fixture_only');assert.equal(result.before.bytes_utf8,before.toString());assert.equal(result.after.bytes_utf8,after.toString());assert.match(result.diff.bytes_utf8,/--- a\/checkout\/behavior.js/);assert.notEqual(result.before.sha256,result.after.sha256);
 for(const args of [[after,after,patch],[before,before,patch],[before,after,Buffer.from('untrusted diff')]])assert.throws(()=>suppliedPatchView(...args as [Buffer,Buffer,Buffer]),{code:'FIXTURE_PATCH_CHANGED'});
});
