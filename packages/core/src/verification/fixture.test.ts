import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {byteHash, hash, now} from '../canonical.js';
import {DomainError} from '../errors.js';
import {admitFixtureReceipt, authenticateValue, authorizeFixturePlan, evaluateFixtureVerification, protectedFixtureOracle, validateFixturePlan, type Arm, type CurrentVerificationBinding, type DeploymentReceipt, type FixtureAdmissionExpectation, type FixtureRunReceipt} from './fixture.js';
import type {FaultlineBrowserPlan, FaultlineObservation} from '../../../contracts/src/generated.js';

// Explicit unit-test signing authority. These synthetic records are not browser execution evidence.
const secret = randomBytes(32), digest = (value: string) => hash({fixture_unit_input: value});
const unitArtifactRoot = path.resolve('packages/core/src/verification/unit-artifacts'), unitArtifact = path.join(unitArtifactRoot, 'unit-only.png');
const unitPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');
after(() => {if (unitArtifact.startsWith(path.resolve('packages/core/src/verification') + path.sep)) {if (fs.existsSync(unitArtifact)) fs.unlinkSync(unitArtifact); if (fs.existsSync(unitArtifactRoot)) fs.rmdirSync(unitArtifactRoot);}});
const code = (name: string) => (e: unknown) => e instanceof DomainError && e.code === name;
function setup(objective: 'mechanism' | 'correction' = 'correction') {
  fs.mkdirSync(unitArtifactRoot, {recursive: true}); fs.writeFileSync(unitArtifact, unitPng);
  const oracle = protectedFixtureOracle(objective), instant = now();
  const plan = validateFixturePlan({version: 1, workspace_id: 'unit-workspace', case_id: 'unit-case', revision_id: 'revision-1', hypothesis_id: 'hyp-1', objective, mode: 'trusted_fixture', policy_version: oracle.version, oracle_hash: hash(oracle), metric_hash: digest('metric'), snapshot_hash: digest('snapshot'), fixture_hash: digest('fixture'), environment_hash: digest('environment'), observation_profile_hash: digest('profile'), runner_id: 'unit-runner', repeats: 3, cohorts: ['mobile', 'desktop'], actions: [{op: 'navigate', path: '/'}, {op: 'click', locator: {kind: 'test_id', value: 'pay'}}], arms: oracle.arms.map((arm, i) => ({arm, origin: `http://127.0.0.1:${4301 + i}`, build_digest: digest(arm), deployment_evidence_hash: digest('deployment-' + arm)}))});
  const expected: FixtureAdmissionExpectation = {job_id: 'unit-job', lease_id: 'unit-lease', nonce: randomUUID(), expires_at: new Date(Date.now() + 600_000).toISOString(), observation_profile_hash: digest('profile'), artifact_directory: unitArtifactRoot, deployments: Object.fromEntries(plan.arms.map(a => [a.arm, {deployment_id: 'deployment-' + a.arm, attester_id: 'unit-observer'}]))};
  const observations: FaultlineObservation[] = [];
  for (const arm of plan.arms) for (const cohort of plan.cohorts) for (let repeat = 1; repeat <= 3; repeat++) {
    const failure = arm.arm === 'incident' && cohort === 'mobile';
    observations.push({arm: arm.arm, cohort, repeat, status: 'observed', plan_hash: hash(plan), oracle_hash: plan.oracle_hash, build_digest: arm.build_digest, build_digest_after: arm.build_digest, deployment_evidence_hash: arm.deployment_evidence_hash, fixture_hash: plan.fixture_hash, environment_hash: plan.environment_hash, runner_id: plan.runner_id, actual: {checkout_completed: !failure, order_created_count: failure ? 0 : 1, error_code: failure ? 'PAY_BUTTON_HANDLER_MISSING' : null}});
  }
  function receipt(observed = observations): FixtureRunReceipt {
    const attempts = observed.map(o => {
      const attempt_id = randomUUID(), arm = plan.arms.find(a => a.arm === o.arm)!;
      const proof = (phase: string): DeploymentReceipt => {const body = {deployment_id: 'deployment-' + o.arm, origin: arm.origin, build_digest: arm.build_digest, nonce: `${expected.nonce}:${attempt_id}:${phase}`, observed_at: instant, attester_id: 'unit-observer'}; return {...body, signature: authenticateValue(body, secret)};};
      return {attempt_id, arm: o.arm, cohort: o.cohort, repeat: o.repeat, observation_hash: hash(o), ui_completed: o.actual?.checkout_completed ?? null, receipt_completed: o.actual?.checkout_completed ?? null, before: proof('before'), after: proof('after'), artifacts: [{path: unitArtifact, sha256: byteHash(unitPng), size_bytes: unitPng.length, media_type: 'image/png'}], errors: []};
    });
    const body = {version: 1 as const, scope: 'trusted_fixture' as const, runner_id: plan.runner_id, job_id: expected.job_id, lease_id: expected.lease_id, nonce: expected.nonce, plan_hash: hash(plan), observation_profile_hash: expected.observation_profile_hash, started_at: instant, finished_at: now(), engine: {name: 'chromium' as const, channel: 'msedge' as const, version: 'unit-test'}, observations: observed, attempts};
    return {...body, signature: authenticateValue(body, secret)};
  }
  const current: CurrentVerificationBinding = {workspace_id: plan.workspace_id, case_id: plan.case_id, revision_id: plan.revision_id, hypothesis_id: plan.hypothesis_id, metric_hash: plan.metric_hash, snapshot_hash: plan.snapshot_hash, fixture_hash: plan.fixture_hash, environment_hash: plan.environment_hash, oracle_hash: plan.oracle_hash, runner_id: plan.runner_id, plan_hash: hash(plan), observation_profile_hash: digest('profile'), arms: plan.arms};
  return {plan, expected, observations, receipt, current, admit: (r: FixtureRunReceipt) => admitFixtureReceipt(r, plan, secret, expected, new Set())};
}
test('unit evaluator keeps mechanism and correction separate and never establishes aggregate causation', () => {
  for (const objective of ['mechanism', 'correction'] as const) {
    const unit = setup(objective), result = evaluateFixtureVerification(unit.admit(unit.receipt()), unit.current, 'observed');
    assert.equal(result.outcome, 'passed'); assert.equal(result.mechanism, 'reproduced'); assert.equal(result.correction, objective === 'mechanism' ? 'not_tested' : 'validated');
    assert.equal(result.expected_runs, objective === 'mechanism' ? 12 : 18); assert.equal(result.production_claim_eligible, false); assert.deepEqual(result.attribution, {scope: 'association_only', causal_effect: 'not_established'});
  }
});
test('unit evaluator retains unfixed candidate failure and rejects failed or missing required controls', () => {
  const unit = setup(), failure = {checkout_completed: false, order_created_count: 0, error_code: 'PAY_BUTTON_HANDLER_MISSING'};
  const unfixed = unit.observations.map(o => o.arm === 'candidate' && o.cohort === 'mobile' ? {...o, actual: failure} : o);
  const result = evaluateFixtureVerification(unit.admit(unit.receipt(unfixed)), unit.current); assert.equal(result.mechanism, 'reproduced'); assert.equal(result.correction, 'failed'); assert.equal(result.outcome, 'failed');
  const control = unit.observations.map(o => o.arm === 'known_good' && o.repeat === 1 ? {...o, actual: failure} : o);
  assert.equal(evaluateFixtureVerification(unit.admit(unit.receipt(control)), unit.current).outcome, 'inconclusive');
  const missing = unit.observations.slice(1); assert.equal(evaluateFixtureVerification(unit.admit(unit.receipt(missing)), unit.current).outcome, 'inconclusive');
  const duplicate = [...unit.observations.slice(0, 17), unit.observations[0]!]; assert.equal(evaluateFixtureVerification(unit.admit(unit.receipt(duplicate)), unit.current).outcome, 'inconclusive');
});
test('unit evaluator rejects wrong observation bindings and marks changed inputs or withdrawn evidence stale', () => {
  const unit = setup(), wrong = unit.observations.map((o, i) => i === 0 ? {...o, snapshot_hash: undefined, plan_hash: digest('another-plan')} : o);
  // Keep canonical payload strict: snapshot_hash is not part of observation schema.
  delete (wrong[0] as Record<string, unknown>).snapshot_hash;
  assert.equal(evaluateFixtureVerification(unit.admit(unit.receipt(wrong)), unit.current).outcome, 'inconclusive');
  const changedArms = structuredClone(unit.plan.arms); changedArms.find(a => a.arm === 'candidate')!.build_digest = digest('changed-candidate');
  for (const current of [{...unit.current, metric_hash: digest('edited-metric')}, {...unit.current, plan_hash: digest('changed-plan')}, {...unit.current, observation_profile_hash: digest('changed-profile')}, {...unit.current, arms: changedArms}]) {
    const result = evaluateFixtureVerification(unit.admit(unit.receipt()), current); assert.equal(result.freshness, 'stale'); assert.equal(result.correction, 'inconclusive');
  }
  const admitted = unit.admit(unit.receipt()); fs.writeFileSync(unitArtifact, Buffer.from('corrupted evidence'));
  assert.equal(evaluateFixtureVerification(admitted, unit.current).freshness, 'stale');
  assert.throws(() => unit.admit(unit.receipt()), code('ARTIFACT_VERIFICATION_FAILED'));
  fs.writeFileSync(unitArtifact, unitPng);
});
test('unit evaluator treats missing receipts, cancellation and flaky repetitions as nonpassing states', () => {
  const unit = setup();
  for (const status of ['blocked', 'cancelled', 'failed'] as const) {
    const rows = unit.observations.map((o, i) => i === 0 ? {...o, status, actual: null} : o);
    const result = evaluateFixtureVerification(unit.admit(unit.receipt(rows)), unit.current);
    assert.equal(result.outcome, status === 'cancelled' ? 'cancelled' : 'blocked'); assert.equal(result.correction, 'inconclusive');
  }
  const flaky = unit.observations.map(o => o.arm === 'incident' && o.cohort === 'mobile' && o.repeat === 1 ? {...o, actual: {checkout_completed: true, order_created_count: 1, error_code: null}} : o);
  assert.equal(evaluateFixtureVerification(unit.admit(unit.receipt(flaky)), unit.current).mechanism, 'inconclusive');
  const healthyIncident = unit.observations.map(o => o.arm === 'incident' && o.cohort === 'mobile' ? {...o, actual: {checkout_completed: true, order_created_count: 1, error_code: null}} : o);
  assert.equal(evaluateFixtureVerification(unit.admit(unit.receipt(healthyIncident)), unit.current).mechanism, 'not_reproduced');
});
test('receipt authentication rejects JSON flags, tampering, replay, missing attempt bindings and UI/receipt disagreement', () => {
  const unit = setup(), valid = unit.receipt(), consumed = new Set<string>();
  const tampered = structuredClone(valid); tampered.observations[0]!.actual!.order_created_count = 0;
  assert.throws(() => unit.admit(tampered), code('RUNNER_AUTHENTICATION_FAILED'));
  assert.throws(() => evaluateFixtureVerification({receipt: valid, plan: unit.plan}, unit.current), code('UNADMITTED_RUNNER_RECEIPT'));
  const admitted = admitFixtureReceipt(valid, unit.plan, secret, unit.expected, consumed);
  assert.throws(() => admitFixtureReceipt(valid, unit.plan, secret, unit.expected, consumed), code('REPLAYED_OR_EXPIRED_RECEIPT'));
  assert.throws(() => {admitted.receipt.observations[0]!.actual!.order_created_count = 0;}, TypeError);
  const disagreement = structuredClone(valid); disagreement.attempts[0]!.receipt_completed = false;
  const {signature: _signature, ...body} = disagreement; disagreement.signature = authenticateValue(body, secret);
  assert.throws(() => unit.admit(disagreement), code('INCONSISTENT_CHECKOUT_RECEIPT'));
});
test('native fixture scope refuses external origins, changed protected oracle, no-op candidates, revoked or wrong approvals', () => {
  const unit = setup(), external = structuredClone(unit.plan); external.arms[0]!.origin = 'https://example.com';
  assert.throws(() => validateFixturePlan(external), code('EXTERNAL_TARGET_DENIED'));
  assert.throws(() => validateFixturePlan({...unit.plan, mode: 'verified_staging'}), code('EXTERNAL_RUNNER_UNAVAILABLE'));
  assert.throws(() => validateFixturePlan({...unit.plan, oracle_hash: digest('edited-oracle')}), code('PROTECTED_ORACLE_MISMATCH'));
  const noop = structuredClone(unit.plan); noop.arms.find(a => a.arm === 'candidate')!.build_digest = noop.arms.find(a => a.arm === 'incident')!.build_digest;
  assert.throws(() => validateFixturePlan(noop), code('NOOP_CANDIDATE'));
  const grant = {id: 'grant-unit', workspace_id: unit.plan.workspace_id, origins: unit.plan.arms.map(a => a.origin) as [string, ...string[]], expires_at: new Date(Date.now() + 600_000).toISOString(), revoked: false};
  const approval = {plan_hash: hash(unit.plan), oracle_hash: unit.plan.oracle_hash, workspace_id: unit.plan.workspace_id, reviewer_id: 'explicit-unit-test-reviewer', reviewer_role: 'owner' as const, grant_hash: hash(grant), expires_at: grant.expires_at, revoked: false};
  assert.equal(authorizeFixturePlan(unit.plan, approval, grant).objective, 'correction');
  assert.throws(() => authorizeFixturePlan(unit.plan, {...approval, revoked: true}, grant), code('APPROVAL_REVOKED'));
  assert.throws(() => authorizeFixturePlan(unit.plan, {...approval, plan_hash: digest('old-plan')}, grant), code('APPROVAL_BINDING_MISMATCH'));
});
