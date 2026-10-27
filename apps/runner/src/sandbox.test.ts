import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {DomainError} from '../../../packages/core/src/errors.js';
import {createRailwaySandboxProvider, executeRailwaySandbox, type RailwaySandboxInput} from './railway-sandbox.js';
import {type HardenedSandboxExecutionInput} from './sandbox-provider.js';
import {canonical} from '../../../packages/core/src/canonical.js';
import {createRemoteSandboxProvider, type RemoteSandboxConfiguration, type RemoteSandboxTransport, type RemoteSandboxTransportRequest, type RemoteSandboxTransportResponse} from './remote-sandbox.js';

describe("railway sandbox", async () => {
  const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  
  const taskJson = JSON.stringify({ version: 1, plan_hash: 'a'.repeat(64) });
  
  const programBytes = new TextEncoder().encode('export {};');
  
  const input = (signal?: AbortSignal): RailwaySandboxInput => ({
      environmentId: 'env-approved', checkpointName: 'faultline-runner-v1', taskJson,
      taskSha256: digest(taskJson), programBytes, programSha256: digest(programBytes),
      timeoutSeconds: 30, signal,
  });
  
  const domain = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
  
  const providerInput = (signal?: AbortSignal): HardenedSandboxExecutionInput => ({
      executionKey: 'controller-task-a', taskJson, taskSha256: digest(taskJson), programBytes, programSha256: digest(programBytes),
      timeoutSeconds: 30, signal,
  });
  
  const configuredEnvironment = {
      RAILWAY_TOKEN: 'synthetic-token',
      RAILWAY_ENVIRONMENT_ID: 'env-approved',
      RUNNER_SANDBOX_CHECKPOINT: 'faultline-runner-v1',
  };
  
  interface MockOptions {
      metadata?: Partial<ReturnType<typeof baseMetadata>>;
      exec?: Partial<{
          exitCode: number | null;
          stdout: string;
          stderr: string;
          truncated: boolean;
          timedOut: boolean;
      }>;
      mutateWrite?: (path: string, bytes: Uint8Array) => Uint8Array;
      resultEnvelope?: Record<string, unknown> | null;
      destroyError?: Error;
      listError?: Error;
      residualAfterDestroy?: boolean;
      onCreate?: () => void;
  }
  
  const baseMetadata = () => ({
      id: 'sandbox-1', status: 'RUNNING', networkIsolation: 'ISOLATED', domains: [] as unknown[],
      environmentId: 'env-approved', region: 'us-west1', idleTimeoutMinutes: 1,
      createdAt: '2026-10-17T12:00:00.000Z',
  });
  
  function harness(options: MockOptions = {}) {
      const files = new Map<string, Uint8Array>();
      const calls = { create: [] as unknown[][], writes: [] as unknown[][], reads: [] as unknown[][],
          exec: [] as unknown[][], destroys: 0, lists: [] as unknown[][] };
      const approved = input();
      const resultJson = JSON.stringify({ observations: 12, status: 'complete' });
      const defaultEnvelope = {
          version: 1, task_sha256: approved.taskSha256, program_sha256: approved.programSha256,
          result_json: resultJson, result_sha256: digest(resultJson),
      };
      if (options.resultEnvelope !== null)
          files.set('/faultline/result.json', new TextEncoder().encode(JSON.stringify(options.resultEnvelope ?? defaultEnvelope)));
      const metadata = { ...baseMetadata(), ...options.metadata };
      const sandbox = {
          ...metadata,
          files: {
              async write(path: string, data: string | Uint8Array, settings?: {
                  mode?: number;
              }) {
                  const original = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
                  const stored = options.mutateWrite?.(path, original) ?? original;
                  calls.writes.push([path, settings]);
                  files.set(path, stored);
              },
              async stat(path: string) {
                  const value = files.get(path);
                  if (!value)
                      throw new Error('missing');
                  return { name: path.split('/').at(-1)!, size: value.byteLength, isDir: false };
              },
              async read(path: string, settings: {
                  format: 'bytes';
                  offset?: number;
                  length?: number;
              }) {
                  calls.reads.push([path, settings]);
                  const value = files.get(path);
                  if (!value)
                      throw new Error('missing');
                  return value.slice(settings.offset ?? 0, settings.length === undefined ? undefined : (settings.offset ?? 0) + settings.length);
              },
          },
          async exec(command: string, settings: unknown) {
              calls.exec.push([command, settings]);
              return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, ...options.exec };
          },
          async destroy() { calls.destroys++; if (options.destroyError)
              throw options.destroyError; },
      };
      const factory = {
          async create(...args: unknown[]) { calls.create.push(args); options.onCreate?.(); return sandbox; },
          async list(...args: unknown[]) {
              calls.lists.push(args);
              if (options.listError)
                  throw options.listError;
              return options.residualAfterDestroy ? [{ id: metadata.id }] : [];
          },
      };
      return { calls, factory, files };
  }
  
  test('uses an isolated finite sandbox, fixed files and a constant bounded command, then destroys it', async () => {
      const mock = harness();
      const result = await executeRailwaySandbox(input(), { sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'synthetic-token' } });
      assert.deepEqual(result, {
          sandboxId: 'sandbox-1', taskSha256: digest(taskJson), programSha256: digest(programBytes),
          resultSha256: digest(JSON.stringify({ observations: 12, status: 'complete' })),
          result: { observations: 12, status: 'complete' },
      });
      assert.deepEqual(mock.calls.create, [['faultline-runner-v1', {
                  token: 'synthetic-token', environmentId: 'env-approved', networkIsolation: 'ISOLATED',
                  authType: 'project-token',
                  idleTimeoutMinutes: 1, resources: { cpu: 1, memoryGB: 1 },
              }]]);
      assert.deepEqual(mock.calls.writes, [
          ['/faultline/program.mjs', { mode: 0o500 }], ['/faultline/task.json', { mode: 0o400 }],
      ]);
      assert.equal(mock.calls.exec.length, 1);
      assert.equal(mock.calls.exec[0]![0], 'node /faultline/program.mjs /faultline/task.json /faultline/result.json');
      assert.deepEqual(mock.calls.exec[0]![1], {
          timeoutSec: 30, signal: undefined, ephemeral: true, captureOutput: true,
          maxOutputBytes: 64 * 1024, cwd: '/faultline',
      });
      assert.equal(mock.calls.destroys, 1);
      assert.deepEqual(mock.calls.lists, [[{
                  token: 'synthetic-token', authType: 'project-token', environmentId: 'env-approved', first: 100,
              }]]);
      assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
  });
  
  test('exposes immutable configured and unconfigured provider metadata without credentials', async () => {
      const configured = createRailwaySandboxProvider(configuredEnvironment);
      assert.equal(configured.configured, true);
      assert.equal(configured.reason, null);
      assert.equal(Object.isFrozen(configured), true);
      assert.equal(Object.isFrozen(configured.metadata), true);
      assert.deepEqual(configured.metadata, {
          adapter_id: 'faultline.hardened-sandbox.railway', adapter_version: 'railway-sandbox-v1',
          provider_id: 'railway', provider_version: 'railway-sdk-3.16.0', isolation: 'hardened_vm',
          cleanup_verification: true, crash_reconciliation: false, configuration_digest: configured.metadata.configuration_digest,
      });
      assert.match(configured.metadata.configuration_digest, /^[a-f0-9]{64}$/);
      assert.notEqual(configured.metadata.configuration_digest, createRailwaySandboxProvider({ ...configuredEnvironment, RUNNER_SANDBOX_CHECKPOINT: 'another-checkpoint' }).metadata.configuration_digest);
      assert.equal(JSON.stringify(configured).includes('synthetic-token'), false);
      for (const [environment, reason] of [
          [{}, 'credential_missing'],
          [{ RAILWAY_TOKEN: 'x' }, 'environment_missing'],
          [{ RAILWAY_TOKEN: 'x', RAILWAY_ENVIRONMENT_ID: 'env-approved' }, 'checkpoint_missing'],
      ] as const) {
          const provider = createRailwaySandboxProvider(environment);
          assert.equal(provider.configured, false);
          assert.equal(provider.reason, reason);
          await assert.rejects(provider.execute(providerInput()), domain('RUNNER_SANDBOX_NOT_CONFIGURED'));
      }
  });
  
  test('advertises unsupported crash reconciliation and returns only unverified unknown states', async () => {
      const provider = createRailwaySandboxProvider(configuredEnvironment);
      assert.equal(provider.metadata.cleanup_verification, true);
      assert.equal(provider.metadata.crash_reconciliation, false);
      assert.deepEqual(await provider.inspect('controller-task-a'), { status: 'unknown', cleanup_verified: false });
      assert.deepEqual(await provider.cancel('controller-task-a'), { status: 'unknown', cleanup_verified: false });
      await assert.rejects(provider.inspect(''), domain('RUNNER_SANDBOX_INPUT_INVALID'));
      await assert.rejects(provider.cancel('x'.repeat(201)), domain('RUNNER_SANDBOX_INPUT_INVALID'));
  });
  
  test('generic provider execution delegates with provider-owned Railway configuration', async () => {
      const mock = harness();
      const provider = createRailwaySandboxProvider(configuredEnvironment, { sandboxFactory: mock.factory });
      const result = await provider.execute(providerInput());
      assert.deepEqual(result, {
          executionId: 'sandbox-1', taskSha256: digest(taskJson), programSha256: digest(programBytes),
          resultSha256: digest(JSON.stringify({ observations: 12, status: 'complete' })),
          result: { observations: 12, status: 'complete' },
      });
      assert.deepEqual(mock.calls.create[0], ['faultline-runner-v1', {
              token: 'synthetic-token', authType: 'project-token', environmentId: 'env-approved',
              networkIsolation: 'ISOLATED', idleTimeoutMinutes: 1, resources: { cpu: 1, memoryGB: 1 },
          }]);
      assert.equal(Object.hasOwn(providerInput(), 'environmentId'), false);
      assert.equal(Object.hasOwn(providerInput(), 'checkpointName'), false);
  });
  
  test('generic execution is idempotent by stable key and rejects hash conflicts', async () => {
      const mock = harness();
      const provider = createRailwaySandboxProvider(configuredEnvironment, { sandboxFactory: mock.factory });
      const first = await provider.execute(providerInput());
      const retried = await provider.execute({ ...providerInput(), timeoutSeconds: 45 });
      assert.deepEqual(retried, first);
      assert.equal(mock.calls.create.length, 1);
      assert.equal(mock.calls.destroys, 1);
      const differentProgram = new TextEncoder().encode('export const changed = true;');
      await assert.rejects(provider.execute({
          ...providerInput(), programBytes: differentProgram, programSha256: digest(differentProgram),
      }), domain('RUNNER_SANDBOX_EXECUTION_CONFLICT'));
      assert.equal(mock.calls.create.length, 1);
  });
  
  test('generic provider enforces input hashes before creation and confirms cleanup', async () => {
      const mock = harness();
      const provider = createRailwaySandboxProvider(configuredEnvironment, { sandboxFactory: mock.factory });
      await assert.rejects(provider.execute({ ...providerInput(), programSha256: '0'.repeat(64) }), domain('RUNNER_SANDBOX_INPUT_HASH_MISMATCH'));
      assert.equal(mock.calls.create.length, 0);
      const residual = harness({ residualAfterDestroy: true });
      const residualProvider = createRailwaySandboxProvider(configuredEnvironment, { sandboxFactory: residual.factory });
      await assert.rejects(residualProvider.execute(providerInput()), domain('RUNNER_SANDBOX_CLEANUP_UNKNOWN'));
      assert.equal(residual.calls.destroys, 1);
      assert.equal(residual.calls.lists.length, 1);
  });
  
  test('provider failures and outputs do not disclose the Railway credential', async () => {
      const successful = harness();
      const result = await createRailwaySandboxProvider(configuredEnvironment, { sandboxFactory: successful.factory }).execute(providerInput());
      assert.equal(JSON.stringify(result).includes(configuredEnvironment.RAILWAY_TOKEN), false);
      const credentialBearingFailure = harness();
      credentialBearingFailure.factory.create = async () => {
          throw new DomainError('PROVIDER_REJECTED', `request rejected for ${configuredEnvironment.RAILWAY_TOKEN}`, 503);
      };
      await assert.rejects(createRailwaySandboxProvider(configuredEnvironment, { sandboxFactory: credentialBearingFailure.factory }).execute(providerInput()), error => error instanceof DomainError && error.code === 'RUNNER_SANDBOX_PROVIDER_FAILED' &&
          !error.message.includes(configuredEnvironment.RAILWAY_TOKEN) && !JSON.stringify(error).includes(configuredEnvironment.RAILWAY_TOKEN));
  });
  
  test('rejects a wrong environment or network mode and still destroys the sandbox', async () => {
      for (const [metadata, code] of [
          [{ environmentId: 'env-other' }, 'RUNNER_SANDBOX_METADATA_MISMATCH'],
          [{ networkIsolation: 'PRIVATE' }, 'RUNNER_SANDBOX_ISOLATION_FAILED'],
      ] as const) {
          const mock = harness({ metadata });
          await assert.rejects(executeRailwaySandbox(input(), { sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'x' } }), domain(code));
          assert.equal(mock.calls.destroys, 1);
          assert.equal(mock.calls.exec.length, 0);
      }
  });
  
  test('timeout, truncated output and nonzero exit are failures with confirmed destruction', async () => {
      for (const [exec, code] of [
          [{ timedOut: true }, 'RUNNER_SANDBOX_TIMEOUT'],
          [{ truncated: true }, 'RUNNER_SANDBOX_OUTPUT_TRUNCATED'],
          [{ exitCode: 7 }, 'RUNNER_SANDBOX_EXECUTION_FAILED'],
      ] as const) {
          const mock = harness({ exec });
          await assert.rejects(executeRailwaySandbox(input(), { sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'x' } }), domain(code));
          assert.equal(mock.calls.destroys, 1);
      }
  });
  
  test('detects altered task and program bytes before execution', async () => {
      for (const alteredPath of ['/faultline/task.json', '/faultline/program.mjs']) {
          const mock = harness({ mutateWrite: (path, value) => path === alteredPath
                  ? Uint8Array.from(value, (byte, index) => index === 0 ? byte ^ 1 : byte) : value });
          await assert.rejects(executeRailwaySandbox(input(), { sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'x' } }), domain('RUNNER_SANDBOX_UPLOAD_MISMATCH'));
          assert.equal(mock.calls.exec.length, 0);
          assert.equal(mock.calls.destroys, 1);
      }
  });
  
  test('rejects altered result payload, task binding and a missing result', async () => {
      const approved = input(), payload = JSON.stringify({ ok: true });
      for (const [resultEnvelope, code] of [
          [{ version: 1, task_sha256: approved.taskSha256, program_sha256: approved.programSha256,
                  result_json: payload, result_sha256: '0'.repeat(64) }, 'RUNNER_SANDBOX_RESULT_HASH_MISMATCH'],
          [{ version: 1, task_sha256: '1'.repeat(64), program_sha256: approved.programSha256,
                  result_json: payload, result_sha256: digest(payload) }, 'RUNNER_SANDBOX_RESULT_BINDING_MISMATCH'],
          [null, 'RUNNER_SANDBOX_RESULT_INVALID'],
      ] as const) {
          const mock = harness({ resultEnvelope: resultEnvelope as Record<string, unknown> | null });
          await assert.rejects(executeRailwaySandbox(approved, { sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'x' } }), domain(code));
          assert.equal(mock.calls.destroys, 1);
      }
  });
  
  test('abort after creation prevents file or command execution and destroys the sandbox', async () => {
      const controller = new AbortController();
      const mock = harness({ onCreate: () => controller.abort(new Error('cancelled')) });
      await assert.rejects(executeRailwaySandbox(input(controller.signal), {
          sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'x' },
      }), domain('RUNNER_SANDBOX_ABORTED'));
      assert.equal(mock.calls.writes.length, 0);
      assert.equal(mock.calls.exec.length, 0);
      assert.equal(mock.calls.destroys, 1);
  });
  
  test('a destroy failure overrides successful or failed execution with unknown cleanup', async () => {
      for (const exec of [{}, { exitCode: 2 }]) {
          const mock = harness({ exec, destroyError: new Error('provider unavailable') });
          await assert.rejects(executeRailwaySandbox(input(), { sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'x' } }), domain('RUNNER_SANDBOX_CLEANUP_UNKNOWN'));
          assert.equal(mock.calls.destroys, 1);
      }
  });
  
  test('a failed cleanup listing or residual sandbox is containment unknown', async () => {
      for (const options of [
          { listError: new Error('provider unavailable') },
          { residualAfterDestroy: true },
      ]) {
          const mock = harness(options);
          await assert.rejects(executeRailwaySandbox(input(), {
              sandboxFactory: mock.factory, environment: { RAILWAY_TOKEN: 'x' },
          }), domain('RUNNER_SANDBOX_CLEANUP_UNKNOWN'));
          assert.equal(mock.calls.destroys, 1);
          assert.equal(mock.calls.lists.length, 1);
      }
  });
  
  test('local hashes and finite input bounds fail before credentials or sandbox creation', async () => {
      const mock = harness();
      await assert.rejects(executeRailwaySandbox({ ...input(), taskSha256: '0'.repeat(64) }, { sandboxFactory: mock.factory, environment: {} }), domain('RUNNER_SANDBOX_INPUT_HASH_MISMATCH'));
      await assert.rejects(executeRailwaySandbox({ ...input(), timeoutSeconds: 601 }, { sandboxFactory: mock.factory, environment: {} }), domain('RUNNER_SANDBOX_INPUT_INVALID'));
      assert.equal(mock.calls.create.length, 0);
  });
});

describe("remote sandbox", async () => {
  const KEY = Buffer.alloc(32, 17);
  
  const PROTOCOL = 'faultline-remote-sandbox-v1';
  
  const ISOLATION = 'd'.repeat(64);
  
  const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  
  const sign = (value: unknown) => createHmac('sha256', KEY).update(canonical(value)).digest('hex');
  
  const taskJson = canonical({ version: 1, plan_hash: 'a'.repeat(64) });
  
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
      requestTimeoutMs: 5000,
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
              if (options.throwWithSecret)
                  throw new Error(`transport leaked ${KEY.toString('base64')}`);
              if (options.malformed)
                  return { status: 200, body: Buffer.from('{') };
              const wire = JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, unknown>;
              const candidate = wire.signature;
              const { signature: _signature, ...unsigned } = wire;
              assert.equal(candidate, sign(unsigned));
              assert.equal(request.endpoint, configuration().endpoint);
              assert.equal(request.headers['x-faultline-request-sha256'], sha256(canonical(unsigned)));
              assert.ok(request.timeoutMs >= 1 && request.timeoutMs <= 630000);
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
                  const resultJson = canonical({ ok: true, observations: 12 });
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
          const envelope = { ...unsigned, signature: tamper ? '0'.repeat(64) : sign(unsigned) };
          const body = canonical(envelope);
          return { status, body: Buffer.from(options.duplicateResponseKey ? body.replace('{"at"', '{"version":1,"at"') : body) };
      }
      return { transport, calls, states };
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
          resultSha256: sha256(canonical({ ok: true, observations: 12 })), result: { observations: 12, ok: true },
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
      assert.deepEqual(await firstProvider.execute({ ...input(), timeoutSeconds: 45 }), first);
      assert.equal(mock.calls.length, 1);
      const restartedProvider = provider(mock);
      assert.deepEqual(await restartedProvider.execute(input()), first);
      assert.equal(mock.calls.length, 2);
      const differentTask = canonical({ version: 1, plan_hash: 'b'.repeat(64) });
      await assert.rejects(firstProvider.execute(input({ taskJson: differentTask, taskSha256: sha256(differentTask) })), domain('RUNNER_SANDBOX_EXECUTION_CONFLICT'));
      await assert.rejects(provider(mock).execute(input({ taskJson: differentTask, taskSha256: sha256(differentTask) })), domain('RUNNER_SANDBOX_EXECUTION_CONFLICT'));
  });
  
  test('cancels a running execution, verifies destruction and reports it after provider restart', async () => {
      const mock = harness({ executeStatus: 'running' });
      const remote = provider(mock);
      await assert.rejects(remote.execute(input()), domain('RUNNER_SANDBOX_EXECUTION_IN_PROGRESS'));
      assert.deepEqual(await remote.cancel(input().executionKey), { status: 'destroyed', cleanup_verified: true });
      assert.deepEqual(await remote.inspect(input().executionKey), { status: 'destroyed', cleanup_verified: true });
      assert.deepEqual(await provider(mock).inspect(input().executionKey), { status: 'destroyed', cleanup_verified: true });
  });
  
  test('recovers a completed execution by inspection after controller restart', async () => {
      const mock = harness();
      const completed = await provider(mock).execute(input());
      assert.deepEqual(await provider(mock).inspect(input().executionKey), {
          status: 'completed', cleanup_verified: true, execution: completed,
      });
  });
  
  test('cancelling an already completed and destroyed remote execution retains verified containment', async () => {
      const mock = harness({ cancelKeepsCompleted: true }), remote = provider(mock);
      await remote.execute(input());
      assert.deepEqual(await remote.cancel(input().executionKey), { status: 'destroyed', cleanup_verified: true });
  });
  
  test('fails closed when completed state lacks cleanup proof or carries a wrong result digest', async () => {
      await assert.rejects(provider(harness({ cleanupVerified: false })).execute(input()), domain('RUNNER_SANDBOX_CLEANUP_UNKNOWN'));
      await assert.rejects(provider(harness({ tamperResultHash: true })).execute(input()), domain('RUNNER_SANDBOX_RESULT_HASH_MISMATCH'));
  });
  
  test('rejects timeout, malformed, oversized and unauthenticated responses', async () => {
      const never: RemoteSandboxTransport = { request: async () => new Promise<RemoteSandboxTransportResponse>(() => undefined) };
      const timed = createRemoteSandboxProvider(configuration({ requestTimeoutMs: 5 }), { transport: never });
      await assert.rejects(timed.execute(input()), domain('RUNNER_SANDBOX_TIMEOUT'));
      await assert.rejects(provider(harness({ malformed: true })).execute(input()), domain('RUNNER_REMOTE_RESPONSE_INVALID'));
      await assert.rejects(provider(harness({ duplicateResponseKey: true })).execute(input()), domain('RUNNER_REMOTE_RESPONSE_INVALID'));
      await assert.rejects(provider(harness({ responseAt: '2026-10-17T11:58:59.999Z' })).execute(input()), domain('RUNNER_REMOTE_RESPONSE_AUTHENTICATION_FAILED'));
      await assert.rejects(provider(harness({ tamperSignature: true })).execute(input()), domain('RUNNER_REMOTE_RESPONSE_AUTHENTICATION_FAILED'));
      const oversized: RemoteSandboxTransport = { request: async () => ({ status: 200, body: new Uint8Array(1024 * 1024 + 1) }) };
      await assert.rejects(createRemoteSandboxProvider(configuration(), { transport: oversized }).execute(input()), domain('RUNNER_REMOTE_RESPONSE_INVALID'));
  });
  
  test('rejects endpoint credential, fragment, query, HTTP and non-443 port configurations', () => {
      for (const endpoint of [
          'http://sandbox.example.test/v1/faultline',
          'https://user:password@sandbox.example.test/v1/faultline',
          'https://sandbox.example.test:8443/v1/faultline',
          'https://sandbox.example.test/v1/faultline?mode=test',
          'https://sandbox.example.test/v1/faultline#section',
      ])
          assert.throws(() => createRemoteSandboxProvider(configuration({ endpoint })), domain('RUNNER_REMOTE_CONFIGURATION_INVALID'));
  });
  
  test('never exposes authentication key through metadata, results or provider failures', async () => {
      const successful = harness();
      const remote = provider(successful);
      const result = await remote.execute(input());
      const key = KEY.toString('base64');
      assert.equal(JSON.stringify(remote).includes(key), false);
      assert.equal(JSON.stringify(remote.metadata).includes(key), false);
      assert.equal(JSON.stringify(result).includes(key), false);
      await assert.rejects(provider(harness({ throwWithSecret: true })).execute(input()), error => error instanceof DomainError &&
          error.code === 'RUNNER_SANDBOX_PROVIDER_FAILED' && !error.message.includes(key) && !JSON.stringify(error).includes(key));
  });
});
