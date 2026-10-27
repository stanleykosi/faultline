import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoCaseCopy, requireDemoCaseBinding, requireDemoReset, requireDemoSeedJob, requireKnownDemoFixture, requireTrustedDemoRuntime} from './domain.js';

const id = '11111111-1111-4111-8111-111111111111';

test('the two supplied fixtures receive explicit synthetic labels and distinct investigation questions', () => {
  const regression = demoCaseCopy('regression'), mix = demoCaseCopy('mix-shift');
  assert.match(regression.title, /Local demo/); assert.match(regression.affected_flow, /synthetic fixture/);
  assert.match(mix.title, /mix-shift counterexample/); assert.match(mix.question, /within-device rates remain unchanged/);
  assert.match(demoCaseCopy('regression', 2).title, /generation 2/);
});

test('only the finite fixture keys are accepted, and demo mode cannot run in production or a disabled runner profile', () => {
  for (const value of ['../private', 'production', null, 2]) assert.throws(() => requireKnownDemoFixture(value));
  requireTrustedDemoRuntime({production: false, runnerMode: 'trusted_fixture'});
  for (const runtime of [{production: true, runnerMode: 'trusted_fixture'}, {production: false, runnerMode: 'disabled'}]) assert.throws(() => requireTrustedDemoRuntime(runtime));
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

test('seed jobs require a finite fixture and bind an authorized actor to one case', () => {
  requireDemoSeedJob({fixture: 'regression', actorId: 'generated-actor', caseId: id});
  assert.throws(() => requireDemoSeedJob({fixture: 'regression', actorId: null, caseId: id}));
  assert.throws(() => requireDemoSeedJob({fixture: 'mix-shift', actorId: 'generated-actor', caseId: 'not-a-uuid'}));
});

test('seed jobs match a finite fixture version and positive generation to their persisted marker', () => {
  const binding = {fixture: 'regression', storedFixture: 'regression', fixtureVersion: 1, storedFixtureVersion: '1', generation: 2, storedGeneration: '2'};
  requireDemoCaseBinding(binding);
  for (const change of [
    {storedFixture: 'mix-shift'},
    {storedFixtureVersion: '2'},
    {generation: undefined},
    {storedGeneration: '1'},
    {generation: 0}
  ]) assert.throws(() => requireDemoCaseBinding({...binding, ...change}));
});
