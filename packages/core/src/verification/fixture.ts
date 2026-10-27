import {createHmac, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {byteHash, canonical, hash} from '../canonical.js';
import {demand} from '../errors.js';
import {validateContract} from '../../../contracts/src/validate.js';
import type {FaultlineApproval, FaultlineBrowserPlan, FaultlineObservation, FaultlineOracle, FaultlineTargetGrant, FaultlineVerificationResult} from '../../../contracts/src/generated.js';

export type Arm = FaultlineObservation['arm'];
export type Cohort = FaultlineObservation['cohort'];
export interface CurrentVerificationBinding {
  workspace_id: string; case_id: string; revision_id: string; hypothesis_id: string;
  metric_hash: string; snapshot_hash: string; fixture_hash: string; environment_hash: string;
  oracle_hash: string; runner_id: string; plan_hash: string; observation_profile_hash: string;
  arms: FaultlineBrowserPlan['arms'];
}
export interface DeploymentReceipt {
  deployment_id: string; origin: string; build_digest: string; nonce: string;
  observed_at: string; attester_id: string; signature: string;
}
export interface FixtureAttempt {
  attempt_id: string; arm: Arm; cohort: Cohort; repeat: number;
  observation_hash: string; ui_completed: boolean | null; receipt_completed: boolean | null;
  before: DeploymentReceipt; after: DeploymentReceipt;
  artifacts: {path: string; sha256: string; size_bytes: number; media_type: string}[];
  errors: string[];
}
export interface FixtureRunReceipt {
  version: 1; scope: 'trusted_fixture'; runner_id: string;
  job_id: string; lease_id: string; nonce: string; plan_hash: string;
  observation_profile_hash: string; started_at: string; finished_at: string;
  engine: {name: 'chromium'; channel: 'msedge' | 'chromium'; version: string};
  observations: FaultlineObservation[]; attempts: FixtureAttempt[]; signature: string;
}
export interface FixtureAdmissionExpectation {
  job_id: string; lease_id: string; nonce: string; expires_at: string;
  observation_profile_hash: string;
  artifact_directory: string;
  deployments: Record<string, {deployment_id: string; attester_id: string}>;
}
export interface AdmittedFixtureReceipt {readonly receipt: FixtureRunReceipt; readonly plan: FaultlineBrowserPlan;}
const admissions = new WeakSet<object>();
const artifactRoots = new WeakMap<object, string>();
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freezeTree(child); Object.freeze(value);}
  return value;
}
const withoutSignature = <T extends {signature: string}>(value: T): Omit<T, 'signature'> => {const {signature: _signature, ...body} = value; return body;};
export function authenticateValue(value: unknown, secret: Buffer): string {
  demand(secret.length >= 32, 'INVALID_RUNNER_KEY', 'Runner authentication requires a registered 256-bit key');
  return createHmac('sha256', secret).update(canonical(value)).digest('hex');
}
function signatureValid(body: unknown, signature: unknown, secret: Buffer): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(authenticateValue(body, secret), 'hex'));
}
export function protectedFixtureOracle(objective: 'mechanism' | 'correction'): FaultlineOracle {
  const correction = objective === 'correction';
  return validateContract<FaultlineOracle>('oracle', {
    version: correction ? 'checkout_completion_v1' : 'checkout_mechanism_v1',
    arms: correction ? ['known_good', 'incident', 'candidate'] : ['known_good', 'incident'],
    cohorts: ['mobile', 'desktop'], repeats: 3,
    assertions: ['checkout_completed', 'order_created_count', 'error_code'],
    required_controls: correction ? ['known_good_mobile', 'known_good_desktop', 'incident_desktop', 'candidate_desktop'] : ['known_good_mobile', 'known_good_desktop', 'incident_desktop'],
    scope: 'Controlled synthetic checkout only; no aggregate causal effect.',
  });
}
export function validateFixturePlan(planValue: unknown): FaultlineBrowserPlan {
  const plan = validateContract<FaultlineBrowserPlan>('browser-plan', planValue);
  demand(plan.mode === 'trusted_fixture', 'EXTERNAL_RUNNER_UNAVAILABLE', 'Native runner accepts only supplied trusted fixtures; external targets require a registered hardened runner');
  demand(typeof plan.observation_profile_hash === 'string' && /^[a-f0-9]{64}$/.test(plan.observation_profile_hash), 'MISSING_OBSERVATION_PROFILE', 'Native verification requires its exact immutable observation profile binding');
  const oracle = protectedFixtureOracle(plan.objective);
  demand(plan.oracle_hash === hash(oracle) && plan.policy_version === oracle.version, 'PROTECTED_ORACLE_MISMATCH', 'Protected controls/assertions cannot be edited by the plan');
  demand(plan.arms.map(a => a.arm).join(',') === oracle.arms.join(','), 'INVALID_MATRIX', 'Plan must include every protected arm in canonical order');
  for (const arm of plan.arms) {
    const url = new URL(arm.origin);
    demand(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password && url.origin === arm.origin, 'EXTERNAL_TARGET_DENIED', 'Trusted fixture origins must be exact registered loopback origins');
  }
  const incident = plan.arms.find(a => a.arm === 'incident')!, candidate = plan.arms.find(a => a.arm === 'candidate');
  demand(!candidate || candidate.build_digest !== incident.build_digest, 'NOOP_CANDIDATE', 'Candidate cannot be the same immutable artifact as the incident');
  for (const action of plan.actions) {
    if (action.op === 'navigate') {
      demand(action.path === '/', 'FIXTURE_PATH_DENIED', 'Supplied checkout fixture only permits its root checkout navigation');
    } else {
      demand(action.locator.kind === 'test_id' && ['pay', 'checkout-status'].includes(action.locator.value), 'FIXTURE_LOCATOR_DENIED', 'Fixture actions require protected checkout test identifiers');
      demand(action.op !== 'fill', 'FIXTURE_VALUE_DENIED', 'Supplied fixture has no input fields or credentials');
      if (action.op === 'click') demand(action.locator.value === 'pay', 'FIXTURE_ACTION_DENIED', 'Only the sandbox checkout button may be clicked');
    }
  }
  demand(plan.actions[0]!.op === 'navigate', 'INVALID_ACTION_ORDER', 'Checkout action plan must first navigate to the supplied fixture');
  return plan;
}
function verifyArtifactRefs(receipt: FixtureRunReceipt, directory: string): string {
  let root: string;
  try {root = fs.realpathSync(directory);} catch {throw new Error('ARTIFACT_DIRECTORY_UNAVAILABLE');}
  let total = 0;
  for (const attempt of receipt.attempts) {
    demand(Array.isArray(attempt.artifacts) && attempt.artifacts.length <= 5, 'ARTIFACT_VERIFICATION_FAILED', 'Attempt artifact references are missing or unbounded');
    const observation = receipt.observations.find(o => o.arm === attempt.arm && o.cohort === attempt.cohort && o.repeat === attempt.repeat);
    demand(observation?.status !== 'observed' || attempt.artifacts.length > 0, 'ARTIFACT_VERIFICATION_FAILED', 'Every observed attempt requires its actual screenshot artifact');
    for (const artifact of attempt.artifacts) {
      demand(artifact.media_type === 'image/png' && /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes > 0 && artifact.size_bytes <= 10 * 1024 * 1024, 'ARTIFACT_VERIFICATION_FAILED', 'Screenshot artifact metadata is invalid');
      const location = path.resolve(artifact.path);
      demand(path.isAbsolute(artifact.path) && location.startsWith(root + path.sep), 'ARTIFACT_SCOPE_DENIED', 'Screenshot reference must remain inside its registered task artifact directory');
      let bytes: Buffer;
      try {
        const info = fs.lstatSync(location), real = fs.realpathSync(location);
        demand(info.isFile() && !info.isSymbolicLink() && real.startsWith(root + path.sep) && info.size === artifact.size_bytes, 'ARTIFACT_VERIFICATION_FAILED', 'Screenshot file is unavailable or differs from its registered reference');
        bytes = fs.readFileSync(location);
      } catch {throw new Error('ARTIFACT_VERIFICATION_FAILED');}
      demand(bytes.length === artifact.size_bytes && byteHash(bytes) === artifact.sha256 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'ARTIFACT_VERIFICATION_FAILED', 'Screenshot bytes do not match their authenticated hash or PNG type');
      total += bytes.length; demand(total <= 100 * 1024 * 1024, 'ARTIFACT_VERIFICATION_FAILED', 'Receipt exceeds its total artifact budget');
    }
  }
  return root;
}
export function authorizeFixturePlan(planValue: unknown, approvalValue: unknown, grantValue: unknown, clock = new Date()): FaultlineBrowserPlan {
  const plan = validateFixturePlan(planValue), approval = validateContract<FaultlineApproval>('approval', approvalValue), grant = validateContract<FaultlineTargetGrant>('target-grant', grantValue);
  demand(!grant.revoked && !approval.revoked, 'APPROVAL_REVOKED', 'Exact fixture approval and target grant must remain active', 403);
  demand(Date.parse(grant.expires_at) > clock.getTime() && Date.parse(approval.expires_at) > clock.getTime(), 'APPROVAL_EXPIRED', 'Exact fixture approval and grant have expired', 403);
  demand(plan.workspace_id === approval.workspace_id && plan.workspace_id === grant.workspace_id && approval.plan_hash === hash(plan) && approval.oracle_hash === plan.oracle_hash && approval.grant_hash === hash(grant), 'APPROVAL_BINDING_MISMATCH', 'Approval must bind this exact workspace, immutable plan, protected oracle and grant', 403);
  demand(plan.arms.every(a => grant.origins.includes(a.origin)), 'ORIGIN_NOT_GRANTED', 'Every fixture origin requires exact grant scope', 403);
  return plan;
}
/** Called only by a server-owned registered runner verifier. JSON authentication flags are irrelevant. */
export function admitFixtureReceipt(value: FixtureRunReceipt, planValue: unknown, secret: Buffer, expected: FixtureAdmissionExpectation, consumedNonces: Set<string>, clock = new Date()): AdmittedFixtureReceipt {
  const plan = validateFixturePlan(planValue);
  demand(value && value.version === 1 && value.scope === 'trusted_fixture' && Array.isArray(value.observations) && Array.isArray(value.attempts) && value.observations.length <= 18 && value.attempts.length <= 18, 'INVALID_RUNNER_RECEIPT', 'Malformed or unbounded fixture receipt');
  demand(signatureValid(withoutSignature(value), value.signature, secret), 'RUNNER_AUTHENTICATION_FAILED', 'Receipt did not authenticate against the registered runner key', 403);
  demand(value.job_id === expected.job_id && value.lease_id === expected.lease_id && value.nonce === expected.nonce && value.plan_hash === hash(plan) && value.runner_id === plan.runner_id && value.observation_profile_hash === expected.observation_profile_hash, 'RUNNER_TASK_BINDING_MISMATCH', 'Receipt belongs to another task, plan, profile or lease');
  demand(!consumedNonces.has(value.nonce) && Date.parse(expected.expires_at) > clock.getTime(), 'REPLAYED_OR_EXPIRED_RECEIPT', 'Runner receipt was replayed or its admission deadline expired');
  demand(Number.isFinite(Date.parse(value.started_at)) && Number.isFinite(Date.parse(value.finished_at)) && Date.parse(value.started_at) <= Date.parse(value.finished_at) && Date.parse(value.finished_at) <= clock.getTime() + 1000 && Date.parse(value.finished_at) - Date.parse(value.started_at) <= 600_000, 'INVALID_RUNNER_TIME', 'Receipt time lies outside the bounded execution window');
  demand(value.observations.length === value.attempts.length, 'MISSING_ATTEMPT_RECEIPT', 'Every observation requires its authenticated attempt receipt');
  const attemptIds = new Set<string>();
  value.observations.forEach((item, index) => {
    const observation = validateContract<FaultlineObservation>('observation', item), attempt = value.attempts[index]!;
    demand(/^[A-Za-z0-9_-]{8,100}$/.test(attempt.attempt_id) && !attemptIds.has(attempt.attempt_id), 'DUPLICATE_ATTEMPT', 'Every cell/repetition requires a fresh isolated attempt'); attemptIds.add(attempt.attempt_id);
    demand(attempt.observation_hash === hash(observation) && attempt.arm === observation.arm && attempt.cohort === observation.cohort && attempt.repeat === observation.repeat, 'ATTEMPT_BINDING_MISMATCH', 'Attempt receipt does not bind its observation');
    const arm = plan.arms.find(a => a.arm === observation.arm), deployment = expected.deployments[observation.arm];
    demand(arm && deployment, 'UNKNOWN_ARM', 'Receipt contains an unregistered arm');
    for (const [phase, proof] of [['before', attempt.before], ['after', attempt.after]] as const) {
      demand(proof && signatureValid(withoutSignature(proof), proof.signature, secret), 'DEPLOYMENT_AUTHENTICATION_FAILED', 'Independent deployment receipt did not authenticate');
      demand(proof.deployment_id === deployment.deployment_id && proof.attester_id === deployment.attester_id && proof.origin === arm.origin && proof.build_digest === arm.build_digest && proof.nonce === `${value.nonce}:${attempt.attempt_id}:${phase}`, 'DEPLOYMENT_BINDING_MISMATCH', 'Pre/post fixture deployment receipt has wrong nonce, origin or artifact');
      const time = Date.parse(proof.observed_at); demand(time >= Date.parse(value.started_at) - 1000 && time <= Date.parse(value.finished_at) + 1000, 'STALE_DEPLOYMENT_RECEIPT', 'Deployment observer receipt is outside this attempt run');
    }
    if (observation.status === 'observed') demand(typeof attempt.ui_completed === 'boolean' && typeof attempt.receipt_completed === 'boolean' && attempt.ui_completed === attempt.receipt_completed && observation.actual?.checkout_completed === attempt.ui_completed, 'INCONSISTENT_CHECKOUT_RECEIPT', 'UI completion and actual independent order receipt disagree');
  });
  let artifactRoot: string;
  try {artifactRoot = verifyArtifactRefs(value, expected.artifact_directory);} catch {demand(false, 'ARTIFACT_VERIFICATION_FAILED', 'Referenced screenshot evidence is absent, out of scope or has changed bytes');}
  consumedNonces.add(value.nonce);
  const admitted = freezeTree({receipt: structuredClone(value), plan: structuredClone(plan)}); admissions.add(admitted); artifactRoots.set(admitted, artifactRoot!); return admitted;
}
const healthy = (o: FaultlineObservation) => o.actual?.checkout_completed === true && o.actual.order_created_count === 1 && o.actual.error_code === null;
const incidentFailure = (o: FaultlineObservation) => o.actual?.checkout_completed === false && o.actual.order_created_count === 0 && o.actual.error_code === 'PAY_BUTTON_HANDLER_MISSING';
export function evaluateFixtureVerification(admitted: AdmittedFixtureReceipt, current: CurrentVerificationBinding, association: 'observed' | 'not_established' = 'not_established'): FaultlineVerificationResult {
  demand(admissions.has(admitted), 'UNADMITTED_RUNNER_RECEIPT', 'Verification requires a cryptographically admitted server-owned runner receipt', 403);
  const {plan, receipt} = admitted, observations = receipt.observations;
  const base = {association, freshness: 'fresh' as const, attribution: {scope: 'association_only' as const, causal_effect: 'not_established' as const}, expected_runs: (plan.objective === 'mechanism' ? 12 : 18) as 12 | 18, observed_runs: observations.length, plan_hash: hash(plan), mode: 'trusted_fixture' as const, production_claim_eligible: false, workspace_id: plan.workspace_id, case_id: plan.case_id, revision_id: plan.revision_id, hypothesis_id: plan.hypothesis_id, metric_hash: plan.metric_hash, snapshot_hash: plan.snapshot_hash};
  const finish = (outcome: FaultlineVerificationResult['outcome'], mechanism: FaultlineVerificationResult['mechanism'], correction: FaultlineVerificationResult['correction'], reasons: string[], stale = false) => validateContract<FaultlineVerificationResult>('verification-result', {...base, outcome, mechanism, correction: plan.objective === 'mechanism' ? 'not_tested' : correction, freshness: stale ? 'stale' : 'fresh', reasons});
  const bound = ['workspace_id', 'case_id', 'revision_id', 'hypothesis_id', 'metric_hash', 'snapshot_hash', 'fixture_hash', 'environment_hash', 'oracle_hash', 'runner_id'] as const;
  if (bound.some(k => current[k] !== plan[k]) || current.plan_hash !== hash(plan) || current.observation_profile_hash !== plan.observation_profile_hash || hash(current.arms) !== hash(plan.arms)) return finish('inconclusive', 'inconclusive', 'inconclusive', ['current_plan_candidate_or_profile_binding_changed'], true);
  try {verifyArtifactRefs(receipt, artifactRoots.get(admitted)!);} catch {return finish('inconclusive', 'inconclusive', 'inconclusive', ['screenshot_evidence_unavailable_or_changed'], true);}
  if (!observations.length) return finish('not_run', 'untested', 'not_tested', ['no_browser_observations']);
  const keys = new Set<string>(), reasons: string[] = [];
  for (const o of observations) {
    const arm = plan.arms.find(a => a.arm === o.arm), key = `${o.arm}:${o.cohort}:${o.repeat}`;
    if (!arm || keys.has(key)) {reasons.push('duplicate_or_unexpected_observation'); continue;} keys.add(key);
    if (o.plan_hash !== hash(plan) || o.oracle_hash !== plan.oracle_hash || o.fixture_hash !== plan.fixture_hash || o.environment_hash !== plan.environment_hash || o.runner_id !== plan.runner_id || o.build_digest !== arm.build_digest || o.build_digest_after !== arm.build_digest || o.deployment_evidence_hash !== arm.deployment_evidence_hash) reasons.push('observation_binding_mismatch');
  }
  for (const arm of plan.arms) for (const cohort of plan.cohorts) for (let repeat = 1; repeat <= 3; repeat++) if (!keys.has(`${arm.arm}:${cohort}:${repeat}`)) reasons.push('missing_required_observation');
  if (reasons.length) return finish('inconclusive', 'inconclusive', 'inconclusive', [...new Set(reasons)]);
  if (observations.some(o => o.status === 'cancelled')) return finish('cancelled', 'inconclusive', 'inconclusive', ['required_attempt_cancelled']);
  if (observations.some(o => o.status === 'blocked' || o.status === 'failed' || o.actual === null)) return finish('blocked', 'inconclusive', 'inconclusive', ['required_attempt_unavailable']);
  const controls = observations.filter(o => o.arm === 'known_good' || o.cohort === 'desktop');
  if (!controls.every(healthy)) return finish('inconclusive', 'inconclusive', 'inconclusive', ['required_control_failed']);
  const incident = observations.filter(o => o.arm === 'incident' && o.cohort === 'mobile');
  if (incident.every(healthy)) return finish('failed', 'not_reproduced', 'not_tested', ['incident_failure_not_reproduced']);
  if (!incident.every(incidentFailure)) return finish('inconclusive', 'inconclusive', 'inconclusive', ['incident_repetitions_inconsistent_or_wrong_symptom']);
  if (plan.objective === 'mechanism') return finish('passed', 'reproduced', 'not_tested', []);
  const candidate = observations.filter(o => o.arm === 'candidate' && o.cohort === 'mobile');
  if (candidate.every(healthy)) return finish('passed', 'reproduced', 'validated', []);
  if (candidate.every(incidentFailure)) return finish('failed', 'reproduced', 'failed', ['candidate_retains_reproduced_failure']);
  return finish('inconclusive', 'reproduced', 'inconclusive', ['candidate_repetitions_inconsistent_or_unsupported_failure']);
}
