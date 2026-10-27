import assert from 'node:assert/strict';
import test from 'node:test';
import {hash} from '../../../packages/core/src/canonical.js';
import {DomainError} from '../../../packages/core/src/errors.js';
import type {FaultlineTargetGrant} from '../../../packages/contracts/src/generated.js';
import {runExternalTask, validateExternalTask, type ExternalTaskDependencies, type ExternalTaskInput, type RunnerBrowser, type RunnerBrowserContext, type RunnerLocator, type RunnerPage, type RunnerRoute, type RunnerWebSocket} from './external-task.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const sha = (value: string) => hash({value});
const arms = ['known_good', 'incident'] as const;

function task(changes: {fill?: boolean; omitValue?: boolean; grantOrigins?: string[]} = {}): ExternalTaskInput {
  const profileUnsigned = {
    schema_version: 1 as const,
    id: 'profile-one', workspace_id: 'workspace-one', case_id: 'case-one', revision_id: 'revision-one', template: 'checkout_receipt_v1' as const,
    success_locator: {kind: 'test_id' as const, value: 'checkout-complete'},
    receipt: {path_template: '/__faultline/receipts/{attempt_id}', method: 'GET' as const, credential_ref: null, completed_pointer: '/completed', order_count_pointer: '/order_count', error_code_pointer: '/error_code', max_response_bytes: 4096},
    incident_error_code: 'DECLINED', symptom_evidence_ids: ['evidence-one'] as [string], sandbox_only: true as const,
    created_at: NOW.toISOString(), reviewed_by: 'owner-one',
  };
  const observation_profile = {...profileUnsigned, profile_hash: hash(profileUnsigned)};
  const plan = {
    version: 1 as const, workspace_id: 'workspace-one', case_id: 'case-one', revision_id: 'revision-one', hypothesis_id: 'hypothesis-one',
    objective: 'mechanism' as const, mode: 'verified_staging' as const, policy_version: 'checkout_mechanism_v1' as const,
    oracle_hash: sha('oracle'), metric_hash: sha('metric'), snapshot_hash: sha('snapshot'), fixture_hash: sha('fixture'), environment_hash: sha('environment'),
    runner_id: 'railway-runner-one', repeats: 3 as const, cohorts: ['mobile', 'desktop'] as ['mobile', 'desktop'],
    actions: [
      {op: 'navigate' as const, path: '/checkout'},
      ...(changes.fill ? [{op: 'fill' as const, locator: {kind: 'label' as const, value: 'Email'}, value_ref: 'checkout_email'}] : []),
      {op: 'click' as const, locator: {kind: 'role' as const, role: 'button' as const, value: 'Pay'}},
    ] as ExternalTaskInput['plan']['actions'],
    arms: arms.map(arm => ({arm, origin: `https://${arm.replace('_', '-')}.example.test`, build_digest: sha(`${arm}-build`), deployment_evidence_hash: sha(`${arm}-deployment`)})) as ExternalTaskInput['plan']['arms'],
    observation_profile_hash: observation_profile.profile_hash,
  };
  const grant: FaultlineTargetGrant = {id: 'grant-one', workspace_id: plan.workspace_id, origins: (changes.grantOrigins ?? plan.arms.map(arm => arm.origin)) as FaultlineTargetGrant['origins'], expires_at: '2026-10-17T13:00:00.000Z', revoked: false};
  const approval = {plan_hash: hash(plan), oracle_hash: plan.oracle_hash, workspace_id: plan.workspace_id, reviewer_id: 'owner-one', reviewer_role: 'owner' as const, grant_hash: hash(grant), expires_at: '2026-10-17T13:00:00.000Z', revoked: false};
  const networkUnsigned = {version: 1 as const, origins: plan.arms.map(arm => arm.origin), path_prefixes: ['/checkout', '/__faultline/receipts/'], resolved_addresses: Object.fromEntries(plan.arms.map(arm => [new URL(arm.origin).hostname, ['93.184.216.34']])), deny_private_addresses: true as const, max_response_bytes: 4096};
  const network_profile = {...networkUnsigned, profile_hash: hash(networkUnsigned)};
  const deployments = plan.arms.map((arm, index) => ({arm: arm.arm, deployment_id: `deployment-${index}`, attester_id: 'operator-attester-one', origin: arm.origin, build_digest: arm.build_digest, deployment_evidence_hash: arm.deployment_evidence_hash}));
  const value_refs: Record<string, string> = changes.fill && !changes.omitValue ? {checkout_email: 'synthetic@example.test'} : {};
  return {version: 1, plan, approval, grant, observation_profile, network_profile, deployments, value_refs, task: {
    job_id: 'job-external-one', lease_id: 'lease-external-one', nonce: 'task_nonce_external_0001', expires_at: '2026-10-17T12:05:00.000Z',
    plan_hash: hash(plan), approval_hash: hash(approval), grant_hash: hash(grant), observation_profile_hash: observation_profile.profile_hash, network_profile_hash: network_profile.profile_hash, runner_id: plan.runner_id,
  }};
}

type Behavior = {
  requestUrl?: string;
  redirectUrl?: string;
  actionTimeout?: boolean;
  visible?: boolean;
  receiptBody?: string;
  receiptHeaders?: Record<string, string>;
};

class FakeLocator implements RunnerLocator {
  constructor(private behavior: Behavior) {}
  async click(): Promise<void> {if (this.behavior.actionTimeout) {const error = new Error('action timeout'); error.name = 'TimeoutError'; throw error;}}
  async fill(): Promise<void> {if (this.behavior.actionTimeout) {const error = new Error('action timeout'); error.name = 'TimeoutError'; throw error;}}
  async waitFor(): Promise<void> {if (this.behavior.actionTimeout) {const error = new Error('action timeout'); error.name = 'TimeoutError'; throw error;}}
  async isVisible(): Promise<boolean> {return this.behavior.visible ?? true;}
}

class FakePage implements RunnerPage {
  private current = 'about:blank';
  constructor(private behavior: Behavior, private request: (url: string) => Promise<void>) {}
  setDefaultTimeout(): void {}
  async goto(url: string): Promise<void> {
    await this.request(url);
    if (this.behavior.requestUrl) await this.request(this.behavior.requestUrl);
    this.current = this.behavior.redirectUrl ?? url;
  }
  url(): string {return this.current;}
  getByTestId(): RunnerLocator {return new FakeLocator(this.behavior);}
  getByLabel(): RunnerLocator {return new FakeLocator(this.behavior);}
  getByRole(): RunnerLocator {return new FakeLocator(this.behavior);}
  on(): void {}
}

class FakeContext implements RunnerBrowserContext {
  private routeHandler?: (route: RunnerRoute) => Promise<void>;
  constructor(private behavior: Behavior, readonly tracker: Tracker) {}
  async route(_pattern: '**/*', handler: (route: RunnerRoute) => Promise<void>): Promise<void> {this.routeHandler = handler;}
  async routeWebSocket(_pattern: '**/*', _handler: (socket: RunnerWebSocket) => void): Promise<void> {}
  async newPage(): Promise<RunnerPage> {
    return new FakePage(this.behavior, async url => {
      assert(this.routeHandler);
      await this.routeHandler({request: () => ({url: () => url, method: () => 'GET'}), continue: async () => {this.tracker.continued += 1;}, abort: async () => {this.tracker.aborted += 1;}});
    });
  }
  async close(): Promise<void> {this.tracker.contextsClosed += 1;}
}

type Tracker = {contexts: number; contextsClosed: number; browserClosed: number; continued: number; aborted: number};

function dependencies(behavior: Behavior = {}, signal?: AbortSignal): {deps: ExternalTaskDependencies; tracker: Tracker} {
  const tracker: Tracker = {contexts: 0, contextsClosed: 0, browserClosed: 0, continued: 0, aborted: 0};
  let attempts = 0;
  const browser: RunnerBrowser = {
    newContext: async () => {tracker.contexts += 1; return new FakeContext(behavior, tracker);},
    version: () => 'fake-1',
    close: async () => {tracker.browserClosed += 1;},
  };
  const deps: ExternalTaskDependencies = {
    browserFactory: async policy => {assert.equal(policy.origins.length, 2); return browser;},
    fetch: async (_input, init) => {
      init.signal.throwIfAborted();
      const body = behavior.receiptBody ?? JSON.stringify({completed: true, order_count: 1, error_code: null});
      return new Response(body, {status: 200, headers: {'content-type': 'application/json', ...behavior.receiptHeaders}});
    },
    clock: () => new Date(NOW),
    attemptId: () => `attempt_id_${String(++attempts).padStart(8, '0')}`,
    signal,
  };
  return {deps, tracker};
}

function code(error: unknown): string | undefined {return error instanceof DomainError ? error.code : undefined;}

test('valid task produces every canonical raw attempt with fresh context and no outcome claim', async () => {
  const input = task({fill: true}), {deps, tracker} = dependencies();
  const result = await runExternalTask(input, deps);
  assert.equal(result.mode, 'exploratory');
  assert.equal(result.verification_limit_reason, 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED');
  assert.equal(result.observations.length, 12);
  assert.equal(result.attempts.length, 12);
  assert.equal(new Set(result.attempts.map(item => item.attempt_id)).size, 12);
  assert(result.observations.every(item => item.status === 'observed' && item.actual?.order_created_count === 1));
  assert.deepEqual(result.attempts.map(item => `${item.arm}:${item.cohort}:${item.repeat}`), [
    'known_good:mobile:1', 'known_good:mobile:2', 'known_good:mobile:3', 'known_good:desktop:1', 'known_good:desktop:2', 'known_good:desktop:3',
    'incident:mobile:1', 'incident:mobile:2', 'incident:mobile:3', 'incident:desktop:1', 'incident:desktop:2', 'incident:desktop:3',
  ]);
  assert.equal(tracker.contexts, 12);
  assert.equal(tracker.contextsClosed, 12);
  assert.equal(tracker.browserClosed, 1);
  assert(!Object.hasOwn(result, 'outcome'));
});

test('out-of-scope owner origin is rejected before browser creation', async () => {
  const input = task({grantOrigins: ['https://known-good.example.test']});
  input.approval.grant_hash = hash(input.grant);
  input.task.grant_hash = hash(input.grant);
  input.task.approval_hash = hash(input.approval);
  const {deps, tracker} = dependencies();
  await assert.rejects(runExternalTask(input, deps), error => code(error) === 'ORIGIN_NOT_GRANTED');
  assert.equal(tracker.contexts, 0);
});

test('out-of-scope browser request is aborted and blocks each affected observation', async () => {
  const {deps, tracker} = dependencies({requestUrl: 'https://evil.example.test/beacon'});
  const result = await runExternalTask(task(), deps);
  assert.equal(tracker.aborted, 12);
  assert(result.observations.every(item => item.status === 'blocked' && item.actual === null));
  assert(result.attempts.every(item => item.denied_requests.some(denied => denied.code === 'ORIGIN_DENIED' && denied.origin === null && denied.path === null)));
});

test('unexpected receipt error text is projected to a fixed code instead of returning target-controlled content', async () => {
  const {deps}=dependencies({receiptBody:JSON.stringify({completed:true,order_count:1,error_code:'target-controlled-private-text'})});
  const result=await runExternalTask(task(),deps);
  assert(result.observations.every(item=>item.actual?.error_code==='UNEXPECTED_ERROR_CODE'));
  assert.equal(JSON.stringify(result).includes('target-controlled-private-text'),false);
});

test('out-of-scope redirect is blocked even when initial navigation was allowed', async () => {
  const {deps} = dependencies({redirectUrl: 'https://evil.example.test/checkout'});
  const result = await runExternalTask(task(), deps);
  assert(result.observations.every(item => item.status === 'blocked'));
  assert(result.attempts.every(item => item.errors.includes('REDIRECT_SCOPE_DENIED')));
});

test('wrong approval binding and expired authority are independently rejected', () => {
  const wrong = task();
  wrong.approval.plan_hash = sha('wrong-plan');
  wrong.task.approval_hash = hash(wrong.approval);
  assert.throws(() => validateExternalTask(wrong, NOW), error => code(error) === 'APPROVAL_BINDING_MISMATCH');
  const expired = task();
  expired.approval.expires_at = '2026-10-17T11:59:59.000Z';
  expired.task.approval_hash = hash(expired.approval);
  assert.throws(() => validateExternalTask(expired, NOW), error => code(error) === 'APPROVAL_EXPIRED');
  const staleLease = task();
  staleLease.task.expires_at = '2026-10-17T11:59:59.000Z';
  assert.throws(() => validateExternalTask(staleLease, NOW), error => code(error) === 'RUNNER_TASK_INVALID');
});

test('missing fill value reference is rejected before execution', async () => {
  const input = task({fill: true, omitValue: true}), {deps, tracker} = dependencies();
  await assert.rejects(runExternalTask(input, deps), error => code(error) === 'VALUE_REF_MISSING');
  assert.equal(tracker.contexts, 0);
});

test('oversize and malformed receipt bodies become explicit blocked observations', async t => {
  await t.test('oversize', async () => {
    const {deps} = dependencies({receiptBody: 'x'.repeat(4097)});
    const result = await runExternalTask(task(), deps);
    assert(result.observations.every(item => item.status === 'blocked'));
    assert(result.attempts.every(item => item.errors.includes('RECEIPT_BYTE_LIMIT')));
  });
  await t.test('malformed', async () => {
    const {deps} = dependencies({receiptBody: '{broken'});
    const result = await runExternalTask(task(), deps);
    assert(result.observations.every(item => item.status === 'blocked'));
    assert(result.attempts.every(item => item.errors.includes('RECEIPT_INVALID_JSON')));
  });
});

test('UI and receipt disagreement never yields observed evidence', async () => {
  const {deps} = dependencies({visible: false});
  const result = await runExternalTask(task(), deps);
  assert(result.observations.every(item => item.status === 'blocked' && item.actual === null));
  assert(result.attempts.every(item => item.errors.includes('INCONSISTENT_CHECKOUT_RECEIPT')));
});

test('action timeout is a failed observation rather than a pass', async () => {
  const {deps} = dependencies({actionTimeout: true});
  const result = await runExternalTask(task(), deps);
  assert(result.observations.every(item => item.status === 'failed' && item.actual === null));
  assert(result.attempts.every(item => item.errors.includes('BROWSER_TIMEOUT:click')));
});

test('cancellation returns every required cell as cancelled without opening contexts', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  const {deps, tracker} = dependencies({}, controller.signal);
  const result = await runExternalTask(task(), deps);
  assert.equal(result.observations.length, 12);
  assert(result.observations.every(item => item.status === 'cancelled' && item.actual === null));
  assert.equal(tracker.contexts, 0);
  assert.equal(tracker.browserClosed, 1);
});
