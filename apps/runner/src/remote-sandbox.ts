import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import {canonical} from '../../../packages/core/src/canonical.js';
import {DomainError, demand} from '../../../packages/core/src/errors.js';
import {rejectDuplicateJsonKeys} from '../../../packages/core/src/imports/duplicate-json-keys.js';
import {publicAddress} from '../../../packages/core/src/network/http.js';
import type {
  HardenedSandboxCancellation,
  HardenedSandboxExecution,
  HardenedSandboxExecutionInput,
  HardenedSandboxInspection,
  HardenedSandboxProvider,
  HardenedSandboxProviderMetadata,
} from './sandbox-provider.js';

const PROTOCOL = 'faultline-remote-sandbox-v1';
const ADAPTER_ID = 'faultline.hardened-sandbox.remote';
const ADAPTER_VERSION = 'remote-sandbox-v1';
const MAX_PROGRAM_BYTES = 4 * 1024 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_EXECUTION_KEYS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 630_000;
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const DIGEST = /^[a-f0-9]{64}$/;
const EXECUTION_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface RemoteSandboxTransportRequest {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface RemoteSandboxTransportResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

/** A finite single-endpoint transport. Redirects and response streaming belong here. */
export interface RemoteSandboxTransport {
  request(input: RemoteSandboxTransportRequest): Promise<RemoteSandboxTransportResponse>;
}

export interface RemoteSandboxDependencies {
  readonly transport?: RemoteSandboxTransport;
  readonly clock?: () => Date;
  readonly nonce?: () => string;
}

export interface RemoteSandboxConfiguration {
  readonly endpoint: string;
  /** Canonical base64 for exactly 32 random bytes. */
  readonly authKeyBase64: string;
  readonly providerId: string;
  readonly providerVersion: string;
  /** Digest of the remote VM image, egress policy and destruction policy. */
  readonly isolationConfigurationHash: string;
  readonly requestTimeoutMs?: number;
}

interface NormalizedConfiguration {
  readonly endpoint: string;
  readonly authKey: Buffer;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly isolationConfigurationHash: string;
  readonly requestTimeoutMs: number;
  readonly configurationDigest: string;
}

type Operation = 'execute' | 'inspect' | 'cancel';

interface RequestEnvelope {
  readonly protocol: typeof PROTOCOL;
  readonly version: 1;
  readonly operation: Operation;
  readonly nonce: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly configuration_digest: string;
  readonly isolation_configuration_hash: string;
  readonly execution_key: string;
  readonly task_sha256: string | null;
  readonly program_sha256: string | null;
  readonly payload: null | {
    readonly task_json: string;
    readonly program_base64: string;
    readonly timeout_seconds: number;
  };
}

interface ResponseEnvelope {
  readonly protocol: typeof PROTOCOL;
  readonly version: 1;
  readonly operation: Operation;
  readonly nonce: string;
  readonly request_sha256: string;
  readonly at: string;
  readonly payload: unknown;
  readonly error_code: string | null;
  readonly signature: string;
}

interface RemoteState {
  readonly status: 'completed' | 'running' | 'cancelled' | 'destroyed' | 'unknown';
  readonly execution_key: string;
  readonly execution_id: string | null;
  readonly task_sha256: string | null;
  readonly program_sha256: string | null;
  readonly result_json: string | null;
  readonly result_sha256: string | null;
  readonly cleanup_verified: boolean;
  readonly provider_configuration_hash: string;
  readonly isolation_configuration_hash: string;
}

interface Binding {
  readonly taskSha256: string;
  readonly programSha256: string;
  pending?: Promise<HardenedSandboxExecution>;
  execution?: HardenedSandboxExecution;
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function finiteText(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function signature(value: unknown, key: Buffer): string {
  return createHmac('sha256', key).update(canonical(value)).digest('hex');
}

function signatureMatches(value: unknown, candidate: unknown, key: Buffer): boolean {
  if (typeof candidate !== 'string' || !DIGEST.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(signature(value, key), 'hex'));
}

function parseKey(value: string): Buffer {
  demand(/^[A-Za-z0-9+/]{43}=$/.test(value), 'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox authentication key must be canonical base64 for 32 bytes.', 503);
  const key = Buffer.from(value, 'base64');
  demand(key.byteLength === 32 && key.toString('base64') === value, 'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox authentication key must be canonical base64 for 32 bytes.', 503);
  return key;
}

function normalize(configuration: RemoteSandboxConfiguration): NormalizedConfiguration {
  let endpoint: URL;
  try { endpoint = new URL(configuration.endpoint); }
  catch { throw new DomainError('RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox endpoint must be an exact HTTPS URL.', 503); }
  demand(endpoint.protocol === 'https:' && endpoint.username === '' && endpoint.password === '' && endpoint.hash === '' && endpoint.search === '' && (endpoint.port === '' || endpoint.port === '443'),
    'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox endpoint must use HTTPS on port 443 without credentials, query or fragment.', 503);
  demand(finiteText(endpoint.hostname, 253) && endpoint.pathname.length > 0 && endpoint.pathname.length <= 1024,
    'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox endpoint host or path is invalid.', 503);
  demand(IDENTIFIER.test(configuration.providerId) && IDENTIFIER.test(configuration.providerVersion),
    'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox provider identity is invalid.', 503);
  demand(DIGEST.test(configuration.isolationConfigurationHash),
    'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox isolation configuration hash is invalid.', 503);
  const requestTimeoutMs = configuration.requestTimeoutMs ?? MAX_REQUEST_TIMEOUT_MS;
  demand(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1 && requestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS,
    'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox request timeout is invalid.', 503);
  const normalizedEndpoint = endpoint.href;
  const configurationDigest = sha256(canonical({
    protocol: PROTOCOL,
    endpoint: normalizedEndpoint,
    provider_id: configuration.providerId,
    provider_version: configuration.providerVersion,
    isolation_configuration_hash: configuration.isolationConfigurationHash,
  }));
  return Object.freeze({
    endpoint: normalizedEndpoint,
    authKey: parseKey(configuration.authKeyBase64),
    providerId: configuration.providerId,
    providerVersion: configuration.providerVersion,
    isolationConfigurationHash: configuration.isolationConfigurationHash,
    requestTimeoutMs,
    configurationDigest,
  });
}

const defaultTransport: RemoteSandboxTransport = {
  async request(input) {
    const endpoint = new URL(input.endpoint);
    const answers = await dns.lookup(endpoint.hostname, {all: true, verbatim: true});
    demand(answers.length > 0 && answers.length <= 16 && answers.every(answer => publicAddress(answer.address)),
      'SSRF_DENIED', 'Remote sandbox DNS resolved outside permitted public networks.', 403);
    const selected = answers[0]!;
    return new Promise<RemoteSandboxTransportResponse>((resolve, reject) => {
      const request = https.request(endpoint, {
        method: 'POST',
        headers: input.headers,
        signal: input.signal,
        timeout: input.timeoutMs,
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      }, response => {
        const declaredRaw = response.headers['content-length'];
        const declared = declaredRaw === undefined ? null : Number(Array.isArray(declaredRaw) ? declaredRaw[0] : declaredRaw);
        if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES)) {
          response.destroy();
          reject(new DomainError('RUNNER_REMOTE_RESPONSE_TOO_LARGE', 'Remote sandbox response exceeds its finite bound.', 503));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let failed = false;
        response.on('data', (chunk: Buffer) => {
          if (failed) return;
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            failed = true;
            response.destroy();
            reject(new DomainError('RUNNER_REMOTE_RESPONSE_TOO_LARGE', 'Remote sandbox response exceeds its finite bound.', 503));
          } else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (!failed) resolve({status: response.statusCode ?? 502, body: Buffer.concat(chunks)});
        });
      });
      request.on('timeout', () => request.destroy(new DomainError('RUNNER_SANDBOX_TIMEOUT', 'Remote sandbox request reached its bounded deadline.', 504)));
      request.on('error', reject);
      request.end(Buffer.from(input.body));
    });
  },
};

function validateExecutionKey(executionKey: string): void {
  demand(typeof executionKey === 'string' && EXECUTION_KEY.test(executionKey),
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner execution key is invalid.');
}

function validateInput(input: HardenedSandboxExecutionInput): void {
  validateExecutionKey(input.executionKey);
  demand(typeof input.taskJson === 'string' && byteLength(input.taskJson) > 0 && byteLength(input.taskJson) <= MAX_TASK_BYTES,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner task JSON exceeds its finite bound.');
  let task: unknown;
  try { task = JSON.parse(input.taskJson); }
  catch { throw new DomainError('RUNNER_SANDBOX_INPUT_INVALID', 'Runner task must be valid JSON.'); }
  demand(canonical(task) === input.taskJson, 'RUNNER_SANDBOX_INPUT_INVALID', 'Runner task JSON must use the canonical encoding.');
  demand(input.programBytes instanceof Uint8Array && input.programBytes.byteLength > 0 && input.programBytes.byteLength <= MAX_PROGRAM_BYTES,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner program exceeds its finite bound.');
  demand(Number.isSafeInteger(input.timeoutSeconds) && input.timeoutSeconds >= 1 && input.timeoutSeconds <= 600,
    'RUNNER_SANDBOX_INPUT_INVALID', 'Runner timeout must be an integer from 1 through 600 seconds.');
  demand(DIGEST.test(input.taskSha256) && sha256(input.taskJson) === input.taskSha256 && DIGEST.test(input.programSha256) && sha256(input.programBytes) === input.programSha256,
    'RUNNER_SANDBOX_INPUT_HASH_MISMATCH', 'Runner task or program hash does not match its supplied bytes.');
}

function parseJson(raw: Uint8Array): unknown {
  demand(raw.byteLength > 0 && raw.byteLength <= MAX_RESPONSE_BYTES,
    'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox response is missing or exceeds its finite bound.', 503);
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    rejectDuplicateJsonKeys(text, 16);
    return JSON.parse(text);
  }
  catch { throw new DomainError('RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox response is not valid JSON.', 503); }
}

function parseState(value: unknown, request: RequestEnvelope, configuration: NormalizedConfiguration): RemoteState {
  const keys = ['status', 'execution_key', 'execution_id', 'task_sha256', 'program_sha256', 'result_json', 'result_sha256', 'cleanup_verified', 'provider_configuration_hash', 'isolation_configuration_hash'];
  demand(exact(value, keys), 'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox state has unexpected fields.', 503);
  const state = value as unknown as RemoteState;
  demand(['completed', 'running', 'cancelled', 'destroyed', 'unknown'].includes(state.status) && state.execution_key === request.execution_key && typeof state.cleanup_verified === 'boolean' && state.provider_configuration_hash === configuration.configurationDigest && state.isolation_configuration_hash === configuration.isolationConfigurationHash,
    'RUNNER_REMOTE_RESPONSE_BINDING_MISMATCH', 'Remote sandbox state does not bind the approved execution and isolation configuration.', 503);
  demand(state.execution_id === null || finiteText(state.execution_id, 200), 'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox execution identity is invalid.', 503);
  demand(state.task_sha256 === null || DIGEST.test(state.task_sha256), 'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox task digest is invalid.', 503);
  demand(state.program_sha256 === null || DIGEST.test(state.program_sha256), 'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox program digest is invalid.', 503);
  if (request.task_sha256 !== null) demand(state.task_sha256 === request.task_sha256, 'RUNNER_REMOTE_RESPONSE_BINDING_MISMATCH', 'Remote sandbox state does not bind the approved task.', 503);
  if (request.program_sha256 !== null) demand(state.program_sha256 === request.program_sha256, 'RUNNER_REMOTE_RESPONSE_BINDING_MISMATCH', 'Remote sandbox state does not bind the approved program.', 503);
  if (state.status === 'completed') {
    demand(state.cleanup_verified === true && finiteText(state.execution_id, 200) && state.task_sha256 !== null && state.program_sha256 !== null && typeof state.result_json === 'string' && byteLength(state.result_json) <= MAX_RESPONSE_BYTES && typeof state.result_sha256 === 'string' && DIGEST.test(state.result_sha256),
      'RUNNER_SANDBOX_CLEANUP_UNKNOWN', 'Completed remote execution lacks a verified destruction proof or finite result.', 503);
    let result: unknown;
    try { result = JSON.parse(state.result_json); }
    catch { throw new DomainError('RUNNER_SANDBOX_RESULT_INVALID', 'Remote sandbox result payload is not valid JSON.', 503); }
    demand(canonical(result) === state.result_json && sha256(state.result_json) === state.result_sha256,
      'RUNNER_SANDBOX_RESULT_HASH_MISMATCH', 'Remote sandbox result payload hash or canonical encoding is invalid.', 503);
  } else {
    demand(state.result_json === null && state.result_sha256 === null,
      'RUNNER_REMOTE_RESPONSE_INVALID', 'Non-completed remote state cannot contain a result.', 503);
    if (state.status === 'running') demand(state.cleanup_verified === false, 'RUNNER_REMOTE_RESPONSE_INVALID', 'Running remote execution cannot claim cleanup.', 503);
    if (state.status === 'unknown') demand(state.cleanup_verified === false, 'RUNNER_REMOTE_RESPONSE_INVALID', 'Unknown remote execution cannot claim cleanup.', 503);
    if (state.status === 'cancelled' || state.status === 'destroyed') demand(state.cleanup_verified === true, 'RUNNER_SANDBOX_CLEANUP_UNKNOWN', 'Destroyed remote execution lacks cleanup proof.', 503);
  }
  return state;
}

function executionFrom(state: RemoteState): HardenedSandboxExecution {
  demand(state.status === 'completed' && state.execution_id !== null && state.task_sha256 !== null && state.program_sha256 !== null && state.result_json !== null && state.result_sha256 !== null,
    'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox did not return a completed execution.', 503);
  return {
    executionId: state.execution_id,
    taskSha256: state.task_sha256,
    programSha256: state.program_sha256,
    resultSha256: state.result_sha256,
    result: JSON.parse(state.result_json),
  };
}

function safeFailure(error: unknown, secret: string): DomainError {
  if (error instanceof DomainError && !`${error.code}\0${error.message}`.includes(secret)) return error;
  return new DomainError('RUNNER_SANDBOX_PROVIDER_FAILED', 'The remote sandbox provider could not complete the requested operation.', 503);
}

async function invoke(
  operation: Operation,
  executionKey: string,
  taskSha256: string | null,
  programSha256: string | null,
  payload: RequestEnvelope['payload'],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  configuration: NormalizedConfiguration,
  dependencies: Required<Pick<RemoteSandboxDependencies, 'transport' | 'clock' | 'nonce'>>,
): Promise<RemoteState> {
  if (signal?.aborted) throw new DomainError('RUNNER_SANDBOX_ABORTED', 'Sandbox execution was cancelled.', 499);
  const issuedAt = dependencies.clock();
  demand(Number.isFinite(issuedAt.getTime()), 'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox clock is invalid.', 503);
  const request: RequestEnvelope = {
    protocol: PROTOCOL,
    version: 1,
    operation,
    nonce: dependencies.nonce(),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + timeoutMs).toISOString(),
    configuration_digest: configuration.configurationDigest,
    isolation_configuration_hash: configuration.isolationConfigurationHash,
    execution_key: executionKey,
    task_sha256: taskSha256,
    program_sha256: programSha256,
    payload,
  };
  demand(/^[a-f0-9-]{36}$/.test(request.nonce), 'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Remote sandbox nonce source is invalid.', 503);
  const requestSha256 = sha256(canonical(request));
  const wire = Buffer.from(canonical({...request, signature: signature(request, configuration.authKey)}));
  demand(wire.byteLength <= MAX_REQUEST_BYTES, 'RUNNER_SANDBOX_INPUT_INVALID', 'Remote sandbox request exceeds its finite bound.');

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, {once: true});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let transportResponse: RemoteSandboxTransportResponse;
  try {
    const requestPromise = dependencies.transport.request({
      endpoint: configuration.endpoint,
      headers: Object.freeze({
        'content-type': 'application/json',
        'content-length': String(wire.byteLength),
        'x-faultline-protocol': PROTOCOL,
        'x-faultline-request-sha256': requestSha256,
      }),
      body: wire,
      timeoutMs,
      signal: controller.signal,
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(timedOut
        ? new DomainError('RUNNER_SANDBOX_TIMEOUT', 'Remote sandbox request reached its bounded deadline.', 504)
        : new DomainError('RUNNER_SANDBOX_ABORTED', 'Sandbox execution was cancelled.', 499)), {once: true});
    });
    transportResponse = await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) throw new DomainError('RUNNER_SANDBOX_TIMEOUT', 'Remote sandbox request reached its bounded deadline.', 504);
    if (signal?.aborted) throw new DomainError('RUNNER_SANDBOX_ABORTED', 'Sandbox execution was cancelled.', 499);
    throw safeFailure(error, configuration.authKey.toString('base64'));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  demand(Number.isSafeInteger(transportResponse.status) && transportResponse.status >= 100 && transportResponse.status <= 599,
    'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox returned an invalid HTTP status.', 503);
  const parsed = parseJson(transportResponse.body);
  const responseKeys = ['protocol', 'version', 'operation', 'nonce', 'request_sha256', 'at', 'payload', 'error_code', 'signature'];
  demand(exact(parsed, responseKeys), 'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox response envelope has unexpected fields.', 503);
  const response = parsed as unknown as ResponseEnvelope;
  const {signature: candidate, ...unsigned} = response;
  const receivedAt = dependencies.clock().getTime(), responseAt = typeof response.at === 'string' ? Date.parse(response.at) : NaN;
  demand(response.protocol === PROTOCOL && response.version === 1 && response.operation === operation && response.nonce === request.nonce && response.request_sha256 === requestSha256 && finiteText(response.at, 100) && Number.isFinite(receivedAt) && Number.isFinite(responseAt) && responseAt >= receivedAt - 60_000 && responseAt <= receivedAt + 60_000 && signatureMatches(unsigned, candidate, configuration.authKey),
    'RUNNER_REMOTE_RESPONSE_AUTHENTICATION_FAILED', 'Remote sandbox response authentication or request binding failed.', 503);
  const succeeded = transportResponse.status >= 200 && transportResponse.status < 300;
  if (!succeeded || response.error_code !== null) {
    demand(response.payload === null && typeof response.error_code === 'string' && ERROR_CODE.test(response.error_code),
      'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox error response is invalid.', 503);
    throw new DomainError(response.error_code === 'EXECUTION_CONFLICT' ? 'RUNNER_SANDBOX_EXECUTION_CONFLICT' : 'RUNNER_REMOTE_REJECTED',
      response.error_code === 'EXECUTION_CONFLICT' ? 'Runner execution key is already bound to different immutable input.' : 'The remote sandbox rejected the requested operation.', response.error_code === 'EXECUTION_CONFLICT' ? 409 : 503);
  }
  demand(response.error_code === null, 'RUNNER_REMOTE_RESPONSE_INVALID', 'Remote sandbox success response contains an error.', 503);
  return parseState(response.payload, request, configuration);
}

/**
 * Creates a provider-neutral adapter for a separately operated hardened sandbox
 * service. The service contract is one authenticated HTTPS RPC endpoint; no
 * vendor SDK, control-plane credential or mutable URL is used by this adapter.
 */
export function createRemoteSandboxProvider(
  configuration: RemoteSandboxConfiguration,
  dependencies: RemoteSandboxDependencies = {},
): HardenedSandboxProvider {
  const config = normalize(configuration);
  const deps = {
    transport: dependencies.transport ?? defaultTransport,
    clock: dependencies.clock ?? (() => new Date()),
    nonce: dependencies.nonce ?? randomUUID,
  };
  const metadata: HardenedSandboxProviderMetadata = Object.freeze({
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    provider_id: config.providerId,
    provider_version: config.providerVersion,
    configuration_digest: config.configurationDigest,
    isolation: 'hardened_vm',
    cleanup_verification: true,
    crash_reconciliation: true,
  });
  const bindings = new Map<string, Binding>();

  return Object.freeze({
    metadata,
    configured: true,
    reason: null,
    async execute(input: HardenedSandboxExecutionInput): Promise<HardenedSandboxExecution> {
      validateInput(input);
      const existing = bindings.get(input.executionKey);
      if (existing) {
        demand(existing.taskSha256 === input.taskSha256 && existing.programSha256 === input.programSha256,
          'RUNNER_SANDBOX_EXECUTION_CONFLICT', 'Runner execution key is already bound to different immutable input.', 409);
        if (existing.execution) return structuredClone(existing.execution);
        if (existing.pending) return existing.pending;
      } else {
        demand(bindings.size < MAX_EXECUTION_KEYS, 'RUNNER_SANDBOX_CAPACITY_EXCEEDED', 'Runner execution key capacity is exhausted.', 503);
        bindings.set(input.executionKey, {taskSha256: input.taskSha256, programSha256: input.programSha256});
      }
      const binding = bindings.get(input.executionKey)!;
      const timeoutMs = Math.min(config.requestTimeoutMs, input.timeoutSeconds * 1000 + CONTROL_REQUEST_TIMEOUT_MS);
      const pending = invoke('execute', input.executionKey, input.taskSha256, input.programSha256, {
        task_json: input.taskJson,
        program_base64: Buffer.from(input.programBytes).toString('base64'),
        timeout_seconds: input.timeoutSeconds,
      }, timeoutMs, input.signal, config, deps).then(state => {
        demand(state.status === 'completed', state.status === 'running' ? 'RUNNER_SANDBOX_EXECUTION_IN_PROGRESS' : 'RUNNER_SANDBOX_CLEANUP_UNKNOWN',
          state.status === 'running' ? 'Remote sandbox execution is still running.' : 'Remote sandbox execution did not finish with verified cleanup.', state.status === 'running' ? 409 : 503);
        const execution = executionFrom(state);
        binding.execution = execution;
        return structuredClone(execution);
      }).finally(() => { binding.pending = undefined; });
      binding.pending = pending;
      return pending;
    },
    async inspect(executionKey: string): Promise<HardenedSandboxInspection> {
      validateExecutionKey(executionKey);
      const binding = bindings.get(executionKey);
      const state = await invoke('inspect', executionKey, binding?.taskSha256 ?? null, binding?.programSha256 ?? null, null,
        Math.min(config.requestTimeoutMs, CONTROL_REQUEST_TIMEOUT_MS), undefined, config, deps);
      if (state.status === 'completed') {
        const execution = executionFrom(state);
        if (binding) binding.execution = execution;
        else {
          demand(bindings.size < MAX_EXECUTION_KEYS, 'RUNNER_SANDBOX_CAPACITY_EXCEEDED', 'Runner execution key capacity is exhausted.', 503);
          bindings.set(executionKey, {taskSha256: execution.taskSha256, programSha256: execution.programSha256, execution});
        }
        return {status: 'completed', cleanup_verified: true, execution: structuredClone(execution)};
      }
      if ((state.status === 'destroyed' || state.status === 'cancelled') && state.cleanup_verified) return {status: 'destroyed', cleanup_verified: true};
      if (state.status === 'running') return {status: 'running', cleanup_verified: false};
      return {status: 'unknown', cleanup_verified: false};
    },
    async cancel(executionKey: string): Promise<HardenedSandboxCancellation> {
      validateExecutionKey(executionKey);
      const binding = bindings.get(executionKey);
      const state = await invoke('cancel', executionKey, binding?.taskSha256 ?? null, binding?.programSha256 ?? null, null,
        Math.min(config.requestTimeoutMs, CONTROL_REQUEST_TIMEOUT_MS), undefined, config, deps);
      if (state.status === 'completed' && state.cleanup_verified) return {status: 'destroyed', cleanup_verified: true};
      if ((state.status === 'destroyed' || state.status === 'cancelled') && state.cleanup_verified) return {status: state.status, cleanup_verified: true};
      return {status: 'unknown', cleanup_verified: false};
    },
  });
}

