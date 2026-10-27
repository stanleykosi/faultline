import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import Fastify from 'fastify';
import {canonical, hash} from '../../../packages/core/src/canonical.js';
import {DomainError, demand} from '../../../packages/core/src/errors.js';
import {publicAddress} from '../../../packages/core/src/network/http.js';
import {validateContract} from '../../../packages/contracts/src/validate.js';
import type {FaultlineObservation} from '../../../packages/contracts/src/generated.js';
import {validateExternalTask, type ExternalTaskInput, type ExternalTaskResult} from './external-task.js';
import {createRailwaySandboxProvider} from './railway-sandbox.js';
import {createRemoteSandboxProvider} from './remote-sandbox.js';
import type {HardenedSandboxExecution, HardenedSandboxProvider, HardenedSandboxProviderMetadata} from './sandbox-provider.js';
import {FileRunnerNonceStore, MemoryRunnerNonceStore, type RunnerNonceStore} from './nonce-store.js';
import {FileRunnerExecutionLedger, MemoryRunnerExecutionLedger, type ExecutionLedgerRecord, type RunnerExecutionLedger} from './execution-ledger.js';

const PROTOCOL = 'faultline-hardened-runner-v1';
const PROBE_PATH = '/v1/probe';
const EXECUTE_PATH = '/v1/tasks/execute';
const STATUS_PATH = '/v1/tasks/status';
const CANCEL_PATH = '/v1/tasks/cancel';
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const EXECUTION_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_PROGRAM_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const exact = (value: unknown, keys: readonly string[]) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const finiteText = (value: unknown, maximum = 200) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

export interface ExternalRunnerDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  provider?: HardenedSandboxProvider;
  nonceStore?: RunnerNonceStore;
  executionLedger?: RunnerExecutionLedger;
  durableStores?: boolean;
  capabilityProgram?: Uint8Array;
  externalProgram?: Uint8Array;
  implementationDigest?: string;
  resolveAddresses?: (origin: string) => Promise<string[]>;
  clock?: () => Date;
}

function publicMetadata(provider: HardenedSandboxProvider): Pick<HardenedSandboxProviderMetadata, 'adapter_id' | 'adapter_version' | 'provider_id' | 'provider_version'> & {provider_configuration_hash: string} {
  return {
    adapter_id: provider.metadata.adapter_id,
    adapter_version: provider.metadata.adapter_version,
    provider_id: provider.metadata.provider_id,
    provider_version: provider.metadata.provider_version,
    provider_configuration_hash: provider.metadata.configuration_digest,
  };
}

function recoveryTask(task: ExternalTaskInput): ExternalTaskInput {
  const copy = structuredClone(task);
  copy.value_refs = Object.fromEntries(Object.entries(copy.value_refs).map(([key, value]) => [key, `sha256:${sha256(value)}`]));
  return copy;
}

function storedRecoveryTask(value: unknown): ExternalTaskInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as ExternalTaskInput;
  const expiries = [candidate.task?.expires_at, candidate.approval?.expires_at, candidate.grant?.expires_at].map(item => typeof item === 'string' ? Date.parse(item) : NaN).filter(Number.isFinite);
  if (expiries.length !== 3) return null;
  try { return validateExternalTask(structuredClone(candidate), new Date(Math.min(...expiries) - 1)); }
  catch { return null; }
}

function secret(environment: Readonly<Record<string, string | undefined>>): Buffer | null {
  const value = environment.EXTERNAL_RUNNER_AUTH_KEY_B64;
  if (value === undefined) return null;
  demand(/^[A-Za-z0-9+/]{43}=$/.test(value), 'RUNNER_AUTH_KEY_UNAVAILABLE', 'Configure a canonical 256-bit runner controller key.', 503);
  const bytes = Buffer.from(value, 'base64');
  demand(bytes.length === 32 && bytes.toString('base64') === value, 'RUNNER_AUTH_KEY_UNAVAILABLE', 'Configure a canonical 256-bit runner controller key.', 503);
  return bytes;
}

function signature(value: unknown, key: Buffer) {
  return createHmac('sha256', key).update(canonical(value)).digest('hex');
}

function signatureMatches(value: unknown, candidate: unknown, key: Buffer) {
  return typeof candidate === 'string' && DIGEST.test(candidate) && timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(signature(value, key), 'hex'));
}

function responseEnvelope(nonce: string, payload: unknown, errorCode: string | null, key: Buffer, at: Date) {
  const body = {version: 1 as const, nonce, at: at.toISOString(), ok: errorCode === null, payload, error_code: errorCode};
  return {...body, signature: signature(body, key)};
}

async function regular(file: string, maximum = MAX_PROGRAM_BYTES) {
  const resolved = path.resolve(file), stat = await fs.lstat(resolved);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum, 'RUNNER_PROGRAM_UNAVAILABLE', 'Pinned runner program is unavailable.', 503);
  return new Uint8Array(await fs.readFile(resolved));
}

function selectProvider(environment: Readonly<Record<string, string | undefined>>, injected?: HardenedSandboxProvider): HardenedSandboxProvider | null {
  if (injected) return injected;
  const selected = environment.RUNNER_PROVIDER ?? (environment.REMOTE_SANDBOX_ENDPOINT ? 'remote' : environment.RAILWAY_ENVIRONMENT_ID || environment.RUNNER_SANDBOX_CHECKPOINT ? 'railway' : '');
  if (selected === '') return null;
  if (selected === 'railway') return createRailwaySandboxProvider(environment);
  if (selected === 'remote') {
    const endpoint = environment.REMOTE_SANDBOX_ENDPOINT, authKeyBase64 = environment.REMOTE_SANDBOX_AUTH_KEY_B64,
      providerId = environment.REMOTE_SANDBOX_PROVIDER_ID, providerVersion = environment.REMOTE_SANDBOX_PROVIDER_VERSION,
      isolationConfigurationHash = environment.REMOTE_SANDBOX_ISOLATION_CONFIGURATION_HASH,
      timeoutRaw = environment.REMOTE_SANDBOX_REQUEST_TIMEOUT_MS;
    demand(endpoint && authKeyBase64 && providerId && providerVersion && isolationConfigurationHash,
      'RUNNER_REMOTE_CONFIGURATION_INVALID', 'Configure the remote sandbox endpoint, authentication key, provider identity, version and isolation hash.', 503);
    const requestTimeoutMs = timeoutRaw === undefined || timeoutRaw === '' ? undefined : Number(timeoutRaw);
    return createRemoteSandboxProvider({endpoint, authKeyBase64, providerId, providerVersion, isolationConfigurationHash, requestTimeoutMs});
  }
  throw new DomainError('RUNNER_PROVIDER_UNAVAILABLE', 'The selected hardened sandbox provider adapter is unavailable.', 503);
}

async function controllerIdentity(capabilityProgram: Uint8Array, externalProgram: Uint8Array, provider: HardenedSandboxProvider | null) {
  const current = fileURLToPath(import.meta.url), extension = path.extname(current), directory = path.dirname(current);
  const files = [
    current,
    path.join(directory, `sandbox-provider${extension}`), path.join(directory, `nonce-store${extension}`), path.join(directory, `execution-ledger${extension}`), path.join(directory, `external-task${extension}`),
    path.resolve(directory, `../../../packages/core/src/canonical${extension}`), path.resolve(directory, `../../../packages/core/src/errors${extension}`), path.resolve(directory, `../../../packages/core/src/imports/duplicate-json-keys${extension}`), path.resolve(directory, `../../../packages/core/src/network/http${extension}`), path.resolve(directory, `../../../packages/core/src/targets/validation${extension}`),
    path.resolve(directory, `../../../packages/contracts/src/validate${extension}`), path.resolve(directory, `../../../packages/contracts/src/generated${extension}`),
  ];
  if (provider?.metadata.adapter_id === 'faultline.hardened-sandbox.railway') files.push(path.join(directory, `railway-sandbox${extension}`));
  if (provider?.metadata.adapter_id === 'faultline.hardened-sandbox.remote') files.push(path.join(directory, `remote-sandbox${extension}`));
  const controllerFiles: Record<string, string> = {};
  for (const file of files) controllerFiles[path.basename(file)] = sha256(await regular(file));
  return hash({
    protocol: PROTOCOL,
    controller_files: controllerFiles,
    capability_program_sha256: sha256(capabilityProgram),
    execution_program_sha256: sha256(externalProgram),
    provider: provider?.metadata ?? null,
    playwright: '1.56.1',
    node: process.versions.node,
  });
}

async function defaultStores(environment: Readonly<Record<string, string | undefined>>, dependencies: ExternalRunnerDependencies) {
  if (dependencies.nonceStore || dependencies.executionLedger) {
    demand(Boolean(dependencies.nonceStore && dependencies.executionLedger), 'RUNNER_STORE_CONFIGURATION_INVALID', 'Nonce and execution stores must be supplied together.', 503);
    return {nonceStore: dependencies.nonceStore!, executionLedger: dependencies.executionLedger!, durable: dependencies.durableStores === true};
  }
  const noncePath = environment.RUNNER_NONCE_STORE_PATH, ledgerPath = environment.RUNNER_EXECUTION_LEDGER_PATH;
  demand(Boolean(noncePath) === Boolean(ledgerPath), 'RUNNER_STORE_CONFIGURATION_INVALID', 'Durable nonce and execution ledger paths must be configured together.', 503);
  if (noncePath && ledgerPath) return {nonceStore: await FileRunnerNonceStore.open(noncePath), executionLedger: await FileRunnerExecutionLedger.open(ledgerPath), durable: true};
  return {nonceStore: new MemoryRunnerNonceStore(), executionLedger: new MemoryRunnerExecutionLedger(), durable: false};
}

async function authenticate(value: unknown, route: string, key: Buffer, store: RunnerNonceStore, now: Date) {
  demand(exact(value, ['version', 'nonce', 'expires_at', 'payload', 'signature']), 'RUNNER_AUTHENTICATION_FAILED', 'Malformed runner request.', 403);
  const request = value as {version: unknown; nonce: unknown; expires_at: unknown; payload: unknown; signature: unknown};
  const expiry = typeof request.expires_at === 'string' ? Date.parse(request.expires_at) : NaN;
  demand(request.version === 1 && typeof request.nonce === 'string' && UUID.test(request.nonce) && Number.isFinite(expiry) && expiry > now.getTime() && expiry <= now.getTime() + 31_000 && signatureMatches({method: 'POST', path: route, version: request.version, nonce: request.nonce, expires_at: request.expires_at, payload: request.payload}, request.signature, key), 'RUNNER_AUTHENTICATION_FAILED', 'Expired, replayed or unauthenticated runner request.', 403);
  demand(await store.consume(request.nonce, request.expires_at as string), 'RUNNER_AUTHENTICATION_FAILED', 'Expired, replayed or unauthenticated runner request.', 403);
  return {nonce: request.nonce, payload: request.payload};
}

async function resolvePublicAddresses(origin: string) {
  const parsed = new URL(origin);
  demand(parsed.origin === origin && parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'RUNNER_PROBE_ORIGIN_INVALID', 'Probe origin must be an exact HTTPS origin.', 503);
  const values = await dns.lookup(parsed.hostname, {all: true, verbatim: true});
  const unique = [...new Set(values.map(item => item.address))];
  demand(unique.length > 0 && unique.length <= 16 && unique.every(publicAddress), 'RUNNER_PROBE_DNS_UNAVAILABLE', 'Probe origin must resolve to a finite public address set.', 503);
  return unique;
}

function validProbe(value: unknown, providerScope: string, origin: string, nonce: string) {
  if (!exact(value, ['version', 'kind', 'nonce', 'provider_scope', 'approved_origin', 'approved_addresses', 'private_network_denied', 'firewall_default_deny', 'approved_https', 'unrelated_public_denied', 'loopback_denied', 'metadata_denied', 'private_address_denied', 'privilege_dropped', 'browser_version', 'before'])) return false;
  const probe = value as Record<string, any>, before = probe.before;
  return probe.version === 1 && probe.kind === 'hardened_isolation_probe' && probe.nonce === nonce && probe.provider_scope === providerScope && probe.approved_origin === origin && Array.isArray(probe.approved_addresses) && probe.approved_addresses.every((item: unknown) => finiteText(item, 100)) && probe.private_network_denied === true && probe.firewall_default_deny === true && probe.approved_https === true && probe.unrelated_public_denied === true && probe.loopback_denied === true && probe.metadata_denied === true && probe.private_address_denied === true && probe.privilege_dropped === true && finiteText(probe.browser_version, 200) && before !== null && typeof before === 'object' && !Array.isArray(before) && finiteText(before.boot_id, 200) && finiteText(before.network_ns, 200) && before.docker_socket_present === false && before.control_plane_credential_present === false;
}

function valueGuards(task: ExternalTaskInput) {
  const plaintext: string[] = [], digests = new Set<string>();
  for (const value of Object.values(task.value_refs)) {
    const stored = /^sha256:([a-f0-9]{64})$/.exec(value);
    if (stored) digests.add(stored[1]!);
    else {plaintext.push(value); digests.add(sha256(value));}
  }
  return {plaintext, digests};
}

function rejectSecretFields(value: unknown, guards: ReturnType<typeof valueGuards>, pathName = 'result'): void {
  if (typeof value === 'string') {
    demand(!guards.digests.has(sha256(value)) && guards.plaintext.every(secret => secret.length === 0 || !value.includes(secret)), 'RUNNER_RESULT_UNSAFE', `Runner result contains protected task material at ${pathName}.`, 503);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => rejectSecretFields(item, guards, `${pathName}[${index}]`)); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    demand(!/(?:secret|password|authorization|cookie|credential|value_refs)/i.test(key), 'RUNNER_RESULT_UNSAFE', `Runner result contains a forbidden field at ${pathName}.`, 503);
    rejectSecretFields(item, guards, `${pathName}.${key}`);
  }
}

function admitExternalResult(value: unknown, task: ExternalTaskInput): ExternalTaskResult {
  const keys = ['version', 'scope', 'mode', 'verification_limit_reason', 'runner_id', 'job_id', 'lease_id', 'nonce', 'plan_hash', 'observation_profile_hash', 'network_profile_hash', 'started_at', 'finished_at', 'engine', 'observations', 'attempts'];
  demand(exact(value, keys), 'RUNNER_RESULT_INVALID', 'External runner result contains missing or unsupported fields.', 503);
  rejectSecretFields(value, valueGuards(task));
  const result = value as ExternalTaskResult;
  demand(result.version === 1 && result.scope === 'external_staging' && result.mode === 'exploratory' && result.verification_limit_reason === 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', 'RUNNER_RESULT_INVALID', 'External results must retain their verification limit.', 503);
  demand(result.runner_id === task.task.runner_id && result.job_id === task.task.job_id && result.lease_id === task.task.lease_id && result.nonce === task.task.nonce && result.plan_hash === task.task.plan_hash && result.observation_profile_hash === task.task.observation_profile_hash && result.network_profile_hash === task.task.network_profile_hash, 'RUNNER_RESULT_BINDING_MISMATCH', 'External result does not bind the immutable task.', 503);
  const startedAt=Date.parse(result.started_at),finishedAt=Date.parse(result.finished_at);
  demand(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt && finishedAt-startedAt <= 660_000 && exact(result.engine, ['name','version']) && result.engine.name === 'chromium' && typeof result.engine.version === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(result.engine.version), 'RUNNER_RESULT_INVALID', 'External result timing or engine metadata is invalid.', 503);
  const expected = task.deployments.length * task.plan.cohorts.length * task.plan.repeats;
  demand(Array.isArray(result.observations) && Array.isArray(result.attempts) && result.observations.length === expected && result.attempts.length === expected, 'RUNNER_RESULT_INCOMPLETE', 'External result does not contain the complete finite matrix.', 503);
  const attemptIds=new Set<string>(),deniedCodes=new Set(['ORIGIN_DENIED','PATH_DENIED','WEBSOCKET_DENIED','POPUP_DENIED','DOWNLOAD_DENIED']);
  for (let index = 0; index < expected; index++) {
    const observation = validateContract<FaultlineObservation>('observation', result.observations[index]);
    const attempt = result.attempts[index]!;
    const attemptStarted=Date.parse(attempt.started_at),attemptFinished=Date.parse(attempt.finished_at),deployment=task.deployments.find(item=>item.arm===attempt.arm);
    demand(exact(attempt, ['attempt_id', 'arm', 'cohort', 'repeat', 'status', 'started_at', 'finished_at', 'observation_hash', 'ui_completed', 'receipt_completed', 'network_request_count', 'denied_requests', 'errors', 'deployment']) && /^[A-Za-z0-9_-]{16,128}$/.test(attempt.attempt_id) && !attemptIds.has(attempt.attempt_id) && Number.isFinite(attemptStarted) && Number.isFinite(attemptFinished) && attemptStarted>=startedAt && attemptFinished>=attemptStarted && attemptFinished<=finishedAt && (attempt.ui_completed===null||typeof attempt.ui_completed==='boolean') && (attempt.receipt_completed===null||typeof attempt.receipt_completed==='boolean') && Number.isSafeInteger(attempt.network_request_count) && attempt.network_request_count>=0 && attempt.network_request_count<=100_000 && Array.isArray(attempt.denied_requests) && attempt.denied_requests.length<=30 && attempt.denied_requests.every(item=>exact(item,['code','origin','path'])&&deniedCodes.has(item.code)&&item.origin===null&&item.path===null) && Array.isArray(attempt.errors) && attempt.errors.length<=30 && attempt.errors.every(item=>typeof item==='string'&&/^(?:[A-Z][A-Z0-9_]{0,127}|BROWSER_(?:TIMEOUT|EXECUTION_FAILED):(?:context|navigate|click|fill|wait_for|receipt))$/.test(item)) && deployment!==undefined && canonical(attempt.deployment)===canonical(deployment) && attempt.observation_hash === hash(observation) && attempt.arm === observation.arm && attempt.cohort === observation.cohort && attempt.repeat === observation.repeat && attempt.status === observation.status && (observation.actual===null||observation.actual.error_code===null||observation.actual.error_code===task.observation_profile.incident_error_code||observation.actual.error_code==='UNEXPECTED_ERROR_CODE'), 'RUNNER_RESULT_BINDING_MISMATCH', 'External attempt evidence does not bind its observation.', 503);
    attemptIds.add(attempt.attempt_id);
  }
  return structuredClone(result);
}

function completedPayload(record: Extract<ExecutionLedgerRecord, {status: 'completed'}>, provider: HardenedSandboxProvider, implementationDigest: string, isolationConfigurationHash: string) {
  return {
    version: 1 as const,
    status: 'completed' as const,
    ...publicMetadata(provider),
    implementation_digest: implementationDigest,
    isolation_configuration_hash: isolationConfigurationHash,
    execution_id: record.execution.executionId,
    task_sha256: record.execution.taskSha256,
    program_sha256: record.execution.programSha256,
    result_sha256: record.execution.resultSha256,
    result: record.execution.result,
  };
}

function statusPayload(record: ExecutionLedgerRecord, provider: HardenedSandboxProvider, implementationDigest: string, isolationConfigurationHash: string) {
  if (record.status === 'completed') return completedPayload(record, provider, implementationDigest, isolationConfigurationHash);
  return {version: 1 as const, status: record.status, ...publicMetadata(provider), implementation_digest: implementationDigest, isolation_configuration_hash: isolationConfigurationHash, execution_key: record.execution_key, task_sha256: record.task_sha256, updated_at: record.updated_at};
}

export async function buildExternalRunner(dependencies: ExternalRunnerDependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const clock = dependencies.clock ?? (() => new Date());
  const capabilityProgram = dependencies.capabilityProgram ?? await regular(environment.RUNNER_CAPABILITY_PROGRAM_PATH ?? 'dist/runner/capability-program.mjs');
  const externalProgram = dependencies.externalProgram ?? await regular(environment.RUNNER_PROGRAM_PATH ?? 'dist/runner/external-program.mjs');
  const capabilityProgramSha256 = sha256(capabilityProgram), executionProgramSha256 = sha256(externalProgram);
  const provider = selectProvider(environment, dependencies.provider);
  const stores = await defaultStores(environment, dependencies);
  const authKey = secret(environment);
  const providerScope = environment.RUNNER_PROVIDER_SCOPE ?? environment.RAILWAY_ENVIRONMENT_ID ?? '';
  const probeOrigin = environment.RUNNER_PROBE_ORIGIN ?? '';
  const privateProbeHost = environment.RUNNER_PRIVATE_PROBE_HOST ?? 'faultline-app.internal';
  const isolationConfigurationHash = hash({provider: provider?.metadata ?? null, provider_scope: providerScope, probe_origin: probeOrigin, private_probe_host: privateProbeHost});
  const implementationDigest = dependencies.implementationDigest ?? await controllerIdentity(capabilityProgram, externalProgram, provider);
  demand(DIGEST.test(implementationDigest), 'RUNNER_IMPLEMENTATION_INVALID', 'Runner implementation digest is invalid.', 503);
  const configured = Boolean(authKey && provider?.configured);
  const probeEnabled = Boolean(configured && providerScope && probeOrigin && privateProbeHost && provider?.metadata.cleanup_verification);
  const executionConfigured = Boolean(configured && stores.durable && provider?.metadata.cleanup_verification && provider.metadata.crash_reconciliation);
  let lastSuccessfulProbeAt: number | null = null;
  let reconciliationReady = true;
  const executionEnabled = () => executionConfigured && reconciliationReady && lastSuccessfulProbeAt !== null && clock().getTime() - lastSuccessfulProbeAt >= 0 && clock().getTime() - lastSuccessfulProbeAt <= 300_000;
  const active = new Map<string, AbortController>();
  const app = Fastify({logger: false, bodyLimit: MAX_REQUEST_BYTES, requestTimeout: 700_000});

  async function reconcileRecord(record: ExecutionLedgerRecord): Promise<ExecutionLedgerRecord> {
    if (!provider || ['completed','cancelled','containment_unknown'].includes(record.status)) return record;
    if (record.status === 'reserved') {
      return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['reserved'], {status: 'cancelled', updated_at: clock().toISOString(), recovery_task: null, execution: null})).record;
    }
    const inspected = await provider.inspect(record.execution_key).catch(() => ({status: 'unknown' as const, cleanup_verified: false}));
    if (record.status === 'cancel_requested') {
      if (inspected.status === 'completed' && inspected.cleanup_verified) {
        return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['cancel_requested'], {status: 'cancelled', updated_at: clock().toISOString(), recovery_task: null, execution: null})).record;
      }
      if (inspected.status === 'running' || inspected.status === 'unknown') {
        const cancelled = await provider.cancel(record.execution_key).catch(() => ({status: 'unknown' as const, cleanup_verified: false}));
        const status = cancelled.cleanup_verified && ['cancelled','destroyed'].includes(cancelled.status) ? 'cancelled' : 'containment_unknown';
        return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['cancel_requested'], {status, updated_at: clock().toISOString(), recovery_task: null, execution: null})).record;
      }
      const status = inspected.status === 'destroyed' && inspected.cleanup_verified ? 'cancelled' : 'containment_unknown';
      return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['cancel_requested'], {status, updated_at: clock().toISOString(), recovery_task: null, execution: null})).record;
    }
    if (inspected.status === 'completed' && inspected.cleanup_verified) {
      const task = storedRecoveryTask(record.recovery_task);
      if (!task) return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['running'], {status: 'containment_unknown', updated_at: clock().toISOString(), recovery_task: null, execution: null})).record;
      const result = admitExternalResult(inspected.execution.result, task), execution = {...inspected.execution, result};
      demand(execution.taskSha256 === record.task_sha256 && execution.programSha256 === executionProgramSha256 && execution.resultSha256 === sha256(canonical(result)), 'RUNNER_RESULT_BINDING_MISMATCH', 'Recovered execution does not bind the admitted task and program.', 503);
      return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['running'], {status: 'completed', updated_at: clock().toISOString(), recovery_task: null, execution})).record;
    }
    if (inspected.status === 'destroyed' && inspected.cleanup_verified) return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['running'], {status: 'cancelled', updated_at: clock().toISOString(), recovery_task: null, execution: null})).record;
    if (inspected.status === 'unknown') return (await stores.executionLedger.transition(record.execution_key, record.task_sha256, ['running'], {status: 'containment_unknown', updated_at: clock().toISOString(), recovery_task: null, execution: null})).record;
    return record;
  }

  if (executionConfigured) {
    const pending = await stores.executionLedger.listNonterminal();
    reconciliationReady = pending.length === 0;
    if (pending.length) {
      for (const record of pending) await reconcileRecord(record);
      reconciliationReady = (await stores.executionLedger.listNonterminal()).length === 0;
    }
  }

  app.get('/health/live', async () => ({status: 'live'}));
  app.get('/health/ready', async () => ({
    status: 'ready', configured, probe_enabled: probeEnabled, execution_configured: executionConfigured, execution_enabled: executionEnabled(), protocol: PROTOCOL,
    implementation_digest: implementationDigest, isolation_configuration_hash: isolationConfigurationHash,
    capability_program_sha256: capabilityProgramSha256, execution_program_sha256: executionProgramSha256,
    provider: provider ? {...publicMetadata(provider), isolation: provider.metadata.isolation, cleanup_verification: provider.metadata.cleanup_verification, crash_reconciliation: provider.metadata.crash_reconciliation, configured: provider.configured, reason: provider.reason} : null,
    reconciliation_ready: reconciliationReady,
    durable_nonce_store: stores.durable, durable_execution_ledger: stores.durable,
  }));

  async function routeRequest(request: {body: unknown}, reply: any, route: string, handler: (payload: unknown, nonce: string, now: Date) => Promise<unknown>) {
    let nonce = '00000000-0000-0000-0000-000000000000';
    try {
      demand(authKey, 'RUNNER_NOT_CONFIGURED', 'Runner authentication is not configured.', 503);
      const now = clock(), authenticated = await authenticate(request.body, route, authKey, stores.nonceStore, now);
      nonce = authenticated.nonce;
      const payload = await handler(authenticated.payload, nonce, now);
      return responseEnvelope(nonce, payload, null, authKey, clock());
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError('RUNNER_REQUEST_FAILED', 'Runner request failed safely.', 503);
      reply.code(domain.status);
      return authKey ? responseEnvelope(nonce, null, domain.code, authKey, clock()) : {version: 1, nonce, at: clock().toISOString(), ok: false, payload: null, error_code: domain.code, signature: null};
    }
  }

  app.post(PROBE_PATH, async (request, reply) => routeRequest(request, reply, PROBE_PATH, async (value, _nonce, now) => {
    demand(probeEnabled && provider, 'RUNNER_PROBE_NOT_CONFIGURED', 'Runner capability probe is not configured.', 503);
    demand(exact(value, ['profile_hash', 'network_hash', 'implementation_digest']), 'RUNNER_PROBE_INVALID', 'Probe must bind the exact registered profiles and implementation.', 400);
    const payload = value as Record<string, unknown>;
    demand([payload.profile_hash, payload.network_hash, payload.implementation_digest].every(item => typeof item === 'string' && DIGEST.test(item)) && payload.implementation_digest === implementationDigest, 'RUNNER_IMPLEMENTATION_MISMATCH', 'Probe requested another controller implementation.', 409);
    const approvedAddresses = await (dependencies.resolveAddresses ?? resolvePublicAddresses)(probeOrigin);
    demand(Array.isArray(approvedAddresses) && approvedAddresses.length > 0 && approvedAddresses.length <= 16 && new Set(approvedAddresses).size === approvedAddresses.length && approvedAddresses.every(publicAddress), 'RUNNER_PROBE_DNS_UNAVAILABLE', 'Probe origin must resolve to a finite public address set.', 503);
    const runs: Array<{execution_id: string; result_sha256: string; evidence: Record<string, unknown>}> = [];
    for (let index = 0; index < 2; index++) {
      const taskNonce = randomUUID(), task = {version: 1, nonce: taskNonce, expires_at: new Date(now.getTime() + 120_000).toISOString(), provider_scope: providerScope, approved_origin: probeOrigin, approved_addresses: approvedAddresses, private_probe_host: privateProbeHost};
      const taskJson = canonical(task), taskSha256 = sha256(taskJson);
      const result = await provider.execute({executionKey: taskNonce, taskJson, taskSha256, programBytes: capabilityProgram, programSha256: capabilityProgramSha256, timeoutSeconds: 90});
      demand(result.taskSha256 === taskSha256 && result.programSha256 === capabilityProgramSha256 && result.resultSha256 === sha256(canonical(result.result)) && validProbe(result.result, providerScope, probeOrigin, taskNonce), 'RUNNER_CAPABILITY_FAILED', 'Sandbox isolation evidence did not pass every required check.', 503);
      runs.push({execution_id: result.executionId, result_sha256: result.resultSha256, evidence: result.result as Record<string, unknown>});
    }
    demand(runs[0]!.execution_id !== runs[1]!.execution_id && (runs[0]!.evidence.before as any).boot_id !== (runs[1]!.evidence.before as any).boot_id && (runs[0]!.evidence.before as any).network_ns !== (runs[1]!.evidence.before as any).network_ns, 'RUNNER_ISOLATION_NOT_DISTINCT', 'Capability probe executions did not prove distinct VM and network identities.', 503);
    lastSuccessfulProbeAt = clock().getTime();
    return {version: 1, status: 'available', checked_at: clock().toISOString(), ...publicMetadata(provider), implementation_digest: implementationDigest, isolation_configuration_hash: isolationConfigurationHash, capability_program_sha256: capabilityProgramSha256, execution_program_sha256: executionProgramSha256, cleanup_verification: provider.metadata.cleanup_verification, crash_reconciliation: provider.metadata.crash_reconciliation, network_calls: 2, runs};
  }));

  app.post(EXECUTE_PATH, async (request, reply) => routeRequest(request, reply, EXECUTE_PATH, async value => {
    demand(executionEnabled() && provider, 'RUNNER_EXECUTION_NOT_CONFIGURED', 'Full external execution requires a fresh successful capability probe, durable replay storage, cleanup verification and crash reconciliation.', 503);
    demand(exact(value, ['implementation_digest', 'isolation_configuration_hash', 'task', 'task_sha256']), 'RUNNER_TASK_INVALID', 'Runner task request contains unsupported fields.', 400);
    const payload = value as Record<string, unknown>;
    demand(payload.implementation_digest === implementationDigest && payload.isolation_configuration_hash === isolationConfigurationHash && typeof payload.task_sha256 === 'string' && DIGEST.test(payload.task_sha256), 'RUNNER_TASK_BINDING_MISMATCH', 'Runner task requested another admitted implementation or isolation configuration.', 409);
    const taskJson = canonical(payload.task), taskSha256 = sha256(taskJson);
    demand(taskSha256 === payload.task_sha256, 'RUNNER_TASK_HASH_MISMATCH', 'Runner task hash does not bind its canonical task.', 409);
    const task = validateExternalTask(JSON.parse(taskJson), clock()) as ExternalTaskInput;
    const executionKey = task.task.nonce;
    demand(EXECUTION_KEY.test(executionKey), 'RUNNER_TASK_INVALID', 'Runner task execution key is invalid.', 400);
    const reservation = await stores.executionLedger.reserve(executionKey, taskSha256);
    if (!reservation.created) {
      if (reservation.record.status === 'completed') return completedPayload(reservation.record, provider, implementationDigest, isolationConfigurationHash);
      demand(!['cancel_requested', 'cancelled', 'containment_unknown'].includes(reservation.record.status), 'RUNNER_EXECUTION_UNAVAILABLE', 'Runner execution cannot be resumed safely.', 409);
      const reconciled = await reconcileRecord(reservation.record);
      if (reconciled.status === 'completed') return completedPayload(reconciled, provider, implementationDigest, isolationConfigurationHash);
      throw new DomainError(reconciled.status === 'running' ? 'RUNNER_EXECUTION_IN_PROGRESS' : reconciled.status === 'cancelled' ? 'RUNNER_EXECUTION_CANCELLED' : 'RUNNER_EXECUTION_CONTAINMENT_UNKNOWN', reconciled.status === 'running' ? 'Runner execution is already in progress.' : reconciled.status === 'cancelled' ? 'Runner execution was destroyed before publication.' : 'Runner execution containment cannot be established.', 409);
    }
    const running = await stores.executionLedger.transition(executionKey, taskSha256, ['reserved'], {status: 'running', updated_at: clock().toISOString(), recovery_task: recoveryTask(task), execution: null});
    demand(running.applied, 'RUNNER_EXECUTION_UNAVAILABLE', 'Runner execution reservation changed before start.', 409);
    const controller = new AbortController();
    active.set(executionKey, controller);
    try {
      const execution = await provider.execute({executionKey, taskJson, taskSha256, programBytes: externalProgram, programSha256: executionProgramSha256, timeoutSeconds: 600, signal: controller.signal});
      const result = admitExternalResult(execution.result, task);
      demand(execution.taskSha256 === taskSha256 && execution.programSha256 === executionProgramSha256 && execution.resultSha256 === sha256(canonical(result)), 'RUNNER_RESULT_BINDING_MISMATCH', 'Execution output does not bind the admitted task and program.', 503);
      const admitted: HardenedSandboxExecution = {...execution, result};
      const publication = await stores.executionLedger.transition(executionKey, taskSha256, ['running'], {status: 'completed', updated_at: clock().toISOString(), recovery_task: null, execution: admitted});
      demand(publication.applied && publication.record.status === 'completed', 'RUNNER_EXECUTION_CANCELLED', 'Cancelled execution cannot publish a late result.', 409);
      const completed = publication.record;
      return completedPayload(completed, provider, implementationDigest, isolationConfigurationHash);
    } catch (error) {
      const current = await stores.executionLedger.read(executionKey);
      if (current?.status === 'running') {
        const requested = await stores.executionLedger.transition(executionKey, taskSha256, ['running'], {status: 'cancel_requested', updated_at: clock().toISOString(), recovery_task: current.recovery_task, execution: null});
        if (requested.applied) {
          const cancellation = await provider.cancel(executionKey).catch(() => ({status: 'unknown' as const, cleanup_verified: false}));
          const status = cancellation.cleanup_verified && ['cancelled','destroyed'].includes(cancellation.status) ? 'cancelled' : 'containment_unknown';
          await stores.executionLedger.transition(executionKey, taskSha256, ['cancel_requested'], {status, updated_at: clock().toISOString(), recovery_task: null, execution: null});
        }
      }
      throw error;
    } finally {
      active.delete(executionKey);
    }
  }));

  async function executionCommand(value: unknown) {
    demand(provider && exact(value, ['implementation_digest', 'isolation_configuration_hash', 'execution_key', 'task_sha256']), 'RUNNER_TASK_INVALID', 'Runner execution command contains unsupported fields.', 400);
    const payload = value as Record<string, unknown>;
    demand(payload.implementation_digest === implementationDigest && payload.isolation_configuration_hash === isolationConfigurationHash && typeof payload.execution_key === 'string' && EXECUTION_KEY.test(payload.execution_key) && typeof payload.task_sha256 === 'string' && DIGEST.test(payload.task_sha256), 'RUNNER_TASK_BINDING_MISMATCH', 'Runner execution command does not bind the admitted implementation and task.', 409);
    const record = await stores.executionLedger.read(payload.execution_key);
    demand(record && record.task_sha256 === payload.task_sha256, 'RUNNER_EXECUTION_NOT_FOUND', 'Runner execution was not found.', 404);
    return {payload, record};
  }

  app.post(STATUS_PATH, async (request, reply) => routeRequest(request, reply, STATUS_PATH, async value => {
    const {record} = await executionCommand(value);
    const reconciled = ['reserved','running','cancel_requested'].includes(record.status) ? await reconcileRecord(record) : record;
    if (reconciliationReady === false) reconciliationReady = (await stores.executionLedger.listNonterminal()).length === 0;
    return statusPayload(reconciled, provider!, implementationDigest, isolationConfigurationHash);
  }));

  app.post(CANCEL_PATH, async (request, reply) => routeRequest(request, reply, CANCEL_PATH, async value => {
    const {payload, record} = await executionCommand(value);
    if (record.status === 'completed' || record.status === 'cancelled' || record.status === 'containment_unknown') return statusPayload(record, provider!, implementationDigest, isolationConfigurationHash);
    const executionKey = payload.execution_key as string;
    if (record.status === 'reserved') {
      const cancelled = await stores.executionLedger.transition(executionKey, record.task_sha256, ['reserved'], {status: 'cancelled', updated_at: clock().toISOString(), recovery_task: null, execution: null});
      return statusPayload(cancelled.record, provider!, implementationDigest, isolationConfigurationHash);
    }
    const requested = record.status==='cancel_requested'?{applied:true,record}:await stores.executionLedger.transition(executionKey, record.task_sha256, ['running'], {status: 'cancel_requested', updated_at: clock().toISOString(), recovery_task: record.recovery_task, execution: null});
    if (!requested.applied) return statusPayload(requested.record, provider!, implementationDigest, isolationConfigurationHash);
    active.get(executionKey)?.abort();
    const cancellation = await provider!.cancel(executionKey);
    const status = cancellation.cleanup_verified && ['cancelled', 'destroyed'].includes(cancellation.status) ? 'cancelled' : 'containment_unknown';
    const finalized = await stores.executionLedger.transition(executionKey, record.task_sha256, ['cancel_requested'], {status, updated_at: clock().toISOString(), recovery_task: null, execution: null});
    return statusPayload(finalized.record, provider!, implementationDigest, isolationConfigurationHash);
  }));

  const port = Number(environment.PORT ?? 3000);
  demand(Number.isSafeInteger(port) && port > 0 && port <= 65_535, 'RUNNER_PORT_INVALID', 'Runner port is invalid.', 503);
  return {app, port, host: '0.0.0.0', configured, probeEnabled, executionConfigured, executionEnabled, implementationDigest, isolationConfigurationHash, provider};
}

const launched = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (launched) {
  const runtime = await buildExternalRunner();
  await runtime.app.listen({port: runtime.port, host: runtime.host});
}
