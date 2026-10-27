import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import type {FaultlineApproval, FaultlineBrowserPlan, FaultlineObservation, FaultlineObservationProfile, FaultlineTargetGrant} from '../../../packages/contracts/src/generated.js';
import {validateContract} from '../../../packages/contracts/src/validate.js';
import {hash} from '../../../packages/core/src/canonical.js';
import {demand, DomainError} from '../../../packages/core/src/errors.js';
import {compileObservationProfile, readReceipt, receiptPath, type CompiledObservationProfile} from '../../../packages/core/src/targets/validation.js';

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const VIEWPORTS = Object.freeze({mobile: {width: 390, height: 844}, desktop: {width: 1280, height: 800}});
const MAX_TASK_MS = 600_000;
const MAX_VALUE_BYTES = 4096;
const MAX_ERRORS = 30;

type Arm = FaultlineObservation['arm'];
type Cohort = FaultlineObservation['cohort'];
type LocatorSpec = Extract<FaultlineBrowserPlan['actions'][number], {op: 'click'}>['locator'];

export interface ExternalNetworkProfile {
  version: 1;
  profile_hash: string;
  origins: string[];
  path_prefixes: string[];
  resolved_addresses: Record<string, string[]>;
  deny_private_addresses: true;
  max_response_bytes: number;
}

export interface ExternalDeploymentBinding {
  arm: Arm;
  deployment_id: string;
  attester_id: string;
  origin: string;
  build_digest: string;
  deployment_evidence_hash: string;
}

export interface ExternalRunnerTaskBinding {
  job_id: string;
  lease_id: string;
  nonce: string;
  expires_at: string;
  plan_hash: string;
  approval_hash: string;
  grant_hash: string;
  observation_profile_hash: string;
  network_profile_hash: string;
  runner_id: string;
}

export interface ExternalTaskInput {
  version: 1;
  plan: FaultlineBrowserPlan;
  approval: FaultlineApproval;
  grant: FaultlineTargetGrant;
  observation_profile: FaultlineObservationProfile;
  network_profile: ExternalNetworkProfile;
  deployments: ExternalDeploymentBinding[];
  value_refs: Record<string, string>;
  task: ExternalRunnerTaskBinding;
}

export interface RunnerLocator {
  click(options: {timeout: number}): Promise<void>;
  fill(value: string, options: {timeout: number}): Promise<void>;
  waitFor(options: {state: 'visible'; timeout: number}): Promise<void>;
  isVisible(options: {timeout: number}): Promise<boolean>;
}

export interface RunnerRequest {
  url(): string;
  method(): string;
}

export interface RunnerRoute {
  request(): RunnerRequest;
  continue(): Promise<void>;
  abort(reason: 'blockedbyclient'): Promise<void>;
}

export interface RunnerWebSocket {close(options?: {code?: number; reason?: string}): void;}

export interface RunnerPage {
  setDefaultTimeout(timeout: number): void;
  goto(url: string, options: {waitUntil: 'load'; timeout: number}): Promise<unknown>;
  url(): string;
  getByTestId(value: string): RunnerLocator;
  getByLabel(value: string): RunnerLocator;
  getByRole(role: NonNullable<LocatorSpec['role']>, options: {name: string; exact: true}): RunnerLocator;
  on(event: 'popup' | 'download', handler: (value: {close?(): Promise<void>}) => void): void;
}

export interface RunnerBrowserContext {
  route(pattern: '**/*', handler: (route: RunnerRoute) => Promise<void>): Promise<void>;
  routeWebSocket(pattern: '**/*', handler: (socket: RunnerWebSocket) => void): Promise<void>;
  newPage(): Promise<RunnerPage>;
  close(): Promise<void>;
}

export interface RunnerBrowser {
  newContext(options: {viewport: {width: number; height: number}; locale: 'en-US'; timezoneId: 'UTC'; serviceWorkers: 'block'; acceptDownloads: false}): Promise<RunnerBrowserContext>;
  version(): string;
  close(): Promise<void>;
}

export interface ExternalTaskDependencies {
  browserFactory(policy: {origins: readonly string[]; path_prefixes: readonly string[]; resolved_addresses: Readonly<Record<string, readonly string[]>>}): Promise<RunnerBrowser>;
  fetch(input: string, init: {method: 'GET'; redirect: 'error'; signal: AbortSignal; headers?: Record<string, string>}): Promise<Response>;
  clock(): Date;
  attemptId?: () => string;
  signal?: AbortSignal;
  action_timeout_ms?: number;
  receiptHeaders?: (credentialRef: string, credentialValue: string) => Promise<Record<string, string>> | Record<string, string>;
}

export interface ExternalAttemptEvidence {
  attempt_id: string;
  arm: Arm;
  cohort: Cohort;
  repeat: number;
  status: FaultlineObservation['status'];
  started_at: string;
  finished_at: string;
  observation_hash: string;
  ui_completed: boolean | null;
  receipt_completed: boolean | null;
  network_request_count: number;
  denied_requests: {code: 'ORIGIN_DENIED' | 'PATH_DENIED' | 'WEBSOCKET_DENIED' | 'POPUP_DENIED' | 'DOWNLOAD_DENIED'; origin: string | null; path: string | null}[];
  errors: string[];
  deployment: ExternalDeploymentBinding;
}

export interface ExternalTaskResult {
  version: 1;
  scope: 'external_staging';
  mode: 'exploratory';
  verification_limit_reason: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED';
  runner_id: string;
  job_id: string;
  lease_id: string;
  nonce: string;
  plan_hash: string;
  observation_profile_hash: string;
  network_profile_hash: string;
  started_at: string;
  finished_at: string;
  engine: {name: 'chromium'; version: string};
  observations: FaultlineObservation[];
  attempts: ExternalAttemptEvidence[];
}

export interface ValidatedExternalTask extends ExternalTaskInput {readonly compiled_profile: CompiledObservationProfile;}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[], code = 'EXTERNAL_TASK_INVALID'): asserts value is Record<string, unknown> {
  demand(plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code, 'External runner input contains missing or unsupported fields.');
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function exactOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch {return false;}
}

function publicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const [a, b, c] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 100 && b! >= 64 && b! <= 127 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0 && [0, 2].includes(c!) || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 || a! >= 224);
  }
  if (family === 6) {
    const normalized = value.toLowerCase();
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith('2001:db8:') && normalized !== '2001:db8::';
  }
  return false;
}

function validPrefix(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300 && /^\/(?!\/)[A-Za-z0-9/_.%-]*$/.test(value) && !value.split('/').some(part => part === '.' || part === '..') && !/%2f|%5c/i.test(value);
}

function pathAllowed(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => prefix === '/' || pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

function parseAllowedUrl(raw: string, origins: readonly string[], prefixes: readonly string[]): {allowed: true; origin: string; path: string} | {allowed: false; code: 'ORIGIN_DENIED' | 'PATH_DENIED'; origin: string | null; path: string | null} {
  let url: URL;
  try {url = new URL(raw);} catch {return {allowed: false, code: 'ORIGIN_DENIED', origin: null, path: null};}
  if (!origins.includes(url.origin) || url.username || url.password || url.protocol !== 'https:') return {allowed: false, code: 'ORIGIN_DENIED', origin: url.origin, path: url.pathname};
  if (!pathAllowed(url.pathname, prefixes)) return {allowed: false, code: 'PATH_DENIED', origin: url.origin, path: url.pathname};
  return {allowed: true, origin: url.origin, path: url.pathname};
}

function orderedArmNames(objective: FaultlineBrowserPlan['objective']): Arm[] {
  return objective === 'mechanism' ? ['known_good', 'incident'] : ['known_good', 'incident', 'candidate'];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Revalidates every authority and immutable binding before any browser or network side effect. */
export function validateExternalTask(value: unknown, clock = new Date()): ValidatedExternalTask {
  exact(value, ['version', 'plan', 'approval', 'grant', 'observation_profile', 'network_profile', 'deployments', 'value_refs', 'task']);
  demand(value.version === 1, 'EXTERNAL_TASK_INVALID', 'Unsupported external runner task version.');
  let plan: FaultlineBrowserPlan, approval: FaultlineApproval, grant: FaultlineTargetGrant, profile: FaultlineObservationProfile;
  try {
    plan = validateContract<FaultlineBrowserPlan>('browser-plan', value.plan);
    approval = validateContract<FaultlineApproval>('approval', value.approval);
    grant = validateContract<FaultlineTargetGrant>('target-grant', value.grant);
    profile = validateContract<FaultlineObservationProfile>('observation-profile', value.observation_profile);
  } catch {throw new DomainError('EXTERNAL_TASK_SCHEMA_INVALID', 'External task contracts are invalid.', 400);}
  demand(plan.mode === 'verified_staging' || plan.mode === 'exploratory', 'EXTERNAL_MODE_REQUIRED', 'External runner accepts only staging or exploratory plans.');
  demand(plan.actions.length >= 1 && plan.actions.length <= 30 && plan.actions[0]!.op === 'navigate', 'INVALID_ACTION_PLAN', 'Finite browser plan must begin with navigation.');
  const arms = orderedArmNames(plan.objective);
  demand(plan.arms.map(item => item.arm).join(',') === arms.join(','), 'INVALID_MATRIX', 'Plan must contain the canonical protected arms.');
  demand(plan.policy_version === (plan.objective === 'mechanism' ? 'checkout_mechanism_v1' : 'checkout_completion_v1'), 'PROTECTED_ORACLE_MISMATCH', 'Objective and protected policy version disagree.');
  for (const arm of plan.arms) demand(exactOrigin(arm.origin), 'EXTERNAL_ORIGIN_INVALID', 'External targets require exact HTTPS origins.');
  const incident = plan.arms.find(item => item.arm === 'incident')!, candidate = plan.arms.find(item => item.arm === 'candidate');
  demand(!candidate || candidate.build_digest !== incident.build_digest, 'NOOP_CANDIDATE', 'Candidate cannot be the incident artifact.');
  for (const action of plan.actions) {
    if (action.op === 'navigate') demand(action.path.startsWith('/') && !action.path.startsWith('//'), 'ACTION_PATH_DENIED', 'Navigation must use a same-origin path.');
    else {
      demand(action.locator.kind === 'role' ? action.locator.role !== undefined : action.locator.role === undefined, 'LOCATOR_INVALID', 'Role locators require an explicit role and other locator kinds forbid one.');
      if (action.op === 'fill') demand(Object.hasOwn(value.value_refs as object, action.value_ref), 'VALUE_REF_MISSING', 'A finite referenced value is unavailable.');
    }
  }

  const compiled = compileObservationProfile(profile, {workspace_id: plan.workspace_id, case_id: plan.case_id, revision_id: plan.revision_id});
  demand(plan.observation_profile_hash === profile.profile_hash, 'OBSERVATION_PROFILE_BINDING_MISMATCH', 'Plan does not bind this exact observation profile.');

  const nowMs = clock.getTime();
  demand(Number.isFinite(nowMs), 'EXTERNAL_CLOCK_INVALID', 'Runner clock is invalid.');
  demand(!approval.revoked && !grant.revoked, 'APPROVAL_REVOKED', 'Approval and grant must remain active.', 403);
  demand(Date.parse(approval.expires_at) > nowMs && Date.parse(grant.expires_at) > nowMs, 'APPROVAL_EXPIRED', 'Approval or grant expired.', 403);
  demand(approval.workspace_id === plan.workspace_id && grant.workspace_id === plan.workspace_id && approval.plan_hash === hash(plan) && approval.oracle_hash === plan.oracle_hash && approval.grant_hash === hash(grant), 'APPROVAL_BINDING_MISMATCH', 'Approval must bind the exact plan, oracle and grant.', 403);
  demand(plan.arms.every(arm => grant.origins.includes(arm.origin)), 'ORIGIN_NOT_GRANTED', 'Every target origin requires the active exact grant.', 403);

  exact(value.network_profile, ['version', 'profile_hash', 'origins', 'path_prefixes', 'resolved_addresses', 'deny_private_addresses', 'max_response_bytes'], 'NETWORK_PROFILE_INVALID');
  const network = value.network_profile as unknown as ExternalNetworkProfile;
  demand(network.version === 1 && network.deny_private_addresses === true && DIGEST.test(network.profile_hash), 'NETWORK_PROFILE_INVALID', 'Network profile is invalid.');
  demand(Array.isArray(network.origins) && network.origins.length === plan.arms.length && new Set(network.origins).size === network.origins.length && network.origins.every(exactOrigin), 'NETWORK_PROFILE_INVALID', 'Network profile requires exact distinct HTTPS origins.');
  demand([...network.origins].sort().join('\n') === plan.arms.map(arm => arm.origin).sort().join('\n'), 'NETWORK_SCOPE_MISMATCH', 'Network origins must equal the plan origins.');
  demand(Array.isArray(network.path_prefixes) && network.path_prefixes.length > 0 && network.path_prefixes.length <= 20 && new Set(network.path_prefixes).size === network.path_prefixes.length && network.path_prefixes.every(validPrefix), 'NETWORK_PROFILE_INVALID', 'Network path prefixes are invalid.');
  demand(Number.isSafeInteger(network.max_response_bytes) && network.max_response_bytes > 0 && network.max_response_bytes <= 65_536 && profile.receipt.max_response_bytes <= network.max_response_bytes, 'NETWORK_PROFILE_INVALID', 'Network response budget is invalid.');
  demand(plain(network.resolved_addresses) && Object.keys(network.resolved_addresses).sort().join('\n') === plan.arms.map(arm => new URL(arm.origin).hostname).sort().join('\n'), 'NETWORK_RESOLUTION_MISMATCH', 'Resolved network binding must contain every exact target host.');
  for (const addresses of Object.values(network.resolved_addresses)) demand(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 16 && new Set(addresses).size === addresses.length && addresses.every(publicAddress), 'NETWORK_RESOLUTION_DENIED', 'Resolved network binding contains a private, invalid or duplicate address.');
  const {profile_hash: _networkHash, ...networkUnsigned} = network;
  demand(hash(networkUnsigned) === network.profile_hash, 'NETWORK_PROFILE_HASH_MISMATCH', 'Network profile hash does not bind its exact contents.');
  for (const action of plan.actions) if (action.op === 'navigate') demand(pathAllowed(new URL(action.path, plan.arms[0]!.origin).pathname, network.path_prefixes), 'ACTION_PATH_DENIED', 'Navigation path is outside the approved network profile.');
  demand(pathAllowed(receiptPath(compiled, 'validated_attempt_id_0001'), network.path_prefixes), 'RECEIPT_PATH_DENIED', 'Receipt path is outside the approved network profile.');

  demand(Array.isArray(value.deployments) && value.deployments.length === arms.length, 'DEPLOYMENT_BINDING_INVALID', 'Every canonical arm requires one deployment binding.');
  const deployments = value.deployments as unknown as ExternalDeploymentBinding[];
  deployments.forEach((deployment, index) => {
    exact(deployment, ['arm', 'deployment_id', 'attester_id', 'origin', 'build_digest', 'deployment_evidence_hash'], 'DEPLOYMENT_BINDING_INVALID');
    const arm = plan.arms[index]!;
    demand(deployment.arm === arm.arm && ID.test(deployment.deployment_id) && ID.test(deployment.attester_id) && deployment.origin === arm.origin && deployment.build_digest === arm.build_digest && deployment.deployment_evidence_hash === arm.deployment_evidence_hash, 'DEPLOYMENT_BINDING_MISMATCH', 'Deployment metadata must exactly match the canonical plan arm.');
  });

  demand(plain(value.value_refs) && Object.keys(value.value_refs).length <= 20, 'VALUE_REFS_INVALID', 'Value references must be a finite object.');
  const valueRefs = value.value_refs as Record<string, unknown>;
  for (const [key, item] of Object.entries(valueRefs)) demand(ID.test(key) && typeof item === 'string' && Buffer.byteLength(item) <= MAX_VALUE_BYTES && !/[\u0000]/.test(item), 'VALUE_REFS_INVALID', 'Value reference is invalid or exceeds its bound.');
  const usedRefs = new Set(plan.actions.filter((action): action is Extract<typeof action, {op: 'fill'}> => action.op === 'fill').map(action => action.value_ref));
  if (profile.receipt.credential_ref !== null) usedRefs.add(profile.receipt.credential_ref);
  demand([...usedRefs].every(ref => Object.hasOwn(valueRefs, ref)) && Object.keys(valueRefs).every(ref => usedRefs.has(ref)), 'VALUE_REFS_INVALID', 'Only exact referenced values may enter the task.');

  exact(value.task, ['job_id', 'lease_id', 'nonce', 'expires_at', 'plan_hash', 'approval_hash', 'grant_hash', 'observation_profile_hash', 'network_profile_hash', 'runner_id']);
  const task = value.task as unknown as ExternalRunnerTaskBinding, expires = timestamp(task.expires_at);
  demand(ID.test(task.job_id) && ID.test(task.lease_id) && NONCE.test(task.nonce) && expires !== null && expires > nowMs && expires <= nowMs + MAX_TASK_MS, 'RUNNER_TASK_INVALID', 'Runner task requires a fresh bounded server-issued lease.');
  demand(task.plan_hash === hash(plan) && task.approval_hash === hash(approval) && task.grant_hash === hash(grant) && task.observation_profile_hash === profile.profile_hash && task.network_profile_hash === network.profile_hash && task.runner_id === plan.runner_id, 'RUNNER_TASK_BINDING_MISMATCH', 'Runner lease does not bind every immutable authority and profile.');

  return deepFreeze({...structuredClone(value as unknown as ExternalTaskInput), compiled_profile: compiled});
}

function resolveLocator(page: RunnerPage, value: LocatorSpec): RunnerLocator {
  if (value.kind === 'test_id') return page.getByTestId(value.value);
  if (value.kind === 'label') return page.getByLabel(value.value);
  demand(value.role !== undefined, 'LOCATOR_INVALID', 'Role locator requires a finite role.');
  return page.getByRole(value.role, {name: value.value, exact: true});
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) demand(/^\d+$/.test(declared) && Number(declared) <= maximum, 'RECEIPT_BYTE_LIMIT', 'Receipt exceeds its approved byte limit.');
  demand(response.body, 'RECEIPT_FIELD_UNAVAILABLE', 'Receipt body is unavailable.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      demand(total <= maximum, 'RECEIPT_BYTE_LIMIT', 'Receipt exceeds its approved byte limit.');
      chunks.push(next.value);
    }
  } finally {reader.releaseLock();}
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {output.set(chunk, offset); offset += chunk.byteLength;}
  return output;
}

async function fetchReceipt(task: ValidatedExternalTask, armOrigin: string, attemptId: string, deps: ExternalTaskDependencies, signal: AbortSignal): Promise<{completed: boolean; order_count: number; error_code: string | null}> {
  const path = receiptPath(task.compiled_profile, attemptId), target = new URL(path, armOrigin);
  demand(target.origin === armOrigin && parseAllowedUrl(target.href, task.network_profile.origins, task.network_profile.path_prefixes).allowed, 'RECEIPT_PATH_DENIED', 'Receipt URL is outside the approved same-origin profile.');
  let headers: Record<string, string> | undefined;
  const credentialRef = task.observation_profile.receipt.credential_ref;
  if (credentialRef !== null) {
    demand(deps.receiptHeaders, 'RECEIPT_CREDENTIAL_ADAPTER_REQUIRED', 'Receipt credential delivery is unavailable.');
    headers = await deps.receiptHeaders(credentialRef, task.value_refs[credentialRef]!);
    demand(plain(headers) && Object.keys(headers).length <= 8 && Object.entries(headers).every(([key, val]) => /^[A-Za-z0-9-]{1,64}$/.test(key) && typeof val === 'string' && Buffer.byteLength(val) <= MAX_VALUE_BYTES && !/[\r\n\0]/.test(val)), 'RECEIPT_CREDENTIAL_INVALID', 'Receipt credential headers are invalid.');
  }
  const response = await deps.fetch(target.href, {method: 'GET', redirect: 'error', signal, headers});
  demand(response.status === 200 && !response.redirected, 'MISSING_CHECKOUT_RECEIPT', 'Receipt request did not return an exact successful response.');
  if (response.url) demand(response.url === target.href, 'RECEIPT_REDIRECT_DENIED', 'Receipt response changed the exact approved URL.');
  demand(response.headers.get('content-type')?.toLowerCase().startsWith('application/json'), 'RECEIPT_CONTENT_TYPE_INVALID', 'Receipt must be JSON.');
  const reading = readReceipt(task.compiled_profile, await boundedBody(response, task.observation_profile.receipt.max_response_bytes));
  if (reading.status !== 'observed') throw new DomainError(reading.reason_code, 'Receipt could not produce all required typed fields.');
  return reading;
}

function iso(clock: () => Date): string {
  const value = clock();
  demand(Number.isFinite(value.getTime()), 'EXTERNAL_CLOCK_INVALID', 'Runner clock is invalid.');
  return value.toISOString();
}

function errorCode(error: unknown, signal: AbortSignal, stage: string): {status: FaultlineObservation['status']; code: string} {
  if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') return {status: 'cancelled', code: 'CANCELLED'};
  if (error instanceof DomainError) return {status: 'blocked', code: error.code};
  if (error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(error.message))) return {status: 'failed', code: `BROWSER_TIMEOUT:${stage}`};
  return {status: 'failed', code: `BROWSER_EXECUTION_FAILED:${stage}`};
}

/** Executes raw observations only. Outcome and causal claim projection remain service-owned. */
export async function runExternalTask(input: unknown, deps: ExternalTaskDependencies): Promise<ExternalTaskResult> {
  demand(deps && typeof deps.browserFactory === 'function' && typeof deps.fetch === 'function' && typeof deps.clock === 'function', 'RUNNER_DEPENDENCIES_INVALID', 'External task dependencies are unavailable.');
  const task = validateExternalTask(input, deps.clock());
  const timeout = AbortSignal.timeout(Math.min(MAX_TASK_MS, Date.parse(task.task.expires_at) - deps.clock().getTime()));
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const actionTimeout = deps.action_timeout_ms ?? 10_000;
  demand(Number.isSafeInteger(actionTimeout) && actionTimeout >= 1 && actionTimeout <= 10_000, 'RUNNER_TIMING_INVALID', 'Action timeout is outside its finite bound.');
  const started_at = iso(deps.clock), observations: FaultlineObservation[] = [], attempts: ExternalAttemptEvidence[] = [], attemptIds = new Set<string>();
  const browser = await deps.browserFactory({origins: task.network_profile.origins, path_prefixes: task.network_profile.path_prefixes, resolved_addresses: task.network_profile.resolved_addresses});
  try {
    for (const deployment of task.deployments) for (const cohort of task.plan.cohorts) for (let repeat = 1; repeat <= task.plan.repeats; repeat++) {
      const attempt_id = (deps.attemptId ?? randomUUID)(), attemptStarted = iso(deps.clock);
      demand(NONCE.test(attempt_id) && !attemptIds.has(attempt_id), 'ATTEMPT_ID_INVALID', 'Attempt identifier must be a fresh opaque value.');
      attemptIds.add(attempt_id);
      let context: RunnerBrowserContext | undefined, ui_completed: boolean | null = null, receipt_completed: boolean | null = null, actual: FaultlineObservation['actual'] = null;
      let status: FaultlineObservation['status'] = 'observed', stage = 'context', network_request_count = 0;
      const errors: string[] = [], denied_requests: ExternalAttemptEvidence['denied_requests'] = [];
      const recordDenied = (code: ExternalAttemptEvidence['denied_requests'][number]['code'], _origin: string | null, _path: string | null) => {
        if (denied_requests.length < MAX_ERRORS) denied_requests.push({code, origin: null, path: null});
      };
      const abort = () => {void context?.close();};
      signal.addEventListener('abort', abort, {once: true});
      try {
        signal.throwIfAborted();
        context = await browser.newContext({viewport: VIEWPORTS[cohort], locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', acceptDownloads: false});
        await context.route('**/*', async route => {
          network_request_count += 1;
          const decision = parseAllowedUrl(route.request().url(), task.network_profile.origins, task.network_profile.path_prefixes);
          if (!decision.allowed) {recordDenied(decision.code, decision.origin, decision.path); await route.abort('blockedbyclient'); return;}
          await route.continue();
        });
        await context.routeWebSocket('**/*', socket => {recordDenied('WEBSOCKET_DENIED', null, null); socket.close({code: 1008, reason: 'scope denied'});});
        const page = await context.newPage();
        page.setDefaultTimeout(actionTimeout);
        page.on('popup', popup => {recordDenied('POPUP_DENIED', null, null); void popup.close?.();});
        page.on('download', () => {recordDenied('DOWNLOAD_DENIED', null, null);});
        for (const action of task.plan.actions) {
          stage = action.op;
          signal.throwIfAborted();
          if (action.op === 'navigate') {
            const target = new URL(action.path, deployment.origin);
            demand(!target.searchParams.has('attempt_id'), 'ATTEMPT_PARAMETER_COLLISION', 'Plan cannot supply the runner-owned attempt identifier.');
            target.searchParams.set('attempt_id', attempt_id);
            const decision = parseAllowedUrl(target.href, task.network_profile.origins, task.network_profile.path_prefixes);
            demand(decision.allowed && target.origin === deployment.origin, 'ACTION_PATH_DENIED', 'Navigation escaped the approved arm origin or path.');
            await page.goto(target.href, {waitUntil: 'load', timeout: actionTimeout});
          } else if (action.op === 'click') await resolveLocator(page, action.locator).click({timeout: actionTimeout});
          else if (action.op === 'fill') await resolveLocator(page, action.locator).fill(task.value_refs[action.value_ref]!, {timeout: actionTimeout});
          else await resolveLocator(page, action.locator).waitFor({state: 'visible', timeout: Math.min(action.timeout_ms, actionTimeout)});
          const current = parseAllowedUrl(page.url(), task.network_profile.origins, task.network_profile.path_prefixes);
          demand(current.allowed && current.origin === deployment.origin, 'REDIRECT_SCOPE_DENIED', 'Page redirected outside the approved exact arm scope.');
        }
        stage = 'receipt';
        ui_completed = await resolveLocator(page, task.observation_profile.success_locator as LocatorSpec).isVisible({timeout: actionTimeout});
        const receipt = await fetchReceipt(task, deployment.origin, attempt_id, deps, signal);
        receipt_completed = receipt.completed;
        demand(ui_completed === receipt_completed, 'INCONSISTENT_CHECKOUT_RECEIPT', 'UI completion disagrees with the isolated same-origin receipt.');
        demand(denied_requests.length === 0, 'NETWORK_SCOPE_VIOLATION', 'Browser attempted network or UI effects outside the approved boundary.');
        actual = {checkout_completed: ui_completed, order_created_count: receipt.order_count, error_code: receipt.error_code === null || receipt.error_code === task.observation_profile.incident_error_code ? receipt.error_code : 'UNEXPECTED_ERROR_CODE'};
      } catch (error) {
        const mapped = errorCode(error, signal, stage);
        status = mapped.status;
        if (errors.length < MAX_ERRORS) errors.push(mapped.code);
        actual = null;
      } finally {
        signal.removeEventListener('abort', abort);
        await context?.close().catch(() => undefined);
      }
      const observation = validateContract<FaultlineObservation>('observation', {arm: deployment.arm, cohort, repeat, status, plan_hash: task.task.plan_hash, oracle_hash: task.plan.oracle_hash, build_digest: deployment.build_digest, build_digest_after: deployment.build_digest, deployment_evidence_hash: deployment.deployment_evidence_hash, fixture_hash: task.plan.fixture_hash, environment_hash: task.plan.environment_hash, runner_id: task.plan.runner_id, actual});
      observations.push(observation);
      attempts.push({attempt_id, arm: deployment.arm, cohort, repeat, status, started_at: attemptStarted, finished_at: iso(deps.clock), observation_hash: hash(observation), ui_completed, receipt_completed, network_request_count, denied_requests, errors, deployment});
    }
    return {version: 1, scope: 'external_staging', mode: 'exploratory', verification_limit_reason: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', runner_id: task.plan.runner_id, job_id: task.task.job_id, lease_id: task.task.lease_id, nonce: task.task.nonce, plan_hash: task.task.plan_hash, observation_profile_hash: task.task.observation_profile_hash, network_profile_hash: task.task.network_profile_hash, started_at, finished_at: iso(deps.clock), engine: {name: 'chromium', version: browser.version()}, observations, attempts};
  } finally {await browser.close();}
}
