import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadTrustedFixturePatch, TrustedFixtureHarness} from '../../../apps/runner/src/trusted-fixture.js';
import {hash} from '../../../packages/core/src/canonical.js';
import {DomainError} from '../../../packages/core/src/errors.js';
import {evaluateFixtureVerification, type CurrentVerificationBinding} from '../../../packages/core/src/verification/fixture.js';
import type {FaultlineApproval, FaultlineBrowserPlan, FaultlineTargetGrant} from '../../../packages/contracts/src/generated.js';

const binding = {workspace_id: 'fixture-acceptance-workspace', case_id: 'fixture-acceptance-case', revision_id: 'fixture-acceptance-revision', hypothesis_id: 'fixture-mobile-handler', metric_hash: hash({test_harness_metric: 'not_live_source_evidence'}), snapshot_hash: hash({test_harness_snapshot: 'supplied_original_checkout_fixture'})};
function authorization(plan: FaultlineBrowserPlan): {grant: FaultlineTargetGrant; approval: FaultlineApproval} {
  const expiry = new Date(Date.now() + 600_000).toISOString();
  const grant: FaultlineTargetGrant = {id: 'explicit-fixture-test-harness-grant', workspace_id: plan.workspace_id, origins: plan.arms.map(a => a.origin) as FaultlineTargetGrant['origins'], expires_at: expiry, revoked: false};
  const approval: FaultlineApproval = {workspace_id: plan.workspace_id, reviewer_id: 'explicit-fixture-test-harness-reviewer', reviewer_role: 'owner', plan_hash: hash(plan), oracle_hash: plan.oracle_hash, grant_hash: hash(grant), expires_at: expiry, revoked: false};
  return {grant, approval};
}
function current(plan: FaultlineBrowserPlan): CurrentVerificationBinding {
  return {...binding, metric_hash: plan.metric_hash, snapshot_hash: plan.snapshot_hash, fixture_hash: plan.fixture_hash, environment_hash: plan.environment_hash, oracle_hash: plan.oracle_hash, runner_id: plan.runner_id, plan_hash: hash(plan), observation_profile_hash: plan.observation_profile_hash!, arms: plan.arms};
}
const code = (name: string) => (e: unknown) => e instanceof DomainError && e.code === name;
test('real browser acceptance: supplied trusted fixtures, explicit test harness authority only', {timeout: 360_000}, async t => {
  const harness = await TrustedFixtureHarness.start({channel: 'msedge'});
  try {
    await t.test('12 real mechanism observations reproduce only incident/mobile; all healthy controls pass', async () => {
      const plan = harness.plan('mechanism', binding), auth = authorization(plan), task = harness.task(plan);
      const execution = await harness.execute(plan, auth.approval, auth.grant, task), admitted = harness.admit(execution, plan), result = evaluateFixtureVerification(admitted, current(plan));
      assert.equal(execution.receipt.observations.length, 12); assert.equal(result.observed_runs, 12); assert.equal(result.outcome, 'passed'); assert.equal(result.mechanism, 'reproduced'); assert.equal(result.correction, 'not_tested'); assert.equal(result.production_claim_eligible, false);
      for (const observation of execution.receipt.observations) {
        assert.equal(observation.status, 'observed');
        const actual = observation.actual!;
        if (observation.arm === 'incident' && observation.cohort === 'mobile') assert.deepEqual(actual, {checkout_completed: false, order_created_count: 0, error_code: 'PAY_BUTTON_HANDLER_MISSING'});
        else assert.deepEqual(actual, {checkout_completed: true, order_created_count: 1, error_code: null});
      }
      assert.equal(new Set(execution.receipt.attempts.map(a => a.attempt_id)).size, 12);
      const journal = await fs.readFile(path.join(execution.artifact_directory, 'observations.jsonl'), 'utf8'); assert.equal(journal.trim().split('\n').length, 12);
      await fs.writeFile(path.join(execution.artifact_directory, 'verification.json'), JSON.stringify({scope: 'explicit_test_harness_only', level: 'trusted_fixture_component_acceptance', connected_product_ui: 'not_run', live_external: 'not_run', result}, null, 2), {flag: 'wx'});
      console.log(JSON.stringify({objective: 'mechanism', observations: 12, artifact_directory: execution.artifact_directory, result}));
      assert.throws(() => harness.admit(execution, plan), code('REPLAYED_OR_EXPIRED_RECEIPT'));
      const altered = structuredClone(execution); altered.receipt.observations[0]!.actual!.order_created_count = 0;
      assert.throws(() => harness.admit(altered, plan), code('RUNNER_AUTHENTICATION_FAILED'));
      const stale = evaluateFixtureVerification(admitted, {...current(plan), snapshot_hash: hash({changed: true})}); assert.equal(stale.freshness, 'stale'); assert.notEqual(stale.outcome, 'passed');
    });
    await t.test('18 fresh correction observations rerun all controls and validate the supplied candidate', async () => {
      const plan = harness.plan('correction', binding), auth = authorization(plan), task = harness.task(plan);
      const execution = await harness.execute(plan, auth.approval, auth.grant, task), admitted = harness.admit(execution, plan), result = evaluateFixtureVerification(admitted, current(plan));
      assert.equal(execution.receipt.observations.length, 18); assert.equal(result.outcome, 'passed'); assert.equal(result.mechanism, 'reproduced'); assert.equal(result.correction, 'validated'); assert.equal(result.production_claim_eligible, false); assert.equal(result.attribution.causal_effect, 'not_established');
      assert.equal(execution.receipt.attempts.flatMap(a => a.artifacts).length, 18);
      for (const observation of execution.receipt.observations.filter(o => o.arm === 'candidate')) assert.deepEqual(observation.actual, {checkout_completed: true, order_created_count: 1, error_code: null});
      const changedArms = structuredClone(plan.arms); changedArms.find(a => a.arm === 'candidate')!.build_digest = hash({changed_candidate: true});
      assert.equal(evaluateFixtureVerification(admitted, {...current(plan), arms: changedArms}).freshness, 'stale');
      assert.equal(evaluateFixtureVerification(admitted, {...current(plan), observation_profile_hash: hash({changed_profile: true})}).freshness, 'stale');
      await fs.writeFile(path.join(execution.artifact_directory, 'verification.json'), JSON.stringify({scope: 'explicit_test_harness_only', level: 'trusted_fixture_component_acceptance', connected_product_ui: 'not_run', live_external: 'not_run', result}, null, 2), {flag: 'wx'});
      console.log(JSON.stringify({objective: 'correction', observations: 18, artifact_directory: execution.artifact_directory, result}));
    });
    await t.test('real navigation-only action plan fails healthy controls and cannot pass mechanism evaluation', async () => {
      const plan = harness.plan('mechanism', binding, [{op: 'navigate', path: '/'}]), auth = authorization(plan), task = harness.task(plan);
      const execution = await harness.execute(plan, auth.approval, auth.grant, task), result = evaluateFixtureVerification(harness.admit(execution, plan), current(plan));
      assert.equal(execution.receipt.observations.length, 12); assert.equal(result.outcome, 'inconclusive'); assert.equal(result.mechanism, 'inconclusive'); assert.ok(result.reasons.includes('required_control_failed'));
      await fs.writeFile(path.join(execution.artifact_directory, 'verification.json'), JSON.stringify({scope: 'deliberate_negative_test_harness_only', result}, null, 2), {flag: 'wx'});
      console.log(JSON.stringify({objective: 'failed-control-negative', observations: 12, artifact_directory: execution.artifact_directory, result}));
    });
    await t.test('G05: distinct actually unfixed candidate runs18 real correction observations and fails while every healthy control passes', async () => {
      const prior = process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE; process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE = 'explicit_test_harness_only';
      let negative: TrustedFixtureHarness | undefined, directory: string | undefined;
      try {
        negative = await TrustedFixtureHarness.startNegativeCorrectionAcceptance({channel: 'msedge'});
        await assert.rejects(negative.registration(), code('ACCEPTANCE_ONLY_FIXTURE'));
        const plan = negative.plan('correction', binding), auth = authorization(plan), task = negative.task(plan); directory = path.resolve('tests/acceptance/fixture-browser/artifacts', task.nonce);
        const candidate = plan.arms.find(arm => arm.arm === 'candidate')!, incident = plan.arms.find(arm => arm.arm === 'incident')!;
        assert.notEqual(candidate.build_digest, incident.build_digest, 'The observed unfixed candidate is a distinct actual supplied acceptance build, not an overridden digest.'); assert.notEqual(plan.fixture_hash, harness.fixture_hash);
        const execution = await negative.execute(plan, auth.approval, auth.grant, task), admitted = negative.admit(execution, plan), result = evaluateFixtureVerification(admitted, current(plan));
        assert.equal(execution.receipt.observations.length, 18); assert.equal(result.expected_runs, 18); assert.equal(result.observed_runs, 18); assert.equal(result.outcome, 'failed'); assert.equal(result.mechanism, 'reproduced'); assert.equal(result.correction, 'failed'); assert.equal(result.freshness, 'fresh'); assert.equal(result.production_claim_eligible, false); assert.equal(result.attribution.causal_effect, 'not_established'); assert.deepEqual(result.reasons, ['candidate_retains_reproduced_failure']);
        for (const observation of execution.receipt.observations) {assert.equal(observation.status, 'observed'); const broken = observation.cohort === 'mobile' && ['incident', 'candidate'].includes(observation.arm); assert.deepEqual(observation.actual, broken ? {checkout_completed: false, order_created_count: 0, error_code: 'PAY_BUTTON_HANDLER_MISSING'} : {checkout_completed: true, order_created_count: 1, error_code: null});}
        for (const attempt of execution.receipt.attempts) {assert.equal(attempt.ui_completed, attempt.receipt_completed); assert.equal(attempt.before.build_digest, attempt.after.build_digest); assert.equal(attempt.artifacts.length, 1);}
        assert.equal(new Set(execution.receipt.attempts.map(attempt => attempt.attempt_id)).size, 18); assert.equal(execution.receipt.attempts.flatMap(attempt => attempt.artifacts).length, 18);
        const journal = await fs.readFile(path.join(execution.artifact_directory, 'observations.jsonl'), 'utf8'); assert.equal(journal.trim().split('\n').length, 18);
        await fs.writeFile(path.join(execution.artifact_directory, 'verification.json'), JSON.stringify({scope: 'deliberate_unfixed_candidate_explicit_test_harness_only', level: 'trusted_fixture_component_negative_acceptance', actual_browser_observations: 18, simulated_observations: 0, candidate_build_digest: candidate.build_digest, incident_build_digest: incident.build_digest, fixture_hash: plan.fixture_hash, plan, result, connected_product_ui: 'not_run', live_external: 'not_run', production_claim_eligible: false}, null, 2), {flag: 'wx'});
        console.log(JSON.stringify({objective: 'unfixed-candidate-correction-negative', observations: 18, scope: 'explicit_test_harness_only', artifact_directory: execution.artifact_directory, result}));
      } finally {
        try {if (negative) {await negative.close(); const closed = negative.closureStatus(); if (directory) await fs.writeFile(path.join(directory, 'negative-closure.json'), JSON.stringify({scope: 'explicit_test_harness_only', ...closed, recorded_at: new Date().toISOString()}, null, 2), {flag: 'wx'}); assert.deepEqual(closed, {browser_closed: true, fixture_servers_closed: true});}}
        finally {if (prior === undefined) delete process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE; else process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE = prior;}
      }
    });
    await t.test('native runner rejects external/unregistered origins and altered or revoked authorization', async () => {
      const plan = harness.plan('mechanism', binding), auth = authorization(plan);
      const external = structuredClone(plan); external.arms[0]!.origin = 'https://example.com'; assert.throws(() => harness.task(external), code('EXTERNAL_TARGET_DENIED'));
      const unregistered = structuredClone(plan); unregistered.arms[0]!.origin = 'http://127.0.0.1:1'; assert.throws(() => harness.task(unregistered), code('UNREGISTERED_FIXTURE_ORIGIN'));
      await assert.rejects(harness.execute(plan, {...auth.approval, revoked: true}, auth.grant, harness.task(plan)), code('APPROVAL_REVOKED'));
      await assert.rejects(harness.execute(plan, {...auth.approval, plan_hash: hash({wrong: true})}, auth.grant, harness.task(plan)), code('APPROVAL_BINDING_MISMATCH'));
      const noop = structuredClone(harness.plan('correction', binding)); noop.arms.find(a => a.arm === 'candidate')!.build_digest = noop.arms.find(a => a.arm === 'incident')!.build_digest;
      assert.throws(() => harness.task(noop), code('NOOP_CANDIDATE'));
      const patch = await loadTrustedFixturePatch(); assert.equal(patch.scope, 'supplied_fixture_only'); assert.equal(patch.sha256, 'c215610e51d3b6bc076c2d7f1180aab01f011d8d837c5b82f0b519c3712a3ec7');
      const originalProfile = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        await assert.rejects(TrustedFixtureHarness.start(), code('FIXTURES_FORBIDDEN_IN_PRODUCTION'));
        await assert.rejects(harness.execute(plan, auth.approval, auth.grant, harness.task(plan)), code('FIXTURES_FORBIDDEN_IN_PRODUCTION'));
      } finally {if (originalProfile === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalProfile;}
    });
  } finally {await harness.close();}
});

test('negative acceptance factory rejects missing scope, arbitrary artifact options and production before starting a browser', {timeout: 10000}, async () => {
  const previousScope = process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE, previousProfile = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'test'; delete process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE;
    await assert.rejects(TrustedFixtureHarness.startNegativeCorrectionAcceptance(), code('ACCEPTANCE_ONLY_FIXTURE'));
    process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE = 'explicit_test_harness_only';
    const injected = {origin: 'http://127.0.0.1:1', script: 'arbitrary-target-code'} as unknown as NonNullable<Parameters<typeof TrustedFixtureHarness.startNegativeCorrectionAcceptance>[0]>;
    await assert.rejects(TrustedFixtureHarness.startNegativeCorrectionAcceptance(injected), code('UNTRUSTED_CANDIDATE'));
    const defaultInjection = {candidateArtifact: 'unfixed_candidate_acceptance'} as unknown as NonNullable<Parameters<typeof TrustedFixtureHarness.start>[0]>;
    await assert.rejects(TrustedFixtureHarness.start(defaultInjection), code('UNTRUSTED_CANDIDATE'));
    process.env.NODE_ENV = 'production';
    await assert.rejects(TrustedFixtureHarness.startNegativeCorrectionAcceptance(), code('FIXTURES_FORBIDDEN_IN_PRODUCTION'));
  } finally {if (previousScope === undefined) delete process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE; else process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE = previousScope; if (previousProfile === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousProfile;}
});
