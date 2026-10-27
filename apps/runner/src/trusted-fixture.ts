import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright';
import {byteHash, hash, now} from '../../../packages/core/src/canonical.js';
import {demand, DomainError} from '../../../packages/core/src/errors.js';
import {validateContract} from '../../../packages/contracts/src/validate.js';
import type {FaultlineApproval, FaultlineBrowserPlan, FaultlineObservation, FaultlineTargetGrant} from '../../../packages/contracts/src/generated.js';
import {admitFixtureReceipt, authenticateValue, authorizeFixturePlan, protectedFixtureOracle, validateFixturePlan, type AdmittedFixtureReceipt, type Arm, type Cohort, type DeploymentReceipt, type FixtureAdmissionExpectation, type FixtureAttempt, type FixtureRunReceipt} from '../../../packages/core/src/verification/fixture.js';

const PINNED_FILES = Object.freeze({
  'server.mjs': 'e4e65c3fba725a80dd1eb880346b94a4c7167a0730581420309d882f1e059f1e',
  'known_good.js': '019a28e7dad4620735443786c6b1d9a3e4636d11a8dd2ac8d053f12ea3006ed3',
  'incident.js': 'e9feb82a796dd57a34c0d5494fd22e1f2c4c75acc18c21f1ea14d06ac7d2f9df',
  'candidate.js': '1ddbde59937c00e7fabd6f7ecd191600a0b21bc820f934a4b8454210a1da0bf1',
});
const FIXTURE_HASH = hash({version: 1, files: PINNED_FILES, reset: 'fresh_attempt', receipt: 'isolated_sandbox_order_v1'});
const NEGATIVE_FILES = Object.freeze({'unfixed-candidate.js': 'd93fba5aa26b7d9a2e34c46f0ed77fae3d7dddd54923eae33e02466c6853a32f', 'negative-server.mjs': '4d52ca2f04d10d3a5524e53ffb9db90db7141911b64bf8e735d408a5bec18ff1'});
const NEGATIVE_FIXTURE_HASH = hash({version: 1, scope: 'unfixed_candidate_component_acceptance_only', supplied_fixture_hash: FIXTURE_HASH, files: NEGATIVE_FILES});
const VIEWPORTS = Object.freeze({mobile: {width: 390, height: 844}, desktop: {width: 1280, height: 800}});
const RUNNER_ID = 'native-trusted-fixture-v1';
const TIMING = Object.freeze({action_timeout_ms: 10_000, receipt_settle_timeout_ms: 3000, receipt_poll_ms: 20, task_timeout_ms: 600_000});
function requireFixtureProfile(): void {demand(process.env.NODE_ENV !== 'production', 'FIXTURES_FORBIDDEN_IN_PRODUCTION', 'Trusted fixture runner is unavailable in the production profile', 403);}
type FixtureServer = {server: {listening: boolean; address(): {address: string; port: number} | string | null}; origin: string; arm: Arm; build_digest: string; close(): Promise<void>};
type FixtureArtifact = Arm | 'unfixed_candidate_acceptance';
interface FixtureRegistration {arm: Arm; artifact: FixtureArtifact; origin: string; build_digest: string; deployment_evidence_hash: string; deployment_id: string; attester_id: string; server: FixtureServer;}
export interface FixturePlanBinding {workspace_id: string; case_id: string; revision_id: string; hypothesis_id: string; metric_hash: string; snapshot_hash: string;}
export interface FixtureRunTask {job_id: string; lease_id: string; nonce: string; expires_at: string;}
export interface TrustedFixtureExecution {receipt: FixtureRunReceipt; artifact_directory: string;}
export interface TrustedFixtureOptions {channel?: 'msedge' | 'chromium'; candidateArtifact?: Arm; signingKey?: Buffer; artifactRoot?: string;}

export async function loadTrustedFixturePatch(): Promise<{bytes: Buffer; sha256: string; scope: 'supplied_fixture_only'}> {
  const location = path.resolve('fixtures/checkout-site/candidate.patch'), stats = await fs.lstat(location);
  demand(stats.isFile() && !stats.isSymbolicLink(), 'UNTRUSTED_FIXTURE_PATCH', 'Only the original supplied fixture patch can be exported');
  const bytes = await fs.readFile(location), sha256 = byteHash(bytes);
  demand(sha256 === 'c215610e51d3b6bc076c2d7f1180aab01f011d8d837c5b82f0b519c3712a3ec7', 'FIXTURE_PATCH_CHANGED', 'Supplied reviewable fixture patch differs from the original pinned bytes');
  return {bytes, sha256, scope: 'supplied_fixture_only'};
}

async function trustedFiles(): Promise<Record<string, string>> {
  const directory = path.resolve('fixtures/checkout-site'), result: Record<string, string> = {};
  for (const [name, digest] of Object.entries(PINNED_FILES)) {
    const location = path.join(directory, name), stats = await fs.lstat(location);
    demand(stats.isFile() && !stats.isSymbolicLink(), 'UNTRUSTED_FIXTURE_FILE', 'Trusted fixture registration requires the supplied regular files');
    const bytes = await fs.readFile(location); demand(byteHash(bytes) === digest, 'FIXTURE_BYTES_CHANGED', `Supplied immutable fixture ${name} differs from its pinned original bytes`);
    result[name] = bytes.toString('utf8');
  }
  return result;
}
function digestFromFiles(files: Record<string, string>, artifact: Arm): string {
  const html = /^const html='([^']+)';$/m.exec(files['server.mjs']!)?.[1];
  demand(html, 'UNSUPPORTED_FIXTURE', 'Pinned fixture HTML declaration could not be read independently');
  return byteHash(html + '\n' + files[`${artifact}.js`]! + '\n' + files['server.mjs']!);
}
async function negativeFiles(): Promise<Record<string, string>> {
  const directory = path.resolve('tests/acceptance/fixture-browser/fixtures'), result: Record<string, string> = {};
  demand((await fs.lstat(directory)).isDirectory() && !(await fs.lstat(directory)).isSymbolicLink(), 'UNTRUSTED_FIXTURE_FILE', 'Acceptance fixtures require a regular private source directory');
  for (const [name, digest] of Object.entries(NEGATIVE_FILES)) {const location = path.join(directory, name), info = await fs.lstat(location); demand(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 65_536, 'UNTRUSTED_FIXTURE_FILE', 'Only finite pinned acceptance fixture files are permitted'); const bytes = await fs.readFile(location); demand(byteHash(bytes) === digest, 'FIXTURE_BYTES_CHANGED', 'Unfixed acceptance fixture differs from its independently pinned bytes'); result[name] = bytes.toString('utf8');}
  return result;
}
function negativeDigest(files: Record<string, string>, negative: Record<string, string>): string {const html = /^const html='([^']+)';$/m.exec(files['server.mjs']!)?.[1]; demand(html, 'UNSUPPORTED_FIXTURE', 'Pinned fixture HTML declaration is required'); return byteHash(html + '\n' + negative['unfixed-candidate.js']! + '\n' + files['server.mjs']! + '\n' + negative['negative-server.mjs']!);}
function requireNegativeAcceptance(): void {requireFixtureProfile(); demand(process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE === 'explicit_test_harness_only', 'ACCEPTANCE_ONLY_FIXTURE', 'Unfixed candidate execution requires explicit component acceptance scope and is unavailable through product runner registration', 403);}
function locator(page: Page, value: {kind: string; value: string}) {
  demand(value.kind === 'test_id' && ['pay', 'checkout-status'].includes(value.value), 'FIXTURE_LOCATOR_DENIED', 'Only protected fixture locators are permitted');
  return page.getByTestId(value.value);
}
async function readReceipt(origin: string, attempt: string, signal: AbortSignal): Promise<{completed: boolean; order_count: number; error_code: string | null}> {
  const response = await fetch(`${origin}/__faultline/receipts/${encodeURIComponent(attempt)}`, {method: 'GET', redirect: 'error', signal});
  demand(response.status === 200 && response.headers.get('content-type')?.startsWith('application/json'), 'MISSING_CHECKOUT_RECEIPT', 'Actual attempt receipt is unavailable');
  let bytes = 0; const chunks: Uint8Array[] = [];
  demand(response.body, 'MISSING_CHECKOUT_RECEIPT', 'Receipt body is unavailable');
  for await (const chunk of response.body) {bytes += chunk.byteLength; demand(bytes <= 4096, 'RECEIPT_BYTE_LIMIT', 'Receipt exceeds its frozen response bound'); chunks.push(chunk);}
  let result: unknown; try {result = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new DomainError('INVALID_CHECKOUT_RECEIPT', 'Receipt contains malformed JSON');}
  demand(result && typeof result === 'object' && !Array.isArray(result), 'INVALID_CHECKOUT_RECEIPT', 'Receipt must be a typed object');
  const record = result as Record<string, unknown>;
  demand(typeof record.completed === 'boolean' && Number.isSafeInteger(record.order_count) && Number(record.order_count) >= 0 && (record.error_code === null || (typeof record.error_code === 'string' && record.error_code.length <= 100)), 'INVALID_CHECKOUT_RECEIPT', 'Receipt is missing a required typed assertion');
  return {completed: record.completed, order_count: record.order_count as number, error_code: record.error_code as string | null};
}

/** No serialized URL can register a native target. Registrations originate from the pinned fixture process. */
export class TrustedFixtureHarness {
  #browser: Browser; #secret = randomBytes(32); #registrations: FixtureRegistration[];
  #tasks = new Map<string, {expectation: FixtureAdmissionExpectation; plan_hash: string; started: boolean}>();
  #consumed = new Set<string>(); #closed = false; #channel: 'msedge' | 'chromium'; #artifactRoot: string;
  readonly environment_hash: string; readonly fixture_hash: string; readonly runner_id = RUNNER_ID; readonly observation_profile_hash: string;
  #negativeAcceptance: boolean;
  private constructor(browser: Browser, registrations: FixtureRegistration[], channel: 'msedge' | 'chromium', options: TrustedFixtureOptions, negativeAcceptance = false) {
    this.#browser = browser; this.#registrations = registrations; this.#channel = channel;
    this.#negativeAcceptance = negativeAcceptance; this.fixture_hash = negativeAcceptance ? NEGATIVE_FIXTURE_HASH : FIXTURE_HASH;
    this.observation_profile_hash = hash({version: 1, success_locator: {kind: 'test_id', value: 'checkout-status'}, success_text: 'Checkout complete', receipt: {path_template: '/__faultline/receipts/{attempt_id}', completed_pointer: '/completed', order_count_pointer: '/order_count', error_code_pointer: '/error_code', method: 'GET', max_response_bytes: 4096}, incident_error_code: 'PAY_BUTTON_HANDLER_MISSING', symptom: 'Pinned incident narrow viewport has missing button handler', fixture_hash: this.fixture_hash});
    this.#artifactRoot = path.resolve(options.artifactRoot ?? 'tests/acceptance/fixture-browser/artifacts');
    if (options.signingKey) {demand(options.signingKey.length === 32, 'INVALID_RUNNER_KEY', 'Operator fixture signing key must be 256 bits'); this.#secret = Buffer.from(options.signingKey);}
    this.environment_hash = hash({version: 1, engine: 'chromium', channel, engine_version: browser.version(), viewports: VIEWPORTS, timing: TIMING, timezone: 'UTC', locale: 'en-US', network: 'registered_fixture_only', feature_flags: [], account: 'no_account', reset: 'fresh_attempt', browser_context: 'fresh_per_attempt', service_workers: 'blocked'});
  }
  /** Explicit test-only factory; never used by ordinary runner RPC/catalog. */
  static async startNegativeCorrectionAcceptance(options: Omit<TrustedFixtureOptions, 'candidateArtifact'> = {}): Promise<TrustedFixtureHarness> {
    requireNegativeAcceptance();
    demand(Object.keys(options).every(key => ['channel', 'signingKey', 'artifactRoot'].includes(key)), 'UNTRUSTED_CANDIDATE', 'Acceptance factory accepts no supplied script, artifact choice, URL, origin, port or browser flags');
    const channel = options.channel ?? 'msedge'; demand(channel === 'msedge' || channel === 'chromium', 'INVALID_BROWSER_CHANNEL', 'Only registered browser channels are supported');
    const files = await trustedFiles(), negative = await negativeFiles(), module = await import(pathToFileURL(path.resolve('fixtures/checkout-site/server.mjs')).href) as {startFixture(options: {arm: Arm; port: number}): Promise<FixtureServer>};
    const negativeModule = await import(pathToFileURL(path.resolve('tests/acceptance/fixture-browser/fixtures/negative-server.mjs')).href) as {startUnfixedCandidateFixture(): Promise<FixtureServer>};
    const registrations: FixtureRegistration[] = []; let browser: Browser | undefined;
    try {
      for (const arm of ['known_good', 'incident', 'candidate'] as const) {requireNegativeAcceptance(); const artifact: FixtureArtifact = arm === 'candidate' ? 'unfixed_candidate_acceptance' : arm, server = arm === 'candidate' ? await negativeModule.startUnfixedCandidateFixture() : await module.startFixture({arm, port: 0}), digest = arm === 'candidate' ? negativeDigest(files, negative) : digestFromFiles(files, arm);
        demand(server.build_digest === digest, 'FIXTURE_PROCESS_MISMATCH', 'Actual acceptance fixture build disagrees with independent pinned bytes');
        const deployment_id = `acceptance-fixture-deployment-${randomUUID()}`, attester_id = 'first-party-negative-fixture-observer-v1'; registrations.push({arm, artifact, origin: server.origin, build_digest: digest, deployment_id, attester_id, server, deployment_evidence_hash: hash({version: 1, deployment_id, origin: server.origin, build_digest: digest, fixture_hash: NEGATIVE_FIXTURE_HASH, attester_id})});
      }
      browser = await chromium.launch({channel, headless: true, chromiumSandbox: true, timeout: 30_000}); return new TrustedFixtureHarness(browser, registrations, channel, options, true);
    } catch (error) {await browser?.close(); await Promise.allSettled(registrations.map(item => item.server.close())); throw error;}
  }
  #requireScope(): void {requireFixtureProfile(); if (this.#negativeAcceptance) requireNegativeAcceptance();}
  static async start(options: TrustedFixtureOptions = {}): Promise<TrustedFixtureHarness> {
    requireFixtureProfile();
    const channel = options.channel ?? 'msedge'; demand(channel === 'msedge' || channel === 'chromium', 'INVALID_BROWSER_CHANNEL', 'Only operator-selected registered browser channels are supported');
    const candidate = options.candidateArtifact ?? 'candidate'; demand(['known_good', 'incident', 'candidate'].includes(candidate), 'UNTRUSTED_CANDIDATE', 'Only supplied immutable fixture artifacts may run natively');
    const files = await trustedFiles();
    const moduleUrl = pathToFileURL(path.resolve('fixtures/checkout-site/server.mjs')).href;
    const fixtureModule = await import(moduleUrl) as {startFixture(options: {arm: Arm; port: number}): Promise<FixtureServer>};
    const registrations: FixtureRegistration[] = [];
    let browser: Browser | undefined;
    try {
      for (const arm of ['known_good', 'incident', 'candidate'] as const) {
        const artifact = arm === 'candidate' ? candidate : arm;
        const server = await fixtureModule.startFixture({arm: artifact, port: 0}), digest = digestFromFiles(files, artifact);
        demand(server.build_digest === digest, 'FIXTURE_PROCESS_MISMATCH', 'Fixture server registration disagrees with independently read immutable files');
        const deployment_id = `fixture-deployment-${randomUUID()}`, attester_id = 'first-party-fixture-observer-v1';
        registrations.push({arm, artifact, origin: server.origin, build_digest: digest, deployment_id, attester_id, server,
          deployment_evidence_hash: hash({version: 1, deployment_id, origin: server.origin, build_digest: digest, fixture_hash: FIXTURE_HASH, attester_id})});
      }
      browser = await chromium.launch({channel, headless: true, chromiumSandbox: true, timeout: 30_000});
      return new TrustedFixtureHarness(browser, registrations, channel, options);
    } catch (error) {await browser?.close(); await Promise.allSettled(registrations.map(r => r.server.close())); throw error;}
  }
  plan(objective: 'mechanism' | 'correction', binding: FixturePlanBinding, actions?: FaultlineBrowserPlan['actions']): FaultlineBrowserPlan {
    demand(!this.#closed, 'RUNNER_CLOSED', 'Fixture harness is closed');
    const oracle = protectedFixtureOracle(objective), arms = this.#registrations.filter(r => objective === 'correction' || r.arm !== 'candidate').map(({arm, origin, build_digest, deployment_evidence_hash}) => ({arm, origin, build_digest, deployment_evidence_hash}));
    if (this.#negativeAcceptance) requireNegativeAcceptance(); return validateFixturePlan({...binding, version: 1, objective, mode: 'trusted_fixture', policy_version: oracle.version, oracle_hash: hash(oracle), fixture_hash: this.fixture_hash, environment_hash: this.environment_hash, runner_id: RUNNER_ID, repeats: 3, cohorts: ['mobile', 'desktop'], observation_profile_hash: this.observation_profile_hash, actions: actions ?? [{op: 'navigate', path: '/'}, {op: 'click', locator: {kind: 'test_id', value: 'pay'}}], arms});
  }
  task(planValue: unknown, requested?: FixtureRunTask): FixtureRunTask {
    const plan = this.#registeredPlan(planValue), task = requested ?? {job_id: `fixture-job-${randomUUID()}`, lease_id: `fixture-lease-${randomUUID()}`, nonce: randomUUID(), expires_at: new Date(Date.now() + 600_000).toISOString()};
    demand(/^[A-Za-z0-9_-]{8,100}$/.test(task.job_id) && /^[A-Za-z0-9_-]{8,100}$/.test(task.lease_id) && /^[a-f0-9-]{36}$/.test(task.nonce) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(task.expires_at) && Date.parse(task.expires_at) > Date.now() && Date.parse(task.expires_at) <= Date.now() + 600_001 && !this.#tasks.has(task.nonce), 'INVALID_RUNNER_TASK', 'Task requires a fresh server-owned job/fence/nonce and bounded deadline');
    const deployments = Object.fromEntries(this.#registrations.map(r => [r.arm, {deployment_id: r.deployment_id, attester_id: r.attester_id}]));
    this.#tasks.set(task.nonce, {expectation: {...task, observation_profile_hash: this.observation_profile_hash, artifact_directory: path.join(this.#artifactRoot, task.nonce), deployments}, plan_hash: hash(plan), started: false}); return task;
  }
  expectation(task: FixtureRunTask): FixtureAdmissionExpectation {
    const stored = this.#tasks.get(task.nonce); demand(stored && hash(task) === hash({job_id: stored.expectation.job_id, lease_id: stored.expectation.lease_id, nonce: stored.expectation.nonce, expires_at: stored.expectation.expires_at}), 'UNREGISTERED_RUNNER_TASK', 'Task expectation must originate from this runner');
    return structuredClone(stored.expectation);
  }
  async registration(): Promise<{arms: FaultlineBrowserPlan['arms']; deployments: FixtureAdmissionExpectation['deployments']}> {
    requireFixtureProfile();
    demand(!this.#negativeAcceptance, 'ACCEPTANCE_ONLY_FIXTURE', 'Unfixed negative fixtures cannot enter the ordinary product runner catalog', 403);
    for (const item of this.#registrations) await this.#observeDeployment(item, 'catalog-' + randomUUID());
    const arm = (name: Arm) => {const item = this.#registrations.find(r => r.arm === name); demand(item, 'INVALID_MATRIX', 'Registered fixture arm is unavailable'); return {arm: item.arm, origin: item.origin, build_digest: item.build_digest, deployment_evidence_hash: item.deployment_evidence_hash};};
    return {arms: [arm('known_good'), arm('incident'), arm('candidate')], deployments: Object.fromEntries(this.#registrations.map(r => [r.arm, {deployment_id: r.deployment_id, attester_id: r.attester_id}]))};
  }
  #registeredPlan(value: unknown): FaultlineBrowserPlan {
    if (this.#negativeAcceptance) requireNegativeAcceptance();
    const plan = validateFixturePlan(value);
    demand(plan.fixture_hash === this.fixture_hash && plan.environment_hash === this.environment_hash && plan.runner_id === RUNNER_ID && plan.observation_profile_hash === this.observation_profile_hash, 'FIXTURE_PROFILE_BINDING_MISMATCH', 'Plan requires this actual runner environment and immutable fixture/profile');
    for (const arm of plan.arms) {
      const registration = this.#registrations.find(r => r.arm === arm.arm);
      demand(registration && registration.origin === arm.origin && registration.build_digest === arm.build_digest && registration.deployment_evidence_hash === arm.deployment_evidence_hash, 'UNREGISTERED_FIXTURE_ORIGIN', 'Native execution requires an origin/build created by this fixture harness');
    }
    return plan;
  }
  async #observeDeployment(registration: FixtureRegistration, nonce: string): Promise<DeploymentReceipt> {
    const files = await trustedFiles(), address = registration.server.server.address();
    demand(registration.server.server.listening && typeof address === 'object' && address?.address === '127.0.0.1' && registration.origin === `http://127.0.0.1:${address.port}`, 'FIXTURE_PROCESS_UNAVAILABLE', 'Independent fixture process registration no longer matches its origin');
    const build_digest = registration.artifact === 'unfixed_candidate_acceptance' ? negativeDigest(files, await negativeFiles()) : digestFromFiles(files, registration.artifact);
    demand(build_digest === registration.build_digest, 'FIXTURE_BUILD_CHANGED', 'Immutable fixture artifact changed during execution');
    const body = {deployment_id: registration.deployment_id, origin: registration.origin, build_digest, nonce, observed_at: now(), attester_id: registration.attester_id};
    return {...body, signature: authenticateValue(body, this.#secret)};
  }
  async execute(planValue: unknown, approval: FaultlineApproval, grant: FaultlineTargetGrant, task: FixtureRunTask, options: {signal?: AbortSignal} = {}): Promise<TrustedFixtureExecution> {
    this.#requireScope();
    demand(!this.#closed, 'RUNNER_CLOSED', 'Fixture harness is closed');
    const plan = this.#registeredPlan(authorizeFixturePlan(planValue, approval, grant)), stored = this.#tasks.get(task.nonce);
    demand(stored && !stored.started && stored.plan_hash === hash(plan) && hash(task) === hash({job_id: stored.expectation.job_id, lease_id: stored.expectation.lease_id, nonce: stored.expectation.nonce, expires_at: stored.expectation.expires_at}) && Date.parse(task.expires_at) > Date.now(), 'TASK_REPLAY_OR_MISMATCH', 'Task must be a fresh registered lease for the exact approved plan'); stored.started = true;
    const started_at = now(), signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMING.task_timeout_ms)]) : AbortSignal.timeout(TIMING.task_timeout_ms);
    const observations: FaultlineObservation[] = [], attempts: FixtureAttempt[] = [];
    const directory = path.join(this.#artifactRoot, task.nonce); await fs.mkdir(directory, {recursive: true});
    let artifactBytes = 0;
    for (const arm of plan.arms) for (const cohort of plan.cohorts) for (let repeat = 1; repeat <= 3; repeat++) {
      this.#requireScope();
      authorizeFixturePlan(plan, approval, grant);
      const registration = this.#registrations.find(r => r.arm === arm.arm)!, attempt_id = randomUUID(), before = await this.#observeDeployment(registration, `${task.nonce}:${attempt_id}:before`);
      let actual: FaultlineObservation['actual'] = null, status: FaultlineObservation['status'] = 'observed', ui_completed: boolean | null = null, receipt_completed: boolean | null = null;
      const errors: string[] = [], artifacts: FixtureAttempt['artifacts'] = [];
      let context: BrowserContext | undefined;
      let stage = 'context';
      const abort = () => {void context?.close();}; signal.addEventListener('abort', abort, {once: true});
      try {
        signal.throwIfAborted();
        context = await this.#browser.newContext({viewport: VIEWPORTS[cohort], locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', acceptDownloads: false});
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          const allowed = url.origin === arm.origin && ((req.method() === 'GET' && ['/', '/behavior.js', '/favicon.ico'].includes(url.pathname)) || (req.method() === 'POST' && ['/api/sandbox/order', '/api/sandbox/failure'].includes(url.pathname)));
          if (!allowed) {if (errors.length < 30) errors.push('NETWORK_SCOPE_DENIED'); await route.abort('blockedbyclient'); return;}
          if (req.method() === 'POST') {
            let data: unknown; try {data = JSON.parse(req.postData() ?? '');} catch {data = null;}
            const body = data as Record<string, unknown> | null, keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
            const validBody = body?.attempt_id === attempt_id && Buffer.byteLength(req.postData() ?? '') <= 4096 && !url.search && (url.pathname === '/api/sandbox/order' ? keys.join(',') === 'attempt_id' : keys.join(',') === 'attempt_id,error_code' && body.error_code === 'PAY_BUTTON_HANDLER_MISSING');
            if (!validBody) {if (errors.length < 30) errors.push('ATTEMPT_SCOPE_DENIED'); await route.abort('blockedbyclient'); return;}
          }
          await route.continue();
        });
        await context.routeWebSocket('**/*', socket => {if (errors.length < 30) errors.push('WEBSOCKET_DENIED'); socket.close();});
        const page = await context.newPage(); page.setDefaultTimeout(TIMING.action_timeout_ms);
        page.on('console', message => {if (message.type() === 'error' && message.text().includes('PAY_BUTTON_HANDLER_MISSING') && errors.length < 30) errors.push('PAY_BUTTON_HANDLER_MISSING');});
        page.on('popup', popup => {if (errors.length < 30) errors.push('POPUP_DENIED'); void popup.close();});
        for (const action of plan.actions) {
          stage = action.op;
          signal.throwIfAborted();
          if (action.op === 'navigate') await page.goto(`${arm.origin}/?attempt_id=${encodeURIComponent(attempt_id)}`, {waitUntil: 'load', timeout: TIMING.action_timeout_ms});
          else if (action.op === 'click') await locator(page, action.locator).click({timeout: TIMING.action_timeout_ms});
          else if (action.op === 'wait_for') await locator(page, action.locator).waitFor({state: 'visible', timeout: action.timeout_ms});
          else throw new DomainError('FIXTURE_ACTION_DENIED', 'Unsupported native fixture action');
        }
        stage = 'receipt';
        let receipt = await readReceipt(arm.origin, attempt_id, signal), ui = (await page.getByTestId('checkout-status').textContent())?.trim() === 'Checkout complete';
        const deadline = Date.now() + TIMING.receipt_settle_timeout_ms;
        while (!(ui && receipt.completed) && receipt.error_code === null && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, TIMING.receipt_poll_ms)); signal.throwIfAborted();
          receipt = await readReceipt(arm.origin, attempt_id, signal); ui = (await page.getByTestId('checkout-status').textContent())?.trim() === 'Checkout complete';
        }
        ui_completed = ui; receipt_completed = receipt.completed;
        demand(ui === receipt.completed, 'INCONSISTENT_CHECKOUT_RECEIPT', 'UI completion disagrees with isolated sandbox order receipt');
        actual = {checkout_completed: ui, order_created_count: receipt.order_count, error_code: receipt.error_code};
        demand(!errors.some(e => ['NETWORK_SCOPE_DENIED', 'ATTEMPT_SCOPE_DENIED', 'WEBSOCKET_DENIED', 'POPUP_DENIED'].includes(e)), 'FIXTURE_NETWORK_SCOPE_VIOLATION', 'Attempt exceeded the finite fixture network/action boundary');
        stage = 'screenshot';
        const screenshot = await page.screenshot({type: 'png', fullPage: false}), screenshotPath = path.join(directory, `${arm.arm}-${cohort}-${repeat}.png`);
        artifactBytes += screenshot.byteLength; demand(artifactBytes <= 100 * 1024 * 1024, 'ARTIFACT_BUDGET_EXCEEDED', 'Run exceeds its artifact budget');
        await fs.writeFile(screenshotPath, screenshot, {flag: 'wx'}); artifacts.push({path: screenshotPath, sha256: byteHash(screenshot), size_bytes: screenshot.byteLength, media_type: 'image/png'});
      } catch (error) {
        status = signal.aborted ? 'cancelled' : error instanceof DomainError ? 'blocked' : 'failed'; actual = null;
        if (errors.length < 30) errors.push(error instanceof DomainError ? error.code : signal.aborted ? 'CANCELLED' : `${error instanceof Error && error.name === 'TimeoutError' ? 'BROWSER_TIMEOUT' : 'BROWSER_EXECUTION_FAILED'}:${stage}`);
      } finally {signal.removeEventListener('abort', abort); await context?.close();}
      const after = await this.#observeDeployment(registration, `${task.nonce}:${attempt_id}:after`);
      authorizeFixturePlan(plan, approval, grant);
      const observation = validateContract<FaultlineObservation>('observation', {arm: arm.arm, cohort, repeat, status, plan_hash: hash(plan), oracle_hash: plan.oracle_hash, build_digest: before.build_digest, build_digest_after: after.build_digest, deployment_evidence_hash: arm.deployment_evidence_hash, fixture_hash: this.fixture_hash, environment_hash: this.environment_hash, runner_id: RUNNER_ID, actual});
      observations.push(observation); attempts.push({attempt_id, arm: arm.arm, cohort, repeat, observation_hash: hash(observation), ui_completed, receipt_completed, before, after, artifacts, errors});
      const checkpoint = {task_nonce: task.nonce, plan_hash: hash(plan), observation, attempt: attempts.at(-1)!, recorded_at: now()};
      await fs.appendFile(path.join(directory, 'observations.jsonl'), JSON.stringify({...checkpoint, signature: authenticateValue(checkpoint, this.#secret)}) + '\n');
    }
    const body = {version: 1 as const, scope: 'trusted_fixture' as const, runner_id: RUNNER_ID, ...task, plan_hash: hash(plan), observation_profile_hash: this.observation_profile_hash, started_at, finished_at: now(), engine: {name: 'chromium' as const, channel: this.#channel, version: this.#browser.version()}, observations, attempts};
    const {expires_at: _expires, ...receiptBody} = body;
    const receipt: FixtureRunReceipt = {...receiptBody, signature: authenticateValue(receiptBody, this.#secret)};
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2), {flag: 'wx'});
    return {receipt, artifact_directory: directory};
  }
  admit(execution: TrustedFixtureExecution, planValue: unknown): AdmittedFixtureReceipt {
    const plan = this.#registeredPlan(planValue), stored = this.#tasks.get(execution.receipt.nonce);
    demand(stored?.started, 'UNREGISTERED_RUN_RECEIPT', 'Receipt requires an executed registered native task');
    return admitFixtureReceipt(execution.receipt, plan, this.#secret, stored.expectation, this.#consumed);
  }
  async close(): Promise<void> {if (this.#closed) return; this.#closed = true; await this.#browser.close(); await Promise.allSettled(this.#registrations.map(r => r.server.close()));}
  closureStatus(): {browser_closed: boolean; fixture_servers_closed: boolean} {return {browser_closed: !this.#browser.isConnected(), fixture_servers_closed: this.#registrations.every(item => !item.server.server.listening)};}
}
