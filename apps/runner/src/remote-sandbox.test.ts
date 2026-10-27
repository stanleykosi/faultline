import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import test from 'node:test';
import {canonical} from '../../../packages/core/src/canonical.js';
import {DomainError} from '../../../packages/core/src/errors.js';
import {
  createRemoteSandboxProvider,
  type RemoteSandboxConfiguration,
  type RemoteSandboxTransport,
  type RemoteSandboxTransportRequest,
  type RemoteSandboxTransportResponse,
} from './remote-sandbox.js';
import type {HardenedSandboxExecutionInput} from './sandbox-provider.js';

const KEY = Buffer.alloc(32, 17);
const PROTOCOL = 'faultline-remote-sandbox-v1';
const ISOLATION = 'd'.repeat(64);
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sign = (value: unknown) => createHmac('sha256', KEY).update(canonical(value)).digest('hex');
const taskJson = canonical({version: 1, plan_hash: 'a'.repeat(64)});
const programBytes = new TextEncoder().encode('export {};');
const input = (overrides: Partial<HardenedSandboxExecutionInput> = {}): HardenedSandboxExecutionInput => ({
  executionKey: 'controller-task-a',
  taskJson,
  taskSha256: sha256(taskJson),
  programBytes,
  programSha256: sha256(programBytes),
  timeoutSeconds: 30,
  ...overrides,
});
const configuration = (overrides: Partial<RemoteSandboxConfiguration> = {}): RemoteSandboxConfiguration => ({
  endpoint: 'https://sandbox.example.test/v1/faultline',
  authKeyBase64: KEY.toString('base64'),
  providerId: 'operator-cloud',
  providerVersion: '2026.10',
  isolationConfigurationHash: ISOLATION,
  requestTimeoutMs: 5_000,
  ...overrides,
});
const domain = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

interface StoredState {
  status: 'completed' | 'running' | 'cancelled' | 'destroyed' | 'unknown';
  execution_key: string;
  execution_id: string | null;
  task_sha256: string | null;
  program_sha256: string | null;
  result_json: string | null;
  result_sha256: string | null;
  cleanup_verified: boolean;
  provider_configuration_hash: string;
  isolation_configuration_hash: string;
}

interface HarnessOptions {
  executeStatus?: 'completed' | 'running';
  cleanupVerified?: boolean;
  tamperSignature?: boolean;
  malformed?: boolean;
  tamperResultHash?: boolean;
  throwWithSecret?: boolean;
  duplicateResponseKey?: boolean;
  responseAt?: string;
  cancelKeepsCompleted?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const states = new Map<string, StoredState>();
  let configurationDigest = '';
  const transport: RemoteSandboxTransport = {
    async request(request: RemoteSandboxTransportRequest): Promise<RemoteSandboxTransportResponse> {
      if (options.throwWithSecret) throw new Error(`transport leaked ${KEY.toString('base64')}`);
      if (options.malformed) return {status: 200, body: Buffer.from('{')};
      const wire = JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, unknown>;
      const candidate = wire.signature;
      const {signature: _signature, ...unsigned} = wire;
      assert.equal(candidate, sign(unsigned));
      assert.equal(request.endpoint, configuration().endpoint);
      assert.equal(request.headers['x-faultline-request-sha256'], sha256(canonical(unsigned)));
      assert.ok(request.timeoutMs >= 1 && request.timeoutMs <= 630_000);
      calls.push(structuredClone(unsigned));
      configurationDigest = unsigned.configuration_digest as string;
      const operation = unsigned.operation as 'execute' | 'inspect' | 'cancel';
      const executionKey = unsigned.execution_key as string;
      const taskSha = unsigned.task_sha256 as string | null;
      const programSha = unsigned.program_sha256 as string | null;
      const previous = states.get(executionKey);

      if (operation === 'execute' && previous && (previous.task_sha256 !== taskSha || previous.program_sha256 !== programSha)) {
        return response(unsigned, 409, null, 'EXECUTION_CONFLICT', options.tamperSignature);
      }
      if (operation === 'execute' && !previous) {
        const resultJson = canonical({ok: true, observations: 12});
        states.set(executionKey, {
          status: options.executeStatus ?? 'completed',
          execution_key: executionKey,
          execution_id: 'remote-vm-1',
          task_sha256: taskSha,
          program_sha256: programSha,
          result_json: options.executeStatus === 'running' ? null : resultJson,
          result_sha256: options.executeStatus === 'running' ? null : options.tamperResultHash ? '0'.repeat(64) : sha256(resultJson),
          cleanup_verified: options.executeStatus === 'running' ? false : options.cleanupVerified ?? true,
          provider_configuration_hash: configurationDigest,
          isolation_configuration_hash: unsigned.isolation_configuration_hash as string,
        });
      }
      if (operation === 'cancel' && !(options.cancelKeepsCompleted && previous?.status === 'completed')) {
        const current = previous;
        states.set(executionKey, {
          status: 'destroyed', execution_key: executionKey, execution_id: current?.execution_id ?? null,
          task_sha256: current?.task_sha256 ?? taskSha, program_sha256: current?.program_sha256 ?? programSha,
          result_json: null, result_sha256: null, cleanup_verified: true,
          provider_configuration_hash: configurationDigest, isolation_configuration_hash: unsigned.isolation_configuration_hash as string,
        });
      }
      const state = states.get(executionKey) ?? {
        status: 'unknown' as const, execution_key: executionKey, execution_id: null, task_sha256: taskSha, program_sha256: programSha,
        result_json: null, result_sha256: null, cleanup_verified: false,
        provider_configuration_hash: configurationDigest, isolation_configuration_hash: unsigned.isolation_configuration_hash as string,
      };
      return response(unsigned, 200, state, null, options.tamperSignature);
    },
  };
  function response(request: Record<string, unknown>, status: number, payload: unknown, errorCode: string | null, tamper = false): RemoteSandboxTransportResponse {
    const unsigned = {
      protocol: PROTOCOL,
      version: 1,
      operation: request.operation,
      nonce: request.nonce,
      request_sha256: sha256(canonical(request)),
      at: options.responseAt ?? '2026-10-17T12:00:00.000Z',
      payload,
      error_code: errorCode,
    };
    const envelope = {...unsigned, signature: tamper ? '0'.repeat(64) : sign(unsigned)};
    const body = canonical(envelope);
    return {status, body: Buffer.from(options.duplicateResponseKey ? body.replace('{"at"', '{"version":1,"at"') : body)};
  }
  return {transport, calls, states};
}

function provider(mock: ReturnType<typeof harness>, overrides: Partial<RemoteSandboxConfiguration> = {}) {
  let nonce = 0;
  return createRemoteSandboxProvider(configuration(overrides), {
    transport: mock.transport,
    clock: () => new Date('2026-10-17T12:00:00.000Z'),
    nonce: () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`,
  });
}

test('executes through one exact HTTPS endpoint and requires canonical digest bindings plus cleanup proof', async () => {
  const mock = harness();
  const remote = provider(mock);
  const result = await remote.execute(input());
  assert.deepEqual(result, {
    executionId: 'remote-vm-1', taskSha256: sha256(taskJson), programSha256: sha256(programBytes),
    resultSha256: sha256(canonical({ok: true, observations: 12})), result: {observations: 12, ok: true},
  });
  assert.equal(mock.calls.length, 1);
  const request = mock.calls[0]!;
  assert.equal(request.protocol, PROTOCOL);
  assert.equal(request.operation, 'execute');
  assert.equal(request.execution_key, input().executionKey);
  assert.equal((request.payload as Record<string, unknown>).task_json, taskJson);
  assert.equal((request.payload as Record<string, unknown>).program_base64, Buffer.from(programBytes).toString('base64'));
  assert.deepEqual(remote.metadata, {
    adapter_id: 'faultline.hardened-sandbox.remote', adapter_version: 'remote-sandbox-v1',
    provider_id: 'operator-cloud', provider_version: '2026.10', configuration_digest: remote.metadata.configuration_digest,
    isolation: 'hardened_vm', cleanup_verification: true, crash_reconciliation: true,
  });
  assert.match(remote.metadata.configuration_digest, /^[a-f0-9]{64}$/);
});

test('replays one stable execution locally and remotely while rejecting task or program conflicts', async () => {
  const mock = harness();
  const firstProvider = provider(mock);
  const first = await firstProvider.execute(input());
  assert.deepEqual(await firstProvider.execute({...input(), timeoutSeconds: 45}), first);
  assert.equal(mock.calls.length, 1);

  const restartedProvider = provider(mock);
  assert.deepEqual(await restartedProvider.execute(input()), first);
  assert.equal(mock.calls.length, 2);

  const differentTask = canonical({version: 1, plan_hash: 'b'.repeat(64)});
  await assert.rejects(firstProvider.execute(input({taskJson: differentTask, taskSha256: sha256(differentTask)})),
    domain('RUNNER_SANDBOX_EXECUTION_CONFLICT'));
  await assert.rejects(provider(mock).execute(input({taskJson: differentTask, taskSha256: sha256(differentTask)})),
    domain('RUNNER_SANDBOX_EXECUTION_CONFLICT'));
});

test('cancels a running execution, verifies destruction and reports it after provider restart', async () => {
  const mock = harness({executeStatus: 'running'});
  const remote = provider(mock);
  await assert.rejects(remote.execute(input()), domain('RUNNER_SANDBOX_EXECUTION_IN_PROGRESS'));
  assert.deepEqual(await remote.cancel(input().executionKey), {status: 'destroyed', cleanup_verified: true});
  assert.deepEqual(await remote.inspect(input().executionKey), {status: 'destroyed', cleanup_verified: true});
  assert.deepEqual(await provider(mock).inspect(input().executionKey), {status: 'destroyed', cleanup_verified: true});
});

test('recovers a completed execution by inspection after controller restart', async () => {
  const mock = harness();
  const completed = await provider(mock).execute(input());
  assert.deepEqual(await provider(mock).inspect(input().executionKey), {
    status: 'completed', cleanup_verified: true, execution: completed,
  });
});

test('cancelling an already completed and destroyed remote execution retains verified containment', async () => {
  const mock=harness({cancelKeepsCompleted:true}),remote=provider(mock);await remote.execute(input());
  assert.deepEqual(await remote.cancel(input().executionKey),{status:'destroyed',cleanup_verified:true});
});

test('fails closed when completed state lacks cleanup proof or carries a wrong result digest', async () => {
  await assert.rejects(provider(harness({cleanupVerified: false})).execute(input()), domain('RUNNER_SANDBOX_CLEANUP_UNKNOWN'));
  await assert.rejects(provider(harness({tamperResultHash: true})).execute(input()), domain('RUNNER_SANDBOX_RESULT_HASH_MISMATCH'));
});

test('rejects timeout, malformed, oversized and unauthenticated responses', async () => {
  const never: RemoteSandboxTransport = {request: async () => new Promise<RemoteSandboxTransportResponse>(() => undefined)};
  const timed = createRemoteSandboxProvider(configuration({requestTimeoutMs: 5}), {transport: never});
  await assert.rejects(timed.execute(input()), domain('RUNNER_SANDBOX_TIMEOUT'));
  await assert.rejects(provider(harness({malformed: true})).execute(input()), domain('RUNNER_REMOTE_RESPONSE_INVALID'));
  await assert.rejects(provider(harness({duplicateResponseKey: true})).execute(input()), domain('RUNNER_REMOTE_RESPONSE_INVALID'));
  await assert.rejects(provider(harness({responseAt: '2026-10-17T11:58:59.999Z'})).execute(input()), domain('RUNNER_REMOTE_RESPONSE_AUTHENTICATION_FAILED'));
  await assert.rejects(provider(harness({tamperSignature: true})).execute(input()), domain('RUNNER_REMOTE_RESPONSE_AUTHENTICATION_FAILED'));

  const oversized: RemoteSandboxTransport = {request: async () => ({status: 200, body: new Uint8Array(1024 * 1024 + 1)})};
  await assert.rejects(createRemoteSandboxProvider(configuration(), {transport: oversized}).execute(input()),
    domain('RUNNER_REMOTE_RESPONSE_INVALID'));
});

test('rejects endpoint credential, fragment, query, HTTP and non-443 port configurations', () => {
  for (const endpoint of [
    'http://sandbox.example.test/v1/faultline',
    'https://user:password@sandbox.example.test/v1/faultline',
    'https://sandbox.example.test:8443/v1/faultline',
    'https://sandbox.example.test/v1/faultline?mode=test',
    'https://sandbox.example.test/v1/faultline#section',
  ]) assert.throws(() => createRemoteSandboxProvider(configuration({endpoint})), domain('RUNNER_REMOTE_CONFIGURATION_INVALID'));
});

test('never exposes authentication key through metadata, results or provider failures', async () => {
  const successful = harness();
  const remote = provider(successful);
  const result = await remote.execute(input());
  const key = KEY.toString('base64');
  assert.equal(JSON.stringify(remote).includes(key), false);
  assert.equal(JSON.stringify(remote.metadata).includes(key), false);
  assert.equal(JSON.stringify(result).includes(key), false);

  await assert.rejects(provider(harness({throwWithSecret: true})).execute(input()), error => error instanceof DomainError &&
    error.code === 'RUNNER_SANDBOX_PROVIDER_FAILED' && !error.message.includes(key) && !JSON.stringify(error).includes(key));
});

