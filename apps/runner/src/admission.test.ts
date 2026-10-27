import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DomainError} from '../../../packages/core/src/errors.js';
import type {RunnerExecutionScope} from '../../../packages/core/src/experiments/protocol.js';
import {RunnerAdmissionController} from './admission.js';

const scope = (workspaceId: string = randomUUID()): RunnerExecutionScope => ({
  nonce: randomUUID(), job_id: randomUUID(), lease_id: randomUUID(),
  workspace_id: workspaceId, case_id: randomUUID(), generation: randomUUID(),
});
const domainError = (code: string, status: number) => (error: unknown) =>
  error instanceof DomainError && error.code === code && error.status === status;

test('concurrent acquisitions reserve at most two slots before awaited resources start', async () => {
  const admission = new RunnerAdmissionController();
  let finishAcquisition!: () => void;
  const acquisition = new Promise<void>(resolve => {finishAcquisition = resolve;});
  const inputs = Array.from({length: 20}, () => scope());
  const requests = inputs.map(async input => {
    const reservation = admission.reserve(input);
    try { await acquisition; return reservation.scope.nonce; }
    finally { assert.equal(admission.release(reservation), true); }
  });
  assert.equal(admission.size, 2);
  assert.deepEqual([admission.get(inputs[0]!.nonce), admission.get(inputs[1]!.nonce)], inputs.slice(0, 2));
  finishAcquisition();
  const results = await Promise.allSettled(requests);
  assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value),
    inputs.slice(0, 2).map(input => input.nonce));
  assert.equal(results.filter(result => result.status === 'rejected').length, 18);
  for (const result of results) if (result.status === 'rejected') assert.ok(domainError('RUNNER_BUSY', 429)(result.reason));
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
  assert.throws(() => admission.reserve({...scope(), nonce: input.nonce}), domainError('RUNNER_TASK_REPLAY', 403));
  assert.equal(admission.size, 1);
  assert.deepEqual(admission.get(input.nonce), input);
  admission.release(reservation);
});

test('stale, copied, cross-controller and double-release tokens cannot free a newer reservation', () => {
  const admission = new RunnerAdmissionController(), other = new RunnerAdmissionController();
  const input = scope(), first = admission.reserve(input);
  assert.equal(admission.release({...first}), false);
  assert.equal(other.release(first), false);
  assert.equal(admission.size, 1);
  assert.equal(admission.release(first), true);
  assert.equal(admission.release(first), false);
  const next = admission.reserve(input);
  assert.notEqual(next.token, first.token);
  assert.equal(admission.release(first), false);
  assert.equal(admission.release({...next, token: first.token}), false);
  assert.equal(admission.size, 1);
  assert.equal(admission.release(next), true);
  assert.equal(admission.get(input.nonce), null);
});

test('reservation scope is validated, copied and frozen independently of mutable input', () => {
  const admission = new RunnerAdmissionController(), input = scope(), original = {...input};
  const reservation = admission.reserve(input);
  input.nonce = randomUUID(); input.workspace_id = randomUUID(); input.job_id = randomUUID();
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
  for (const invalid of [null, [], {...input, path: 'untrusted'}, {...input, workspace_id: ''}, {...input, job_id: 'x'.repeat(101)}]) {
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
          if (stage === failedStage) throw failure;
        }
      } finally { assert.equal(admission.release(reservation), true); }
    }, error => error === failure);
    assert.equal(admission.size, 0);
    assert.equal(admission.get(input.nonce), null);
    const next = admission.reserve(scope(input.workspace_id));
    assert.equal(admission.release(next), true);
  }
});
