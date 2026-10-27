import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {casePath, type Investigation, type Workspace} from '../../api';
import type {Evidence} from './types';
import {BrowserActionEditor, ExternalApprovalRevocation, ExternalPlanReview, ExternalResultInspection, ExternalRunButton, ExternalRunHistory, ExternalVerificationPanel, defaultExternalActions, externalPlanInput, externalResultDetail, externalRunInput, localDateTimeInputToIso, localDateTimeInputValue, parseExternalActions, revokeExternalApproval} from './ExternalVerificationPanel';

const owner: Workspace = {id: 'workspace', name: 'Private unit scope', role: 'owner', revision: 1, created_at: '2026-10-17T00:00:00.000Z'};
const investigation: Investigation = {id: 'case', workspace_id: owner.id, title: 'External regression', question: 'What changed?', affected_flow: 'checkout', active_revision_id: 'revision', lifecycle: 'open', archived: false, revision: 3, created_at: owner.created_at, updated_at: owner.created_at};
const evidence: Evidence = {id: 'evidence-one', workspace_id: owner.id, case_id: investigation.id, revision_id: investigation.active_revision_id, snapshot_id: null, source_kind: 'human_note', source_ref: 'unit', content_hash: 'a'.repeat(64), captured_at: owner.created_at, event_time: {kind: 'unknown', raw_description: 'not supplied'}, text: 'Observed checkout failure', redaction_status: 'sanitized', evidence_status: 'user_attested', supersedes_id: null};

test('finite action parser accepts the declared DSL and rejects executable, cross-origin and unbounded inputs', () => {
  assert.deepEqual(parseExternalActions(JSON.stringify(defaultExternalActions)), defaultExternalActions);
  assert.deepEqual(parseExternalActions(JSON.stringify([{op: 'navigate', path: '/checkout'}, {op: 'fill', locator: {kind: 'label', value: 'Email'}, value_ref: 'synthetic_email'}, {op: 'wait_for', locator: {kind: 'role', role: 'button', value: 'Pay'}, timeout_ms: 5000}])), [{op: 'navigate', path: '/checkout'}, {op: 'fill', locator: {kind: 'label', value: 'Email'}, value_ref: 'synthetic_email'}, {op: 'wait_for', locator: {kind: 'role', role: 'button', value: 'Pay'}, timeout_ms: 5000}]);
  for (const invalid of [[{op: 'click', locator: {kind: 'test_id', value: 'pay'}}], [{op: 'navigate', path: 'https://outside.example'}], [{op: 'navigate', path: '/'}, {op: 'evaluate', script: 'steal()'}], Array.from({length: 31}, (_, index) => ({op: 'navigate', path: `/${index}`})), [{op: 'navigate', path: '/'}, {op: 'fill', locator: {kind: 'label', value: 'Email'}, value_ref: '__proto__'}]]) assert.throws(() => parseExternalActions(JSON.stringify(invalid)));
});

test('browser steps use plain form controls while preserving the finite action payload', () => {
  const markup = renderToStaticMarkup(<BrowserActionEditor actions={defaultExternalActions} onChange={() => {}}/>);
  assert.match(markup, /Open page/); assert.match(markup, /Click/); assert.match(markup, /Add step/); assert.match(markup, /name="actions"/);
  assert.doesNotMatch(markup, /<textarea|valid JSON|raw JSON/i);
});

test('plan input is finite, citation-scoped and requires a candidate for correction', () => {
  const form = new FormData(); for (const [name, value] of Object.entries({hypothesis_id: 'hypothesis-one', objective: 'mechanism', runner_id: 'runner-one', environment_id: 'environment-one', fixture_profile_id: 'fixture-one', observation_profile_id: 'observation-one', grant_id: 'grant-one', known_good_build_id: 'build-good', incident_build_id: 'build-incident', actions: JSON.stringify(defaultExternalActions)})) form.set(name, value); form.append('external_evidence', evidence.id);
  const input = externalPlanInput(form, [evidence]); assert.equal(input.objective, 'mechanism'); assert.deepEqual(input.evidence_ids, [evidence.id]); assert.equal(input.build_ids.candidate, undefined);
  form.set('objective', 'correction'); assert.throws(() => externalPlanInput(form, [evidence]), /candidate/); form.set('candidate_build_id', 'build-candidate'); assert.equal(externalPlanInput(form, [evidence]).build_ids.candidate, 'build-candidate');
  form.set('external_evidence', 'restricted'); assert.throws(() => externalPlanInput(form, [{...evidence, id: 'restricted', redaction_status: 'restricted'}]), /sanitized/);
});

test('datetime-local preserves the intended instant in a UTC+1 browser zone', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Etc/GMT-1';
    const instant = new Date('2030-01-02T09:04:05.000Z');
    assert.equal(localDateTimeInputValue(instant), '2030-01-02T10:04:05');
    assert.equal(localDateTimeInputToIso('2030-01-02T10:04:05'), instant.toISOString());
    assert.throws(() => localDateTimeInputToIso('2030-02-30T10:04:05'), /valid local date/);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('external approval revocation sends the exact bounded review and renders its acknowledgment', async () => {
  const plan = {id: 'plan:one', plan_hash: 'b'.repeat(64), oracle_hash: 'c'.repeat(64), revision_id: investigation.active_revision_id};
  const approval = {id: 'approval-one', plan_id: plan.id, plan_hash: plan.plan_hash, grant_id: 'grant-one', expires_at: '2099-01-02T09:04:05.000Z', revision: 7, revoked: false};
  let observed: {path: string; body: unknown; method?: string; revision?: number} | undefined;
  const send = async <T,>(path: string, body: unknown, method?: string, revision?: number) => {observed = {path, body, method, revision}; return {id: approval.id, value: {revoked: true}} as T;};
  await revokeExternalApproval(send, '/api/v1/workspaces/w/cases/c', plan, approval, '  Synthetic run no longer authorized.  ');
  assert.deepEqual(observed, {path: '/api/v1/workspaces/w/cases/c/browser-plans/plan%3Aone/approval-revocations', body: {approval_id: approval.id, reason: 'Synthetic run no longer authorized.'}, method: 'POST', revision: 7});
  const markup = renderToStaticMarkup(<ExternalApprovalRevocation approval={approval} current reviewing reason="Synthetic run no longer authorized." acknowledged={false} pending="" onBegin={() => {}} onCancel={() => {}} onReason={() => {}} onAcknowledged={() => {}} onSubmit={() => {}}/>);
  assert.match(markup, /Revoke approval/); assert.match(markup, /Reason/); assert.match(markup, /maxLength="2000"/i); assert.match(markup, /intend to withdraw its authority/); assert.match(markup, /Revoke approval/);
  assert.throws(() => externalRunInput(plan, {...approval, revoked: true}), /does not bind/);
  assert.throws(() => externalRunInput(plan, {...approval, expires_at: '2020-01-01T00:00:00.000Z'}), /expired/);
});

test('recorded completion and exploratory result never render as passing verification', () => {
  const markup = renderToStaticMarkup(<ExternalRunHistory base="/api/v1/workspaces/w/cases/c" runs={[{id: 'run-one', plan_id: 'plan-one', approval_id: 'approval-one', job_id: 'job-one', status: 'completed'}]} results={[{id: 'result-one', run_id: 'run-one', plan_id: 'plan-one', status: 'completed', outcome: 'passed', mode: 'exploratory', verification_limit_reason: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED'}]}/>);
  assert.match(markup, /Exploratory evidence only/); assert.match(markup, /INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED/); assert.match(markup, /does not prove the cause/); assert.doesNotMatch(markup, /status good/);
  assert.match(markup, /View results/); assert.match(markup, /aria-expanded="false"/);
});

test('external result inspection admits and renders the complete safe attempt matrix without a passing claim', () => {
  const digest = 'a'.repeat(64), observedAt = '2026-10-17T12:00:00.000Z';
  const observations = Array.from({length: 12}, (_, index) => ({
    arm: index < 6 ? 'known_good' : 'incident', cohort: index % 6 < 3 ? 'mobile' : 'desktop', repeat: index % 3 + 1, status: index === 7 ? 'blocked' : 'observed',
    plan_hash: digest, oracle_hash: digest, build_digest: digest, build_digest_after: digest, deployment_evidence_hash: digest, fixture_hash: digest, environment_hash: digest, runner_id: 'runner-one',
    actual: index === 7 ? null : {checkout_completed: index < 6, order_created_count: index < 6 ? 1 : 0, error_code: index < 6 ? null : 'PAY_BUTTON_HANDLER_MISSING'},
  }));
  const attempts = observations.map((item, index) => ({attempt_id: `attempt-${String(index + 1).padStart(8, '0')}`, arm: item.arm, cohort: item.cohort, repeat: item.repeat, status: item.status, started_at: observedAt, finished_at: '2026-10-17T12:00:01.000Z', observation_hash: digest, ui_completed: item.actual?.checkout_completed ?? null, receipt_completed: item.actual?.checkout_completed ?? null, network_request_count: 4, denied_requests: index === 7 ? [{code: 'PATH_DENIED', origin: null, path: null}] : [], errors: index === 7 ? ['NETWORK_SCOPE_VIOLATION'] : [], deployment: {arm: item.arm, deployment_id: `deployment-${item.arm}`, attester_id: 'attester-one', origin: `https://${item.arm}.example.test`, build_digest: digest, deployment_evidence_hash: digest}}));
  const detail = externalResultDetail({id: 'result-one', run_id: 'run-one', plan_id: 'plan-one', outcome: 'inconclusive', mode: 'exploratory', freshness: 'fresh', verification_limit_reason: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', production_claim_eligible: false, observed_runs: 12, result_hash: digest, created_at: observedAt, observations, attempts, artifacts: []}, 'result-one');
  const markup = renderToStaticMarkup(<ExternalResultInspection result={detail}/>);
  assert.match(markup, /Test results/); assert.match(markup, /Run details/); assert.match(markup, /attempt-00000012/); assert.match(markup, /PATH_DENIED/); assert.match(markup, /PATH_DENIED/); assert.match(markup, /NETWORK_SCOPE_VIOLATION/); assert.match(markup, /Exploratory only/); assert.match(markup, /Aggregate|exploratory/i); assert.doesNotMatch(markup, /status good/);
  assert.throws(() => externalResultDetail({...detail, production_claim_eligible: true}, detail.id), /incomplete/);
  assert.throws(() => externalResultDetail({...detail, artifacts: [{id: 'unexpected'}]}, detail.id), /incomplete or unbounded/);
  assert.throws(() => externalResultDetail({...detail, attempts: detail.attempts.map((item, index) => index === 0 ? {...item, denied_requests: [{code: 'PATH_DENIED', origin: 'https://secret.example', path: '/secret'}]} : item)}, detail.id), /denied-request/);
});

test('configured immutable records render exact hashes while an unavailable runner disables run', () => {
  const hash = 'b'.repeat(64), plan = {id: 'plan-one', plan_hash: hash, oracle_hash: 'c'.repeat(64), revision_id: investigation.active_revision_id, objective: 'mechanism' as const, runner_id: 'runner-one'};
  const review = renderToStaticMarkup(<ExternalPlanReview plan={plan}/>); assert.match(review, /Plan details/); assert.match(review, new RegExp(hash)); assert.match(review, /runner-one/);
  let called = false; const blocked = renderToStaticMarkup(<ExternalRunButton disabled pending="" onRun={() => {called = true;}}/>); assert.match(blocked, /disabled=""/); assert.match(blocked, /Run approved browser test/); assert.equal(called, false);
});

test('viewer surface is read-only and unknown initial state does not expose mutation controls', () => {
  const markup = renderToStaticMarkup(<ExternalVerificationPanel base={casePath(owner.id, investigation.id)} workspace={{...owner, role: 'viewer'}} csrf="csrf" investigation={investigation} hypotheses={[]} evidence={[]} refreshToken={0} onChanged={async () => {}}/>);
  assert.match(markup, /Read only/); assert.match(markup, /cannot create, approve, or run/); assert.doesNotMatch(markup, /Save test plan|Approve this plan|Run approved browser test/);
});
