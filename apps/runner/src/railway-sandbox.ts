import {createHash} from 'node:crypto';
import {Sandbox} from 'railway';
import {DomainError, demand} from '../../../packages/core/src/errors.js';
import type {
  HardenedSandboxExecution,
  HardenedSandboxExecutionInput,
  HardenedSandboxProvider,
  HardenedSandboxProviderMetadata,
} from './sandbox-provider.js';

const PROGRAM_PATH = '/faultline/program.mjs';
const TASK_PATH = '/faultline/task.json';
const RESULT_PATH = '/faultline/result.json';
const EXEC_COMMAND = 'node /faultline/program.mjs /faultline/task.json /faultline/result.json';
const MAX_PROGRAM_BYTES = 4 * 1024 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_EXECUTION_KEYS = 10_000;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RailwaySandboxInput {
  readonly environmentId: string;
  readonly checkpointName: string;
  readonly taskJson: string;
  readonly taskSha256: string;
  readonly programBytes: Uint8Array;
  readonly programSha256: string;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

interface FileEntry {
  readonly name: string;
  readonly size: number;
  readonly isDir: boolean;
}

interface SandboxFilesLike {
  write(path: string, data: string | Uint8Array, options?: {mode?: number}): Promise<void>;
  stat(path: string): Promise<FileEntry>;
  read(path: string, options: {format: 'bytes'; offset?: number; length?: number}): Promise<Uint8Array>;
}

interface ExecResultLike {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

interface SandboxLike {
  readonly id: string;
  readonly status: string;
  readonly networkIsolation: string;
  readonly domains: readonly unknown[];
  readonly environmentId: string;
  readonly region: string;
  readonly idleTimeoutMinutes: number | null;
  readonly createdAt: string;
  readonly files: SandboxFilesLike;
  exec(command: string, options: {
    timeoutSec: number;
    signal?: AbortSignal;
    ephemeral: true;
    captureOutput: true;
    maxOutputBytes: number;
    cwd: '/faultline';
  }): PromiseLike<ExecResultLike>;
  destroy(): Promise<void>;
}

interface SandboxFactory {
  create(checkpointName: string, options: {
    token: string;
    authType: 'project-token';
    environmentId: string;
    networkIsolation: 'ISOLATED';
    idleTimeoutMinutes: 1;
    resources: {cpu: 1; memoryGB: 1};
  }): Promise<SandboxLike>;
  list(options: {
    token: string;
    authType: 'project-token';
    environmentId: string;
    first: 100;
  }): Promise<readonly {id: string}[]>;
}

export interface RailwaySandboxDependencies {
  readonly sandboxFactory?: SandboxFactory;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface RailwaySandboxExecution {
  readonly sandboxId: string;
  readonly taskSha256: string;
  readonly programSha256: string;
  readonly resultSha256: string;
  readonly result: unknown;
}

interface ResultEnvelope {
  readonly version: 1;
  readonly task_sha256: string;
  readonly program_sha256: string;
  readonly result_json: string;
  readonly result_sha256: string;
}

const sdkFactory: SandboxFactory = {
  create: (checkpointName, options) => Sandbox.create(checkpointName, options) as Promise<unknown> as Promise<SandboxLike>,
  list: (options) => Sandbox.list(options),
};

const RAILWAY_METADATA_BASE = Object.freeze({
  adapter_id: 'faultline.hardened-sandbox.railway',
  adapter_version: 'railway-sandbox-v1',
  provider_id: 'railway',
  provider_version: 'railway-sdk-3.16.0',
  isolation: 'hardened_vm',
  cleanup_verification: true,
  crash_reconciliation: false,
});

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DomainError('RUNNER_SANDBOX_ABORTED', 'Sandbox execution was cancelled.', 499);
}

function validateInput(input: HardenedSandboxExecutionInput): void {
  demand(typeof input.executionKey === 'string' && input.executionKey.length >= 1 && input.executionKey.length <= 200,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner execution key must be finite.');
  demand(typeof input.taskJson === 'string' && bytes(input.taskJson) > 0 && bytes(input.taskJson) <= MAX_TASK_BYTES,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner task JSON exceeds its finite bound.');
  try { JSON.parse(input.taskJson); } catch { throw new DomainError('RUNNER_SANDBOX_INPUT_INVALID', 'Runner task must be valid JSON.'); }
  demand(input.programBytes instanceof Uint8Array && input.programBytes.byteLength > 0 && input.programBytes.byteLength <= MAX_PROGRAM_BYTES,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner program exceeds its finite bound.');
  demand(Number.isSafeInteger(input.timeoutSeconds) && input.timeoutSeconds >= 1 && input.timeoutSeconds <= 600,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner timeout must be an integer from 1 through 600 seconds.');
  demand(SHA256.test(input.taskSha256) && sha256(input.taskJson) === input.taskSha256,
    'RUNNER_SANDBOX_INPUT_HASH_MISMATCH', 'Runner task hash does not match the supplied bytes.');
  demand(SHA256.test(input.programSha256) && sha256(input.programBytes) === input.programSha256,
    'RUNNER_SANDBOX_INPUT_HASH_MISMATCH', 'Runner program hash does not match the supplied bytes.');
}

function validateSandbox(sandbox: SandboxLike, environmentId: string): void {
  demand(sandbox.environmentId === environmentId, 'RUNNER_SANDBOX_METADATA_MISMATCH', 'Sandbox environment does not match the approved environment.');
  demand(sandbox.networkIsolation === 'ISOLATED', 'RUNNER_SANDBOX_ISOLATION_FAILED', 'Sandbox did not enter isolated network mode.');
  demand(sandbox.status === 'RUNNING', 'RUNNER_SANDBOX_NOT_RUNNING', 'Sandbox is not running.');
  demand(sandbox.id.length >= 1 && sandbox.id.length <= 200 && sandbox.region.length >= 1 && sandbox.region.length <= 100,
    'RUNNER_SANDBOX_METADATA_INVALID', 'Sandbox identity or region metadata is not finite.');
  demand(sandbox.idleTimeoutMinutes === 1 && Array.isArray(sandbox.domains) && sandbox.domains.length === 0,
    'RUNNER_SANDBOX_METADATA_INVALID', 'Sandbox lifetime or published-domain metadata is unsafe.');
  const createdAt = Date.parse(sandbox.createdAt);
  demand(sandbox.createdAt.length <= 100 && Number.isFinite(createdAt), 'RUNNER_SANDBOX_METADATA_INVALID', 'Sandbox creation time is invalid.');
}

async function verifyUploadedFile(sandbox: SandboxLike, path: string, expected: string | Uint8Array, expectedHash: string): Promise<void> {
  const expectedSize = typeof expected === 'string' ? bytes(expected) : expected.byteLength;
  const stat = await sandbox.files.stat(path);
  demand(!stat.isDir && stat.size === expectedSize, 'RUNNER_SANDBOX_UPLOAD_MISMATCH', 'Sandbox upload size does not match its approved input.');
  const uploaded = await sandbox.files.read(path, {format: 'bytes', offset: 0, length: expectedSize + 1});
  demand(uploaded.byteLength === expectedSize && sha256(uploaded) === expectedHash,
    'RUNNER_SANDBOX_UPLOAD_MISMATCH', 'Sandbox upload bytes do not match their approved hash.');
}

function parseResult(raw: Uint8Array, input: HardenedSandboxExecutionInput): {result: unknown; resultSha256: string} {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw).toString('utf8')); }
  catch { throw new DomainError('RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox result is not valid JSON.'); }
  demand(value !== null && typeof value === 'object' && !Array.isArray(value),
    'RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox result envelope must be an object.');
  const envelope = value as Partial<ResultEnvelope>;
  demand(Object.keys(envelope).length === 5 && Object.keys(envelope).every(key =>
    ['version', 'task_sha256', 'program_sha256', 'result_json', 'result_sha256'].includes(key)),
  'RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox result envelope has unexpected fields.');
  demand(envelope.version === 1 && envelope.task_sha256 === input.taskSha256 && envelope.program_sha256 === input.programSha256,
    'RUNNER_SANDBOX_RESULT_BINDING_MISMATCH', 'Sandbox result does not bind the approved task and program.');
  demand(typeof envelope.result_json === 'string' && bytes(envelope.result_json) <= MAX_RESULT_BYTES &&
    typeof envelope.result_sha256 === 'string' && SHA256.test(envelope.result_sha256) && sha256(envelope.result_json) === envelope.result_sha256,
  'RUNNER_SANDBOX_RESULT_HASH_MISMATCH', 'Sandbox result payload hash is invalid.');
  let result: unknown;
  try { result = JSON.parse(envelope.result_json); }
  catch { throw new DomainError('RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox result payload is not valid JSON.'); }
  return {result, resultSha256: envelope.result_sha256};
}

async function readResult(sandbox: SandboxLike): Promise<Uint8Array> {
  try {
    const resultStat = await sandbox.files.stat(RESULT_PATH);
    demand(!resultStat.isDir && resultStat.size > 0 && resultStat.size <= MAX_RESULT_BYTES,
      'RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox result is missing or exceeds its finite bound.');
    const raw = await sandbox.files.read(RESULT_PATH, {format: 'bytes', offset: 0, length: MAX_RESULT_BYTES + 1});
    demand(raw.byteLength === resultStat.size && raw.byteLength <= MAX_RESULT_BYTES,
      'RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox result read is incomplete or oversized.');
    return raw;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox result is missing or unreadable.');
  }
}

/**
 * Executes one immutable runner task in a short-lived Railway VM. The command,
 * paths, resources and isolation settings are constants; caller data is only
 * transferred as verified files.
 */
export async function executeRailwaySandbox(
  input: RailwaySandboxInput,
  dependencies: RailwaySandboxDependencies = {},
): Promise<RailwaySandboxExecution> {
  demand(typeof input.environmentId === 'string' && input.environmentId.length >= 1 && input.environmentId.length <= 200,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Railway environment ID must be finite.');
  demand(typeof input.checkpointName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.checkpointName),
    'RUNNER_SANDBOX_INPUT_INVALID', 'Railway checkpoint name is invalid.');
  const provider = createRailwaySandboxProvider({
    ...(dependencies.environment ?? process.env),
    RAILWAY_ENVIRONMENT_ID: input.environmentId,
    RUNNER_SANDBOX_CHECKPOINT: input.checkpointName,
  }, dependencies);
  const result = await provider.execute({
    executionKey: input.taskSha256,
    taskJson: input.taskJson,
    taskSha256: input.taskSha256,
    programBytes: input.programBytes,
    programSha256: input.programSha256,
    timeoutSeconds: input.timeoutSeconds,
    signal: input.signal,
  });
  return {
    sandboxId: result.executionId,
    taskSha256: result.taskSha256,
    programSha256: result.programSha256,
    resultSha256: result.resultSha256,
    result: result.result,
  };
}

function configurationReason(environment: Readonly<Record<string, string | undefined>>): string | null {
  const token = environment.RAILWAY_TOKEN;
  if (!(typeof token === 'string' && token.length > 0 && token.length <= 8192)) return 'credential_missing';
  const environmentId = environment.RAILWAY_ENVIRONMENT_ID;
  if (!(typeof environmentId === 'string' && environmentId.length >= 1 && environmentId.length <= 200)) return 'environment_missing';
  const checkpointName = environment.RUNNER_SANDBOX_CHECKPOINT;
  if (!(typeof checkpointName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(checkpointName))) return 'checkpoint_missing';
  return null;
}

function safeProviderFailure(error: unknown, token: string): DomainError {
  const disclosesCredential = token.length >= 8 && `${error instanceof DomainError ? error.code : ''}\0${error instanceof Error ? error.message : ''}`.includes(token);
  if (error instanceof DomainError && !disclosesCredential) {
    return new DomainError(error.code, error.message, error.status);
  }
  return new DomainError('RUNNER_SANDBOX_PROVIDER_FAILED', 'The sandbox provider could not complete the requested operation.', 503);
}

function validateExecutionKey(executionKey: string): void {
  demand(typeof executionKey === 'string' && executionKey.length >= 1 && executionKey.length <= 200,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner execution key must be finite.');
}

async function executeConfiguredRailwaySandbox(
  input: HardenedSandboxExecutionInput,
  environment: Readonly<Record<string, string | undefined>>,
  factory: SandboxFactory,
): Promise<HardenedSandboxExecution> {
  throwIfAborted(input.signal);
  const token = environment.RAILWAY_TOKEN;
  demand(typeof token === 'string' && token.length > 0 && token.length <= 8192,
    'RUNNER_SANDBOX_CREDENTIAL_MISSING', 'A project-scoped Railway sandbox credential is unavailable.', 503);
  const environmentId = environment.RAILWAY_ENVIRONMENT_ID;
  const checkpointName = environment.RUNNER_SANDBOX_CHECKPOINT;
  demand(typeof environmentId === 'string' && environmentId.length >= 1 && environmentId.length <= 200,
    'RUNNER_SANDBOX_CONFIGURATION_INVALID', 'Railway environment configuration is unavailable.', 503);
  demand(typeof checkpointName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(checkpointName),
    'RUNNER_SANDBOX_CONFIGURATION_INVALID', 'Railway checkpoint configuration is unavailable.', 503);
  let sandbox: SandboxLike | undefined;
  let outcome: HardenedSandboxExecution | undefined;
  let failure: unknown;
  try {
    sandbox = await factory.create(checkpointName, {
      token,
      authType: 'project-token',
      environmentId,
      networkIsolation: 'ISOLATED',
      idleTimeoutMinutes: 1,
      resources: {cpu: 1, memoryGB: 1},
    });
    throwIfAborted(input.signal);
    validateSandbox(sandbox, environmentId);
    await sandbox.files.write(PROGRAM_PATH, input.programBytes, {mode: 0o500});
    await verifyUploadedFile(sandbox, PROGRAM_PATH, input.programBytes, input.programSha256);
    throwIfAborted(input.signal);
    await sandbox.files.write(TASK_PATH, input.taskJson, {mode: 0o400});
    await verifyUploadedFile(sandbox, TASK_PATH, input.taskJson, input.taskSha256);
    throwIfAborted(input.signal);
    const execution = await sandbox.exec(EXEC_COMMAND, {
      timeoutSec: input.timeoutSeconds,
      signal: input.signal,
      ephemeral: true,
      captureOutput: true,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      cwd: '/faultline',
    });
    demand(!execution.timedOut, 'RUNNER_SANDBOX_TIMEOUT', 'Sandbox execution reached its approved deadline.', 504);
    demand(!execution.truncated, 'RUNNER_SANDBOX_OUTPUT_TRUNCATED', 'Sandbox execution output exceeded its finite bound.');
    demand(execution.exitCode === 0, 'RUNNER_SANDBOX_EXECUTION_FAILED', 'Sandbox program exited without a successful result.');
    throwIfAborted(input.signal);
    const raw = await readResult(sandbox);
    const parsed = parseResult(raw, input);
    outcome = {
      executionId: sandbox.id,
      taskSha256: input.taskSha256,
      programSha256: input.programSha256,
      resultSha256: parsed.resultSha256,
      result: parsed.result,
    };
  } catch (error) {
    failure = input.signal?.aborted
      ? new DomainError('RUNNER_SANDBOX_ABORTED', 'Sandbox execution was cancelled.', 499)
      : safeProviderFailure(error, token);
  } finally {
    if (sandbox) {
      try {
        await sandbox.destroy();
        const remaining = await factory.list({
          token,
          authType: 'project-token',
          environmentId,
          first: 100,
        });
        demand(!remaining.some(item => item.id === sandbox!.id),
          'RUNNER_SANDBOX_CLEANUP_UNKNOWN', 'Railway still lists the sandbox after destruction.', 503);
      }
      catch {
        throw new DomainError('RUNNER_SANDBOX_CLEANUP_UNKNOWN', 'The sandbox provider could not confirm execution destruction.', 503);
      }
    }
  }
  if (failure !== undefined) throw failure;
  demand(outcome, 'RUNNER_SANDBOX_RESULT_INVALID', 'Sandbox execution did not produce a result.');
  demand(token.length < 8 || !JSON.stringify(outcome).includes(token), 'RUNNER_SANDBOX_CREDENTIAL_DISCLOSURE',
    'The sandbox provider returned unsafe execution metadata.', 503);
  return outcome;
}

/** Creates the Railway implementation of the provider-neutral hardened VM boundary. */
export function createRailwaySandboxProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Omit<RailwaySandboxDependencies, 'environment'> = {},
): HardenedSandboxProvider {
  const providerEnvironment = Object.freeze({
    RAILWAY_TOKEN: environment.RAILWAY_TOKEN,
    RAILWAY_ENVIRONMENT_ID: environment.RAILWAY_ENVIRONMENT_ID,
    RUNNER_SANDBOX_CHECKPOINT: environment.RUNNER_SANDBOX_CHECKPOINT,
  });
  const reason = configurationReason(providerEnvironment);
  const configurationDigest = sha256(JSON.stringify({
    provider: 'railway',
    environment_id: providerEnvironment.RAILWAY_ENVIRONMENT_ID ?? null,
    checkpoint_name: providerEnvironment.RUNNER_SANDBOX_CHECKPOINT ?? null,
  }));
  const metadata: HardenedSandboxProviderMetadata = Object.freeze({...RAILWAY_METADATA_BASE, configuration_digest: configurationDigest});
  const factory = dependencies.sandboxFactory ?? sdkFactory;
  const executions = new Map<string, {
    taskSha256: string;
    programSha256: string;
    promise: Promise<HardenedSandboxExecution>;
  }>();
  return Object.freeze({
    metadata,
    configured: reason === null,
    reason,
    async execute(input: HardenedSandboxExecutionInput): Promise<HardenedSandboxExecution> {
      validateInput(input);
      if (reason !== null) {
        throw new DomainError('RUNNER_SANDBOX_NOT_CONFIGURED', 'The hardened sandbox provider is not configured.', 503);
      }
      const existing = executions.get(input.executionKey);
      if (existing) {
        demand(existing.taskSha256 === input.taskSha256 && existing.programSha256 === input.programSha256,
          'RUNNER_SANDBOX_EXECUTION_CONFLICT', 'Runner execution key is already bound to different immutable input.', 409);
        return existing.promise;
      }
      demand(executions.size < MAX_EXECUTION_KEYS, 'RUNNER_SANDBOX_CAPACITY_EXCEEDED',
        'Runner execution key capacity is exhausted.', 503);
      const promise = executeConfiguredRailwaySandbox(input, providerEnvironment, factory);
      executions.set(input.executionKey, {taskSha256: input.taskSha256, programSha256: input.programSha256, promise});
      let probe = false;
      try { const value = JSON.parse(input.taskJson) as Record<string, unknown>; probe = Object.hasOwn(value, 'provider_scope'); } catch {}
      if (probe) void promise.finally(() => { if (executions.get(input.executionKey)?.promise === promise) executions.delete(input.executionKey); }).catch(() => undefined);
      return promise;
    },
    async inspect(executionKey: string) {
      validateExecutionKey(executionKey);
      return {status: 'unknown' as const, cleanup_verified: false};
    },
    async cancel(executionKey: string) {
      validateExecutionKey(executionKey);
      return {status: 'unknown' as const, cleanup_verified: false};
    },
  });
}
