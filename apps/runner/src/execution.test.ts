import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DomainError} from '../../../packages/core/src/errors.js';
import {type RunnerExecutionScope, executionScope} from '../../../packages/core/src/experiments/protocol.js';
import {RunnerAdmissionController} from './admission.js';
import {containmentDecision} from './containment.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FileRunnerExecutionLedger, MemoryRunnerExecutionLedger} from './execution-ledger.js';
import {hash} from '../../../packages/core/src/canonical.js';
import {type FaultlineTargetGrant} from '../../../packages/contracts/src/generated.js';
import {runExternalTask, validateExternalTask, type ExternalTaskDependencies, type ExternalTaskInput, type RunnerBrowser, type RunnerBrowserContext, type RunnerLocator, type RunnerPage, type RunnerRoute, type RunnerWebSocket} from './external-task.js';
import {FileRunnerNonceStore, MemoryRunnerNonceStore} from './nonce-store.js';

describe("admission", async () => {
  const scope = (workspaceId: string = randomUUID()): RunnerExecutionScope => ({
      nonce: randomUUID(), job_id: randomUUID(), lease_id: randomUUID(),
      workspace_id: workspaceId, case_id: randomUUID(), generation: randomUUID(),
  });
  
  const domainError = (code: string, status: number) => (error: unknown) => error instanceof DomainError && error.code === code && error.status === status;
  
  test('concurrent acquisitions reserve at most two slots before awaited resources start', async () => {
      const admission = new RunnerAdmissionController();
      let finishAcquisition!: () => void;
      const acquisition = new Promise<void>(resolve => { finishAcquisition = resolve; });
      const inputs = Array.from({ length: 20 }, () => scope());
      const requests = inputs.map(async (input) => {
          const reservation = admission.reserve(input);
          try {
              await acquisition;
              return reservation.scope.nonce;
          }
          finally {
              assert.equal(admission.release(reservation), true);
          }
      });
      assert.equal(admission.size, 2);
      assert.deepEqual([admission.get(inputs[0]!.nonce), admission.get(inputs[1]!.nonce)], inputs.slice(0, 2));
      finishAcquisition();
      const results = await Promise.allSettled(requests);
      assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value), inputs.slice(0, 2).map(input => input.nonce));
      assert.equal(results.filter(result => result.status === 'rejected').length, 18);
      for (const result of results)
          if (result.status === 'rejected')
              assert.ok(domainError('RUNNER_BUSY', 429)(result.reason));
      assert.equal(admission.size, 0);
  });
  
  test('a pending reservation blocks another nonce in its workspace but permits a different workspace', () => {
      const admission = new RunnerAdmissionController();
      const first = scope(), reservation = admission.reserve(first);
      assert.throws(() => admission.reserve(scope(first.workspace_id)), domainError('RUNNER_BUSY', 429));
      const second = admission.reserve(scope());
      assert.equal(admission.size, 2);
      assert.equal(admission.release(reservation), true);
      const next = admission.reserve(scope(first.workspace_id));
      assert.equal(admission.size, 2);
      assert.equal(admission.release(second), true);
      assert.equal(admission.release(next), true);
  });
  
  test('duplicate active nonces are denied even when authenticated scope fields differ', () => {
      const admission = new RunnerAdmissionController();
      const input = scope(), reservation = admission.reserve(input);
      assert.throws(() => admission.reserve({ ...scope(), nonce: input.nonce }), domainError('RUNNER_TASK_REPLAY', 403));
      assert.equal(admission.size, 1);
      assert.deepEqual(admission.get(input.nonce), input);
      admission.release(reservation);
  });
  
  test('stale, copied, cross-controller and double-release tokens cannot free a newer reservation', () => {
      const admission = new RunnerAdmissionController(), other = new RunnerAdmissionController();
      const input = scope(), first = admission.reserve(input);
      assert.equal(admission.release({ ...first }), false);
      assert.equal(other.release(first), false);
      assert.equal(admission.size, 1);
      assert.equal(admission.release(first), true);
      assert.equal(admission.release(first), false);
      const next = admission.reserve(input);
      assert.notEqual(next.token, first.token);
      assert.equal(admission.release(first), false);
      assert.equal(admission.release({ ...next, token: first.token }), false);
      assert.equal(admission.size, 1);
      assert.equal(admission.release(next), true);
      assert.equal(admission.get(input.nonce), null);
  });
  
  test('reservation scope is validated, copied and frozen independently of mutable input', () => {
      const admission = new RunnerAdmissionController(), input = scope(), original = { ...input };
      const reservation = admission.reserve(input);
      input.nonce = randomUUID();
      input.workspace_id = randomUUID();
      input.job_id = randomUUID();
      assert.deepEqual(reservation.scope, original);
      assert.equal(admission.get(original.nonce), reservation.scope);
      assert.equal(admission.get(input.nonce), null);
      assert.ok(Object.isFrozen(reservation) && Object.isFrozen(reservation.scope));
      assert.equal(Reflect.set(reservation.scope, 'workspace_id', randomUUID()), false);
      assert.deepEqual(reservation.scope, original);
      assert.throws(() => admission.reserve(scope(original.workspace_id)), domainError('RUNNER_BUSY', 429));
      assert.equal(admission.release(reservation), true);
  });
  
  test('invalid scope cannot occupy capacity or accept additional executable fields', () => {
      const admission = new RunnerAdmissionController(), input = scope();
      for (const invalid of [null, [], { ...input, path: 'untrusted' }, { ...input, workspace_id: '' }, { ...input, job_id: 'x'.repeat(101) }]) {
          assert.throws(() => admission.reserve(invalid), error => error instanceof DomainError && error.status === 422);
          assert.equal(admission.size, 0);
          assert.equal(admission.get(input.nonce), null);
      }
      const reservation = admission.reserve(input);
      assert.equal(admission.size, 1);
      admission.release(reservation);
  });
  
  test('a finally spanning acquisition, registration and execution failures returns capacity', async () => {
      const admission = new RunnerAdmissionController();
      for (const failedStage of ['harness_acquisition', 'exclusive_ledger_write', 'execution']) {
          const input = scope(), failure = new Error(failedStage);
          await assert.rejects(async () => {
              const reservation = admission.reserve(input);
              try {
                  for (const stage of ['harness_acquisition', 'exclusive_ledger_write', 'execution']) {
                      await Promise.resolve();
                      if (stage === failedStage)
                          throw failure;
                  }
              }
              finally {
                  assert.equal(admission.release(reservation), true);
              }
          }, error => error === failure);
          assert.equal(admission.size, 0);
          assert.equal(admission.get(input.nonce), null);
          const next = admission.reserve(scope(input.workspace_id));
          assert.equal(admission.release(next), true);
      }
  });
});

describe("containment", async () => {
  test('finite containment never treats cancellation, missing terminal, restart or changed scope as stopped', () => {
      const scope = { nonce: randomUUID(), job_id: randomUUID(), lease_id: randomUUID(), workspace_id: randomUUID(), case_id: randomUUID(), generation: randomUUID() }, record = { scope, request_hash: 'a'.repeat(64), request_nonce: randomUUID() }, terminal = { version: 1 as const, ...record, terminal_at: new Date().toISOString(), files: [], unknown_files: 0 };
      assert.equal(containmentDecision(scope, scope.generation, scope, record, terminal, null).stopped, false);
      assert.equal(containmentDecision(scope, scope.generation, null, record, null, null).state, 'containment_unknown');
      assert.equal(containmentDecision(scope, randomUUID(), null, record, null, null).stopped, false);
      assert.equal(containmentDecision(scope, randomUUID(), null, record, terminal, null).stopped, true);
      assert.equal(containmentDecision(scope, scope.generation, null, record, terminal, null).stopped, true);
      assert.throws(() => containmentDecision({ ...scope, lease_id: randomUUID() }, scope.generation, null, record, terminal, null), /exact/);
      assert.throws(() => executionScope({ ...scope, path: 'C:\\private' }), /finite fields/);
      const tombstone = { version: 1 as const, scope, request_hash: record.request_hash, request_nonce: record.request_nonce, terminal_hash: 'b'.repeat(64), removed: 3, pending: 1, at: new Date().toISOString() };
      assert.equal(containmentDecision(scope, scope.generation, null, null, null, tombstone).state, 'cleanup_pending');
      assert.equal(containmentDecision(scope, scope.generation, null, null, null, { ...tombstone, pending: 0 }).state, 'cleaned');
  });
});

describe("execution ledger", async () => {
  const key = 'task_execution_nonce_0001', task = 'a'.repeat(64);
  
  const completedTransition = () => ({ status: 'completed' as const, updated_at: new Date().toISOString(), recovery_task: null, execution: { executionId: 'provider-run', taskSha256: task, programSha256: 'b'.repeat(64), resultSha256: 'c'.repeat(64), result: { ok: true } } });
  
  test('memory ledger binds one task and replays the completed result', async () => {
      const ledger = new MemoryRunnerExecutionLedger();
      assert.equal((await ledger.reserve(key, task)).created, true);
      assert.equal((await ledger.reserve(key, task)).created, false);
      await ledger.transition(key, task, ['reserved'], { status: 'running', updated_at: new Date().toISOString(), recovery_task: { task: true }, execution: null });
      await ledger.transition(key, task, ['running'], completedTransition());
      assert.equal((await ledger.reserve(key, task)).record.status, 'completed');
      await assert.rejects(ledger.reserve(key, 'd'.repeat(64)), /another task/i);
  });
  
  test('file ledger survives restart and rejects a conflicting task hash', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-executions-'));
      const first = await FileRunnerExecutionLedger.open(root);
      await first.reserve(key, task);
      await first.transition(key, task, ['reserved'], { status: 'running', updated_at: new Date().toISOString(), recovery_task: { task: true }, execution: null });
      await first.transition(key, task, ['running'], completedTransition());
      const reopened = await FileRunnerExecutionLedger.open(root);
      const replay = await reopened.reserve(key, task);
      assert.equal(replay.created, false);
      assert.equal(replay.record.status, 'completed');
      await assert.rejects(reopened.reserve(key, 'e'.repeat(64)), /another task/i);
  });
  
  test('terminal transitions are irreversible and cancel wins an atomic publication race', async () => {
      const ledger = new MemoryRunnerExecutionLedger();
      await ledger.reserve(key, task);
      await ledger.transition(key, task, ['reserved'], { status: 'running', updated_at: new Date().toISOString(), recovery_task: { task: true }, execution: null });
      const requested = await ledger.transition(key, task, ['running'], { status: 'cancel_requested', updated_at: new Date().toISOString(), recovery_task: { task: true }, execution: null });
      assert.equal(requested.applied, true);
      const publication = await ledger.transition(key, task, ['running'], completedTransition());
      assert.equal(publication.applied, false);
      assert.equal(publication.record.status, 'cancel_requested');
      await ledger.transition(key, task, ['cancel_requested'], { status: 'cancelled', updated_at: new Date().toISOString(), recovery_task: null, execution: null });
      const late = await ledger.transition(key, task, ['running'], completedTransition());
      assert.equal(late.applied, false);
      assert.equal(late.record.status, 'cancelled');
  });
  
  test('file ledger serializes competing controllers without losing cancel or completion', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-executions-race-')), first = await FileRunnerExecutionLedger.open(root), second = await FileRunnerExecutionLedger.open(root);
      await first.reserve(key, task);
      await first.transition(key, task, ['reserved'], { status: 'running', updated_at: new Date().toISOString(), recovery_task: { task: true }, execution: null });
      const [publication, cancellation] = await Promise.all([
          first.transition(key, task, ['running'], completedTransition()),
          second.transition(key, task, ['running'], { status: 'cancel_requested', updated_at: new Date().toISOString(), recovery_task: { task: true }, execution: null }),
      ]);
      assert.equal(Number(publication.applied) + Number(cancellation.applied), 1);
      const record = await first.read(key);
      assert.ok(record?.status === 'completed' || record?.status === 'cancel_requested');
  });
  
  test('file ledger enforces capacity during reservation and remains readable after restart', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-executions-capacity-')), ledger = await FileRunnerExecutionLedger.open(root, 2);
      await ledger.reserve(key, task);
      await ledger.reserve('task_execution_nonce_0002', 'b'.repeat(64));
      await assert.rejects(ledger.reserve('task_execution_nonce_0003', 'c'.repeat(64)), /finite record bound/i);
      const reopened = await FileRunnerExecutionLedger.open(root, 2);
      assert.equal((await reopened.read(key))?.status, 'reserved');
  });
  
  test('file ledger enforces one shared capacity slot across concurrent controllers', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-executions-shared-capacity-')), first = await FileRunnerExecutionLedger.open(root, 1), second = await FileRunnerExecutionLedger.open(root, 1), otherKey = 'task_execution_nonce_0002';
      const outcomes = await Promise.allSettled([first.reserve(key, task), second.reserve(otherKey, 'b'.repeat(64))]);
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
      const rejected = outcomes.find(item => item.status === 'rejected');
      assert.match(String(rejected && rejected.status === 'rejected' ? rejected.reason : ''), /finite record bound/i);
      const reopened = await FileRunnerExecutionLedger.open(root, 1), records = await reopened.listNonterminal();
      assert.equal(records.length, 1);
      assert.ok(records[0]?.execution_key === key || records[0]?.execution_key === otherKey);
  });
});

describe("external task", async () => {
  const NOW = new Date('2026-10-17T12:00:00.000Z');
  
  const sha = (value: string) => hash({ value });
  
  const arms = ['known_good', 'incident'] as const;
  
  function task(changes: {
      fill?: boolean;
      omitValue?: boolean;
      grantOrigins?: string[];
  } = {}): ExternalTaskInput {
      const profileUnsigned = {
          schema_version: 1 as const,
          id: 'profile-one', workspace_id: 'workspace-one', case_id: 'case-one', revision_id: 'revision-one', template: 'checkout_receipt_v1' as const,
          success_locator: { kind: 'test_id' as const, value: 'checkout-complete' },
          receipt: { path_template: '/__faultline/receipts/{attempt_id}', method: 'GET' as const, credential_ref: null, completed_pointer: '/completed', order_count_pointer: '/order_count', error_code_pointer: '/error_code', max_response_bytes: 4096 },
          incident_error_code: 'DECLINED', symptom_evidence_ids: ['evidence-one'] as [
              string
          ], sandbox_only: true as const,
          created_at: NOW.toISOString(), reviewed_by: 'owner-one',
      };
      const observation_profile = { ...profileUnsigned, profile_hash: hash(profileUnsigned) };
      const plan = {
          version: 1 as const, workspace_id: 'workspace-one', case_id: 'case-one', revision_id: 'revision-one', hypothesis_id: 'hypothesis-one',
          objective: 'mechanism' as const, mode: 'verified_staging' as const, policy_version: 'checkout_mechanism_v1' as const,
          oracle_hash: sha('oracle'), metric_hash: sha('metric'), snapshot_hash: sha('snapshot'), fixture_hash: sha('fixture'), environment_hash: sha('environment'),
          runner_id: 'railway-runner-one', repeats: 3 as const, cohorts: ['mobile', 'desktop'] as [
              'mobile',
              'desktop'
          ],
          actions: [
              { op: 'navigate' as const, path: '/checkout' },
              ...(changes.fill ? [{ op: 'fill' as const, locator: { kind: 'label' as const, value: 'Email' }, value_ref: 'checkout_email' }] : []),
              { op: 'click' as const, locator: { kind: 'role' as const, role: 'button' as const, value: 'Pay' } },
          ] as ExternalTaskInput['plan']['actions'],
          arms: arms.map(arm => ({ arm, origin: `https://${arm.replace('_', '-')}.example.test`, build_digest: sha(`${arm}-build`), deployment_evidence_hash: sha(`${arm}-deployment`) })) as ExternalTaskInput['plan']['arms'],
          observation_profile_hash: observation_profile.profile_hash,
      };
      const grant: FaultlineTargetGrant = { id: 'grant-one', workspace_id: plan.workspace_id, origins: (changes.grantOrigins ?? plan.arms.map(arm => arm.origin)) as FaultlineTargetGrant['origins'], expires_at: '2026-10-17T13:00:00.000Z', revoked: false };
      const approval = { plan_hash: hash(plan), oracle_hash: plan.oracle_hash, workspace_id: plan.workspace_id, reviewer_id: 'owner-one', reviewer_role: 'owner' as const, grant_hash: hash(grant), expires_at: '2026-10-17T13:00:00.000Z', revoked: false };
      const networkUnsigned = { version: 1 as const, origins: plan.arms.map(arm => arm.origin), path_prefixes: ['/checkout', '/__faultline/receipts/'], resolved_addresses: Object.fromEntries(plan.arms.map(arm => [new URL(arm.origin).hostname, ['93.184.216.34']])), deny_private_addresses: true as const, max_response_bytes: 4096 };
      const network_profile = { ...networkUnsigned, profile_hash: hash(networkUnsigned) };
      const deployments = plan.arms.map((arm, index) => ({ arm: arm.arm, deployment_id: `deployment-${index}`, attester_id: 'operator-attester-one', origin: arm.origin, build_digest: arm.build_digest, deployment_evidence_hash: arm.deployment_evidence_hash }));
      const value_refs: Record<string, string> = changes.fill && !changes.omitValue ? { checkout_email: 'synthetic@example.test' } : {};
      return { version: 1, plan, approval, grant, observation_profile, network_profile, deployments, value_refs, task: {
              job_id: 'job-external-one', lease_id: 'lease-external-one', nonce: 'task_nonce_external_0001', expires_at: '2026-10-17T12:05:00.000Z',
              plan_hash: hash(plan), approval_hash: hash(approval), grant_hash: hash(grant), observation_profile_hash: observation_profile.profile_hash, network_profile_hash: network_profile.profile_hash, runner_id: plan.runner_id,
          } };
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
      constructor(private behavior: Behavior) { }
      async click(): Promise<void> { if (this.behavior.actionTimeout) {
          const error = new Error('action timeout');
          error.name = 'TimeoutError';
          throw error;
      } }
      async fill(): Promise<void> { if (this.behavior.actionTimeout) {
          const error = new Error('action timeout');
          error.name = 'TimeoutError';
          throw error;
      } }
      async waitFor(): Promise<void> { if (this.behavior.actionTimeout) {
          const error = new Error('action timeout');
          error.name = 'TimeoutError';
          throw error;
      } }
      async isVisible(): Promise<boolean> { return this.behavior.visible ?? true; }
  }
  
  class FakePage implements RunnerPage {
      private current = 'about:blank';
      constructor(private behavior: Behavior, private request: (url: string) => Promise<void>) { }
      setDefaultTimeout(): void { }
      async goto(url: string): Promise<void> {
          await this.request(url);
          if (this.behavior.requestUrl)
              await this.request(this.behavior.requestUrl);
          this.current = this.behavior.redirectUrl ?? url;
      }
      url(): string { return this.current; }
      getByTestId(): RunnerLocator { return new FakeLocator(this.behavior); }
      getByLabel(): RunnerLocator { return new FakeLocator(this.behavior); }
      getByRole(): RunnerLocator { return new FakeLocator(this.behavior); }
      on(): void { }
  }
  
  class FakeContext implements RunnerBrowserContext {
      private routeHandler?: (route: RunnerRoute) => Promise<void>;
      constructor(private behavior: Behavior, readonly tracker: Tracker) { }
      async route(_pattern: '**/*', handler: (route: RunnerRoute) => Promise<void>): Promise<void> { this.routeHandler = handler; }
      async routeWebSocket(_pattern: '**/*', _handler: (socket: RunnerWebSocket) => void): Promise<void> { }
      async newPage(): Promise<RunnerPage> {
          return new FakePage(this.behavior, async (url) => {
              assert(this.routeHandler);
              await this.routeHandler({ request: () => ({ url: () => url, method: () => 'GET' }), continue: async () => { this.tracker.continued += 1; }, abort: async () => { this.tracker.aborted += 1; } });
          });
      }
      async close(): Promise<void> { this.tracker.contextsClosed += 1; }
  }
  
  type Tracker = {
      contexts: number;
      contextsClosed: number;
      browserClosed: number;
      continued: number;
      aborted: number;
  };
  
  function dependencies(behavior: Behavior = {}, signal?: AbortSignal): {
      deps: ExternalTaskDependencies;
      tracker: Tracker;
  } {
      const tracker: Tracker = { contexts: 0, contextsClosed: 0, browserClosed: 0, continued: 0, aborted: 0 };
      let attempts = 0;
      const browser: RunnerBrowser = {
          newContext: async () => { tracker.contexts += 1; return new FakeContext(behavior, tracker); },
          version: () => 'fake-1',
          close: async () => { tracker.browserClosed += 1; },
      };
      const deps: ExternalTaskDependencies = {
          browserFactory: async (policy) => { assert.equal(policy.origins.length, 2); return browser; },
          fetch: async (_input, init) => {
              init.signal.throwIfAborted();
              const body = behavior.receiptBody ?? JSON.stringify({ completed: true, order_count: 1, error_code: null });
              return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...behavior.receiptHeaders } });
          },
          clock: () => new Date(NOW),
          attemptId: () => `attempt_id_${String(++attempts).padStart(8, '0')}`,
          signal,
      };
      return { deps, tracker };
  }
  
  function code(error: unknown): string | undefined { return error instanceof DomainError ? error.code : undefined; }
  
  test('valid task produces every canonical raw attempt with fresh context and no outcome claim', async () => {
      const input = task({ fill: true }), { deps, tracker } = dependencies();
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
      const input = task({ grantOrigins: ['https://known-good.example.test'] });
      input.approval.grant_hash = hash(input.grant);
      input.task.grant_hash = hash(input.grant);
      input.task.approval_hash = hash(input.approval);
      const { deps, tracker } = dependencies();
      await assert.rejects(runExternalTask(input, deps), error => code(error) === 'ORIGIN_NOT_GRANTED');
      assert.equal(tracker.contexts, 0);
  });
  
  test('out-of-scope browser request is aborted and blocks each affected observation', async () => {
      const { deps, tracker } = dependencies({ requestUrl: 'https://evil.example.test/beacon' });
      const result = await runExternalTask(task(), deps);
      assert.equal(tracker.aborted, 12);
      assert(result.observations.every(item => item.status === 'blocked' && item.actual === null));
      assert(result.attempts.every(item => item.denied_requests.some(denied => denied.code === 'ORIGIN_DENIED' && denied.origin === null && denied.path === null)));
  });
  
  test('unexpected receipt error text is projected to a fixed code instead of returning target-controlled content', async () => {
      const { deps } = dependencies({ receiptBody: JSON.stringify({ completed: true, order_count: 1, error_code: 'target-controlled-private-text' }) });
      const result = await runExternalTask(task(), deps);
      assert(result.observations.every(item => item.actual?.error_code === 'UNEXPECTED_ERROR_CODE'));
      assert.equal(JSON.stringify(result).includes('target-controlled-private-text'), false);
  });
  
  test('out-of-scope redirect is blocked even when initial navigation was allowed', async () => {
      const { deps } = dependencies({ redirectUrl: 'https://evil.example.test/checkout' });
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
      const input = task({ fill: true, omitValue: true }), { deps, tracker } = dependencies();
      await assert.rejects(runExternalTask(input, deps), error => code(error) === 'VALUE_REF_MISSING');
      assert.equal(tracker.contexts, 0);
  });
  
  test('oversize and malformed receipt bodies become explicit blocked observations', async (t) => {
      await t.test('oversize', async () => {
          const { deps } = dependencies({ receiptBody: 'x'.repeat(4097) });
          const result = await runExternalTask(task(), deps);
          assert(result.observations.every(item => item.status === 'blocked'));
          assert(result.attempts.every(item => item.errors.includes('RECEIPT_BYTE_LIMIT')));
      });
      await t.test('malformed', async () => {
          const { deps } = dependencies({ receiptBody: '{broken' });
          const result = await runExternalTask(task(), deps);
          assert(result.observations.every(item => item.status === 'blocked'));
          assert(result.attempts.every(item => item.errors.includes('RECEIPT_INVALID_JSON')));
      });
  });
  
  test('UI and receipt disagreement never yields observed evidence', async () => {
      const { deps } = dependencies({ visible: false });
      const result = await runExternalTask(task(), deps);
      assert(result.observations.every(item => item.status === 'blocked' && item.actual === null));
      assert(result.attempts.every(item => item.errors.includes('INCONSISTENT_CHECKOUT_RECEIPT')));
  });
  
  test('action timeout is a failed observation rather than a pass', async () => {
      const { deps } = dependencies({ actionTimeout: true });
      const result = await runExternalTask(task(), deps);
      assert(result.observations.every(item => item.status === 'failed' && item.actual === null));
      assert(result.attempts.every(item => item.errors.includes('BROWSER_TIMEOUT:click')));
  });
  
  test('cancellation returns every required cell as cancelled without opening contexts', async () => {
      const controller = new AbortController();
      controller.abort(new DOMException('cancelled', 'AbortError'));
      const { deps, tracker } = dependencies({}, controller.signal);
      const result = await runExternalTask(task(), deps);
      assert.equal(result.observations.length, 12);
      assert(result.observations.every(item => item.status === 'cancelled' && item.actual === null));
      assert.equal(tracker.contexts, 0);
      assert.equal(tracker.browserClosed, 1);
  });
});

describe("nonce store", async () => {
  const expiry = () => new Date(Date.now() + 60000).toISOString();
  
  const nonce = '00000000-0000-4000-8000-000000000001';
  
  test('memory nonce store admits once and rejects replay', async () => {
      const store = new MemoryRunnerNonceStore();
      assert.equal(await store.consume(nonce, expiry()), true);
      assert.equal(await store.consume(nonce, expiry()), false);
  });
  
  test('file nonce store rejects replay after controller restart', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-nonces-'));
      const file = path.join(root, 'journal.jsonl');
      const first = await FileRunnerNonceStore.open(file);
      assert.equal(await first.consume(nonce, expiry()), true);
      const reopened = await FileRunnerNonceStore.open(file);
      assert.equal(await reopened.consume(nonce, expiry()), false);
  });
  
  test('file nonce store admits one nonce across concurrent controller instances', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-nonces-concurrent-')), file = path.join(root, 'journal.jsonl');
      const first = await FileRunnerNonceStore.open(file), second = await FileRunnerNonceStore.open(file), results = await Promise.all([first.consume(nonce, expiry()), second.consume(nonce, expiry())]);
      assert.deepEqual(results.sort(), [false, true]);
  });
  
  test('file nonce store rejects a non-absolute path and malformed journal', async () => {
      await assert.rejects(FileRunnerNonceStore.open('relative.jsonl'), /absolute/i);
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-nonces-invalid-'));
      const file = path.join(root, 'journal.jsonl');
      await fs.writeFile(file, '{bad}\n');
      await assert.rejects(FileRunnerNonceStore.open(file), /invalid JSON/i);
  });
});
