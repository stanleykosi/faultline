import {demand} from '../errors.js';

export const demoFixtures = ['regression', 'mix-shift'] as const;
export type DemoFixture = typeof demoFixtures[number];

export const demoFixtureFiles: Record<DemoFixture, {path: string; sha256: string}> = {
  regression: {path: 'fixtures/regression/events.csv', sha256: '621eed7b9379f0a3f685187c253ac6e09a5440a264fc369b4d5c0f79212aa784'},
  'mix-shift': {path: 'fixtures/mix-shift/events.csv', sha256: 'd1347a65b7a267c63e5304031c78315be2790cea42b28d846ed4cb8b1e4c9fe2'}
};

const labels: Record<DemoFixture, {title: string; question: string; affected_flow: string}> = {
  regression: {
    title: 'Local demo · Mobile checkout regression',
    question: 'What changed in the supplied synthetic checkout sessions, and which explanations can the recorded evidence support?',
    affected_flow: 'Checkout · local synthetic fixture'
  },
  'mix-shift': {
    title: 'Local demo · Conversion mix-shift counterexample',
    question: 'Can the aggregate conversion decline be explained by a changed device mix while within-device rates remain unchanged?',
    affected_flow: 'Checkout · local synthetic fixture'
  }
};

export function demoCaseCopy(fixture: DemoFixture, generation = 1) {
  const copy = labels[fixture];
  return {
    title: generation === 1 ? copy.title : `${copy.title} · generation ${generation}`,
    question: copy.question,
    affected_flow: copy.affected_flow
  };
}

export function requireKnownDemoFixture(value: unknown): asserts value is DemoFixture {
  demand(typeof value === 'string' && (demoFixtures as readonly string[]).includes(value), 'INVALID_DEMO_FIXTURE', 'Choose one of the supplied local synthetic fixtures.', 400);
}

export function requireTrustedDemoRuntime(input: {production: boolean; runnerMode: string}) {
  demand(!input.production && input.runnerMode === 'trusted_fixture', 'DEMO_UNAVAILABLE', 'Reference demos are available only in the trusted local fixture profile.', 503);
}

export function requireDemoReset(input: {fixture: unknown; storedFixture: unknown; confirmation: unknown; expectedRevision: unknown; currentRevision: number; activeJobs: number}) {
  demand(input.confirmation === 'reset synthetic case', 'DEMO_RESET_CONFIRMATION_REQUIRED', 'Confirm this exact synthetic-case reset.', 400);
  requireKnownDemoFixture(input.fixture);
  demand(input.storedFixture === input.fixture, 'DEMO_FIXTURE_MISMATCH', 'This marked demo belongs to a different supplied fixture.', 409);
  demand(String(input.expectedRevision) === String(input.currentRevision), 'STALE_INPUTS', 'The demo case changed after review. Refresh and review it again.', 409);
  demand(input.activeJobs === 0, 'ACTIVE_WORK', 'Wait for or cancel active demo work before creating a fresh copy.', 409);
}

export function requireDemoSeedJob(input: {fixture: unknown; actorId: unknown; caseId: unknown}) {
  requireKnownDemoFixture(input.fixture);
  demand(typeof input.actorId === 'string' && input.actorId.length > 0, 'INVALID_DEMO_JOB', 'The trusted demo job has no authorized actor.', 409);
  demand(typeof input.caseId === 'string' && /^[a-f0-9-]{36}$/i.test(input.caseId), 'INVALID_DEMO_JOB', 'The trusted demo job has no valid case binding.', 409);
}

export function requireDemoCaseBinding(input: {fixture: unknown; storedFixture: unknown; fixtureVersion: unknown; storedFixtureVersion: unknown; generation: unknown; storedGeneration: unknown}) {
  requireKnownDemoFixture(input.fixture);
  demand(input.storedFixture === input.fixture && Number.isSafeInteger(input.fixtureVersion) && Number(input.fixtureVersion) > 0 && Number(input.storedFixtureVersion) === input.fixtureVersion && Number.isSafeInteger(input.generation) && Number(input.generation) > 0 && Number(input.storedGeneration) === input.generation, 'DEMO_FIXTURE_MISMATCH', 'Stored demo marker differs from the durable seed job.', 409);
}
