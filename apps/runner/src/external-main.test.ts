import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash, createHmac} from 'node:crypto';
import {canonical, hash} from '../../../packages/core/src/canonical.js';
import {requestRunnerProbe, requestRunnerTask} from '../../../packages/core/src/targets/runner-client.js';
import type {FaultlineTargetGrant} from '../../../packages/contracts/src/generated.js';
import type {ExternalTaskInput, ExternalTaskResult} from './external-task.js';
import type {HardenedSandboxProvider} from './sandbox-provider.js';
import {MemoryRunnerNonceStore} from './nonce-store.js';
import {MemoryRunnerExecutionLedger, type ExecutionLedgerTransition, type ExecutionStatus, type RunnerExecutionLedger} from './execution-ledger.js';
import {buildExternalRunner} from './external-main.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const KEY = Buffer.alloc(32, 9);
const IMPLEMENTATION = 'a'.repeat(64);
const sha = (value: string) => hash({value});

function externalTask(job = 'job-external-one'): ExternalTaskInput {
  const profileUnsigned = {
    schema_version: 1 as const, id: 'profile-one', workspace_id: 'workspace-one', case_id: 'case-one', revision_id: 'revision-one', template: 'checkout_receipt_v1' as const,
    success_locator: {kind: 'test_id' as const, value: 'checkout-complete'},
    receipt: {path_template: '/__faultline/receipts/{attempt_id}', method: 'GET' as const, credential_ref: null, completed_pointer: '/completed', order_count_pointer: '/order_count', error_code_pointer: '/error_code', max_response_bytes: 4096},
    incident_error_code: 'DECLINED', symptom_evidence_ids: ['evidence-one'] as [string], sandbox_only: true as const, created_at: NOW.toISOString(), reviewed_by: 'owner-one',
  };
  const observation_profile = {...profileUnsigned, profile_hash: hash(profileUnsigned)};
  const plan = {
    version: 1 as const, workspace_id: 'workspace-one', case_id: 'case-one', revision_id: 'revision-one', hypothesis_id: 'hypothesis-one', objective: 'mechanism' as const, mode: 'verified_staging' as const, policy_version: 'checkout_mechanism_v1' as const,
    oracle_hash: sha('oracle'), metric_hash: sha('metric'), snapshot_hash: sha('snapshot'), fixture_hash: sha('fixture'), environment_hash: sha('environment'), runner_id: 'generic-runner-one', repeats: 3 as const, cohorts: ['mobile', 'desktop'] as ['mobile', 'desktop'],
    actions: [{op: 'navigate' as const, path: '/checkout'}, {op: 'click' as const, locator: {kind: 'role' as const, role: 'button' as const, value: 'Pay'}}] as ExternalTaskInput['plan']['actions'],
    arms: (['known_good', 'incident'] as const).map(arm => ({arm, origin: `https://${arm.replace('_', '-')}.example.test`, build_digest: sha(`${arm}-build`), deployment_evidence_hash: sha(`${arm}-deployment`)})) as ExternalTaskInput['plan']['arms'],
    observation_profile_hash: observation_profile.profile_hash,
  };
  const grant: FaultlineTargetGrant = {id: 'grant-one', workspace_id: plan.workspace_id, origins: plan.arms.map(arm => arm.origin) as FaultlineTargetGrant['origins'], expires_at: '2026-10-17T13:00:00.000Z', revoked: false};
  const approval = {plan_hash: hash(plan), oracle_hash: plan.oracle_hash, workspace_id: plan.workspace_id, reviewer_id: 'owner-one', reviewer_role: 'owner' as const, grant_hash: hash(grant), expires_at: '2026-10-17T13:00:00.000Z', revoked: false};
  const networkUnsigned = {version: 1 as const, origins: plan.arms.map(arm => arm.origin), path_prefixes: ['/checkout', '/__faultline/receipts/'], resolved_addresses: Object.fromEntries(plan.arms.map(arm => [new URL(arm.origin).hostname, ['93.184.216.34']])), deny_private_addresses: true as const, max_response_bytes: 4096};
  const network_profile = {...networkUnsigned, profile_hash: hash(networkUnsigned)};
  const deployments = plan.arms.map((arm, index) => ({arm: arm.arm, deployment_id: `deployment-${index}`, attester_id: 'operator-attester-one', origin: arm.origin, build_digest: arm.build_digest, deployment_evidence_hash: arm.deployment_evidence_hash}));
  return {version: 1, plan, approval, grant, observation_profile, network_profile, deployments, value_refs: {}, task: {job_id: job, lease_id: 'lease-external-one', nonce: 'task_nonce_external_0001', expires_at: '2026-10-17T12:05:00.000Z', plan_hash: hash(plan), approval_hash: hash(approval), grant_hash: hash(grant), observation_profile_hash: observation_profile.profile_hash, network_profile_hash: network_profile.profile_hash, runner_id: plan.runner_id}};
}

function resultFor(task: ExternalTaskInput): ExternalTaskResult {
  const observations: ExternalTaskResult['observations'] = [], attempts: ExternalTaskResult['attempts'] = [];
  let sequence = 0;
  for (const deployment of task.deployments) for (const cohort of task.plan.cohorts) for (let repeat = 1; repeat <= task.plan.repeats; repeat++) {
    sequence += 1;
    const observation = {arm: deployment.arm, cohort, repeat, status: 'observed' as const, plan_hash: task.task.plan_hash, oracle_hash: task.plan.oracle_hash, build_digest: deployment.build_digest, build_digest_after: deployment.build_digest, deployment_evidence_hash: deployment.deployment_evidence_hash, fixture_hash: task.plan.fixture_hash, environment_hash: task.plan.environment_hash, runner_id: task.plan.runner_id, actual: {checkout_completed: true, order_created_count: 1, error_code: null}};
    observations.push(observation);
    attempts.push({attempt_id: `attempt_id_${String(sequence).padStart(8, '0')}`, arm: deployment.arm, cohort, repeat, status: observation.status, started_at: NOW.toISOString(), finished_at: NOW.toISOString(), observation_hash: hash(observation), ui_completed: true, receipt_completed: true, network_request_count: 2, denied_requests: [], errors: [], deployment});
  }
  return {version: 1, scope: 'external_staging', mode: 'exploratory', verification_limit_reason: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', runner_id: task.task.runner_id, job_id: task.task.job_id, lease_id: task.task.lease_id, nonce: task.task.nonce, plan_hash: task.task.plan_hash, observation_profile_hash: task.task.observation_profile_hash, network_profile_hash: task.task.network_profile_hash, started_at: NOW.toISOString(), finished_at: NOW.toISOString(), engine: {name: 'chromium', version: 'test-1'}, observations, attempts};
}

function fakeProvider(options: {crashReconciliation?: boolean} = {}) {
  let executions = 0, probes = 0;
  const provider: HardenedSandboxProvider = {
    metadata: {adapter_id: 'generic-vm-adapter', adapter_version: '1.0.0', provider_id: 'example-cloud', provider_version: '2026-10', configuration_digest: 'f'.repeat(64), isolation: 'hardened_vm', cleanup_verification: true, crash_reconciliation: options.crashReconciliation ?? true},
    configured: true, reason: null,
    async execute(input) {
      const task = JSON.parse(input.taskJson);
      if (Object.hasOwn(task, 'provider_scope')) {
        probes += 1;
        const evidence = {version: 1, kind: 'hardened_isolation_probe', nonce: task.nonce, provider_scope: task.provider_scope, approved_origin: task.approved_origin, approved_addresses: task.approved_addresses, private_network_denied: true, firewall_default_deny: true, approved_https: true, unrelated_public_denied: true, loopback_denied: true, metadata_denied: true, private_address_denied: true, privilege_dropped: true, browser_version: 'test-1', before: {uid: 65534, gid: 65534, boot_id: `boot-${probes}`, pid_ns: `pid-${probes}`, mount_ns: `mount-${probes}`, network_ns: `network-${probes}`, cgroup: '/test', memory_max: '1', cpu_max: '1', docker_socket_present: false, control_plane_credential_present: false}};
        return {executionId: `probe-${probes}`, taskSha256: input.taskSha256, programSha256: input.programSha256, resultSha256: hash(evidence), result: evidence};
      }
      executions += 1;
      const result = resultFor(task);
      return {executionId: `execution-${executions}`, taskSha256: input.taskSha256, programSha256: input.programSha256, resultSha256: hash(result), result};
    },
    async inspect() { return {status: 'unknown', cleanup_verified: false}; },
    async cancel() { return {status: 'unknown', cleanup_verified: false}; },
  };
  return {provider, counts: () => ({executions, probes})};
}

function request(route: string, payload: unknown, nonce: string) {
  const expires_at = new Date(NOW.getTime() + 30_000).toISOString(), unsigned = {method: 'POST', path: route, version: 1, nonce, expires_at, payload};
  return {version: 1, nonce, expires_at, payload, signature: createHmac('sha256', KEY).update(canonical(unsigned)).digest('hex')};
}

async function runtime(provider: HardenedSandboxProvider, durableStores = true, executionLedger: RunnerExecutionLedger = new MemoryRunnerExecutionLedger(), resolveAddresses: (origin: string) => Promise<string[]> = async () => ['93.184.216.34']) {
  return buildExternalRunner({environment: {EXTERNAL_RUNNER_AUTH_KEY_B64: KEY.toString('base64'), RUNNER_PROVIDER_SCOPE: 'provider-scope', RUNNER_PROBE_ORIGIN: 'https://probe.example.test', RUNNER_PRIVATE_PROBE_HOST: 'app.internal'}, provider, nonceStore: new MemoryRunnerNonceStore(), executionLedger, durableStores, capabilityProgram: Buffer.from('capability'), externalProgram: Buffer.from('external'), implementationDigest: IMPLEMENTATION, resolveAddresses, clock: () => new Date(NOW)});
}

async function activate(built: Awaited<ReturnType<typeof runtime>>) {
  const body = request('/v1/probe', {profile_hash: 'b'.repeat(64), network_hash: 'c'.repeat(64), implementation_digest: IMPLEMENTATION}, '00000000-0000-4000-8000-000000000009');
  const response = await built.app.inject({method: 'POST', url: '/v1/probe', payload: body});
  assert.equal(response.statusCode, 200);
  return response.json().payload;
}

test('readiness and probe expose provider-neutral metadata and capability flags', async () => {
  const fake = fakeProvider(), built = await runtime(fake.provider);
  const ready = await built.app.inject({method: 'GET', url: '/health/ready'}), readiness = ready.json();
  assert.equal(readiness.execution_configured, true); assert.equal(readiness.execution_enabled, false); assert.equal(readiness.provider.provider_id, 'example-cloud'); assert.equal(Object.hasOwn(readiness, 'checkpoint_name'), false);
  const body = request('/v1/probe', {profile_hash: 'b'.repeat(64), network_hash: 'c'.repeat(64), implementation_digest: IMPLEMENTATION}, '00000000-0000-4000-8000-000000000001');
  const probe = await built.app.inject({method: 'POST', url: '/v1/probe', payload: body});
  assert.equal(probe.statusCode, 200); const payload = probe.json().payload;
  assert.equal(payload.adapter_id, 'generic-vm-adapter'); assert.equal(payload.cleanup_verification, true); assert.equal(payload.crash_reconciliation, true); assert.equal(payload.runs.length, 2); assert.equal(fake.counts().probes, 2);
  assert.equal((await built.app.inject({method: 'GET', url: '/health/ready'})).json().execution_enabled, true);
  await built.app.close();
});

test('capability probe refuses injected private or unbounded DNS answers before provider execution', async () => {
  for (const answers of [['127.0.0.1'], Array.from({length: 17}, (_, index) => `93.184.216.${index + 1}`)]) {
    const fake=fakeProvider(),built=await runtime(fake.provider,true,new MemoryRunnerExecutionLedger(),async()=>answers);
    const body=request('/v1/probe',{profile_hash:'b'.repeat(64),network_hash:'c'.repeat(64),implementation_digest:IMPLEMENTATION},`00000000-0000-4000-8000-${String(100+answers.length).padStart(12,'0')}`);
    const response=await built.app.inject({method:'POST',url:'/v1/probe',payload:body});
    assert.equal(response.statusCode,503);assert.equal(response.json().error_code,'RUNNER_PROBE_DNS_UNAVAILABLE');assert.equal(fake.counts().probes,0);await built.app.close();
  }
});

test('durable execution is admitted once and replayed without a second provider action', async () => {
  const fake = fakeProvider(), built = await runtime(fake.provider), task = externalTask(); await activate(built);
  const payload = {implementation_digest: IMPLEMENTATION, isolation_configuration_hash: built.isolationConfigurationHash, task, task_sha256: hash(task)};
  const first = await built.app.inject({method: 'POST', url: '/v1/tasks/execute', payload: request('/v1/tasks/execute', payload, '00000000-0000-4000-8000-000000000011')});
  assert.equal(first.statusCode, 200); assert.equal(first.json().payload.status, 'completed'); assert.equal(first.json().payload.result.mode, 'exploratory');
  const replay = await built.app.inject({method: 'POST', url: '/v1/tasks/execute', payload: request('/v1/tasks/execute', payload, '00000000-0000-4000-8000-000000000012')});
  assert.equal(replay.statusCode, 200); assert.equal(replay.json().payload.execution_id, first.json().payload.execution_id); assert.equal(fake.counts().executions, 1);
  const changed = externalTask('job-external-two'), changedPayload = {...payload, task: changed, task_sha256: hash(changed)};
  const conflict = await built.app.inject({method: 'POST', url: '/v1/tasks/execute', payload: request('/v1/tasks/execute', changedPayload, '00000000-0000-4000-8000-000000000013')});
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error_code, 'RUNNER_EXECUTION_CONFLICT'); assert.equal(fake.counts().executions, 1);
  await built.app.close();
});

test('core client and generic controller share the exact authenticated wire contract', async () => {
  const fake = fakeProvider(), built = await runtime(fake.provider);
  const profile = {endpoint: 'https://runner.example.test', implementation_digest: IMPLEMENTATION, transport_ca_sha256: 'b'.repeat(64), peer_certificate_sha256: 'c'.repeat(64)};
  let sequence = 20;
  const dependencies = {now: () => NOW.getTime(), nonce: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, environment: {RUNNER_MODE: 'external', EXTERNAL_RUNNER_URL: profile.endpoint, EXTERNAL_RUNNER_AUTH_KEY_B64: KEY.toString('base64')}, transport: async (input: any) => {
    const response = await built.app.inject({method: 'POST', url: input.url.pathname, payload: JSON.parse(input.body)});
    return {status: response.statusCode, body: response.body, leafSha256: profile.peer_certificate_sha256, rootSha256: profile.transport_ca_sha256};
  }};
  const capability = await requestRunnerProbe(profile, {profile_hash: 'd'.repeat(64), network_hash: 'e'.repeat(64)}, new AbortController().signal, dependencies);
  assert.equal(capability.provider_id, 'example-cloud'); assert.equal(capability.crash_reconciliation, true);
  const receipt = await requestRunnerTask<ExternalTaskResult>(profile, externalTask(), {adapter_id: capability.adapter_id, adapter_version: capability.adapter_version, provider_id: capability.provider_id, provider_version: capability.provider_version, provider_configuration_hash: capability.provider_configuration_hash, isolation_configuration_hash: capability.isolation_configuration_hash, execution_program_sha256: capability.execution_program_sha256}, new AbortController().signal, dependencies);
  assert.equal(receipt.result.mode, 'exploratory'); assert.equal(receipt.result.observations.length, 12); assert.equal(fake.counts().executions, 1);
  await built.app.close();
});

test('full execution stays disabled when an adapter cannot reconcile crashes', async () => {
  const fake = fakeProvider({crashReconciliation: false}), built = await runtime(fake.provider);
  const ready = (await built.app.inject({method: 'GET', url: '/health/ready'})).json();
  assert.equal(ready.probe_enabled, true); assert.equal(ready.execution_configured, false); assert.equal(ready.execution_enabled, false); assert.equal(ready.provider.crash_reconciliation, false);
  await built.app.close();
});

test('cancellation proves destruction and blocks late publication', async () => {
  let releaseStarted!: () => void, destroyed = false, executions = 0, probes = 0;
  const started = new Promise<void>(resolve => {releaseStarted = resolve;});
  const provider: HardenedSandboxProvider = {
    metadata: {adapter_id: 'generic-vm-adapter', adapter_version: '1.0.0', provider_id: 'example-cloud', provider_version: '2026-10', configuration_digest: 'f'.repeat(64), isolation: 'hardened_vm', cleanup_verification: true, crash_reconciliation: true}, configured: true, reason: null,
    async execute(input) {const task=JSON.parse(input.taskJson);if(Object.hasOwn(task,'provider_scope')){probes+=1;const evidence={version:1,kind:'hardened_isolation_probe',nonce:task.nonce,provider_scope:task.provider_scope,approved_origin:task.approved_origin,approved_addresses:task.approved_addresses,private_network_denied:true,firewall_default_deny:true,approved_https:true,unrelated_public_denied:true,loopback_denied:true,metadata_denied:true,private_address_denied:true,privilege_dropped:true,browser_version:'test-1',before:{boot_id:`cancel-boot-${probes}`,network_ns:`cancel-network-${probes}`,docker_socket_present:false,control_plane_credential_present:false}};return {executionId:`cancel-probe-${probes}`,taskSha256:input.taskSha256,programSha256:input.programSha256,resultSha256:hash(evidence),result:evidence};}executions += 1; releaseStarted(); return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}));},
    async inspect() {return destroyed ? {status: 'destroyed', cleanup_verified: true} : {status: 'running', cleanup_verified: false};},
    async cancel() {destroyed = true; return {status: 'destroyed', cleanup_verified: true};},
  };
  const built = await runtime(provider), task = externalTask(), taskSha256 = hash(task); await activate(built);
  const payload = {implementation_digest: IMPLEMENTATION, isolation_configuration_hash: built.isolationConfigurationHash, task, task_sha256: taskSha256};
  const pending = built.app.inject({method: 'POST', url: '/v1/tasks/execute', payload: request('/v1/tasks/execute', payload, '00000000-0000-4000-8000-000000000031')});
  await started;
  const command = {implementation_digest: IMPLEMENTATION, isolation_configuration_hash: built.isolationConfigurationHash, execution_key: task.task.nonce, task_sha256: taskSha256};
  const cancellation = await built.app.inject({method: 'POST', url: '/v1/tasks/cancel', payload: request('/v1/tasks/cancel', command, '00000000-0000-4000-8000-000000000032')});
  assert.equal(cancellation.statusCode, 200); assert.equal(cancellation.json().payload.status, 'cancelled');
  await pending;
  const status = await built.app.inject({method: 'POST', url: '/v1/tasks/status', payload: request('/v1/tasks/status', command, '00000000-0000-4000-8000-000000000033')});
  assert.equal(status.statusCode, 200); assert.equal(status.json().payload.status, 'cancelled'); assert.equal(executions, 1);
  await built.app.close();
});

test('cancellation wins when it races the final publication transition', async () => {
  const base = new MemoryRunnerExecutionLedger(); let release!:()=>void, reached!:()=>void;
  const publicationReached=new Promise<void>(resolve=>{reached=resolve;}),publicationRelease=new Promise<void>(resolve=>{release=resolve;});
  const ledger:RunnerExecutionLedger={
    reserve:(key,digest)=>base.reserve(key,digest),read:key=>base.read(key),listNonterminal:()=>base.listNonterminal(),
    async transition(key:string,digest:string,expected:readonly ExecutionStatus[],next:ExecutionLedgerTransition){if(next.status==='completed'){reached();await publicationRelease;}return base.transition(key,digest,expected,next);},
  };
  const fake=fakeProvider(),provider:HardenedSandboxProvider={...fake.provider,async inspect(){return {status:'running',cleanup_verified:false};},async cancel(){return {status:'destroyed',cleanup_verified:true};}};
  const built=await runtime(provider,true,ledger),task=externalTask(),taskSha256=hash(task);await activate(built);
  const payload={implementation_digest:IMPLEMENTATION,isolation_configuration_hash:built.isolationConfigurationHash,task,task_sha256:taskSha256};
  const pending=built.app.inject({method:'POST',url:'/v1/tasks/execute',payload:request('/v1/tasks/execute',payload,'00000000-0000-4000-8000-000000000041')});
  await publicationReached;
  const command={implementation_digest:IMPLEMENTATION,isolation_configuration_hash:built.isolationConfigurationHash,execution_key:task.task.nonce,task_sha256:taskSha256};
  const cancelled=await built.app.inject({method:'POST',url:'/v1/tasks/cancel',payload:request('/v1/tasks/cancel',command,'00000000-0000-4000-8000-000000000042')});
  assert.equal(cancelled.json().payload.status,'cancelled');release();assert.equal((await pending).statusCode,409);
  assert.equal((await ledger.read(task.task.nonce))?.status,'cancelled');await built.app.close();
});

test('provider failure owns cancellation and proves destruction before closing the ledger', async () => {
  const base=fakeProvider(),ledger=new MemoryRunnerExecutionLedger();let cancellations=0;
  const provider:HardenedSandboxProvider={...base.provider,async execute(input){const decoded=JSON.parse(input.taskJson);if(Object.hasOwn(decoded,'provider_scope'))return base.provider.execute(input);throw new Error('synthetic provider disconnect');},async cancel(){cancellations+=1;return {status:'destroyed',cleanup_verified:true};}};
  const built=await runtime(provider,true,ledger),task=externalTask();await activate(built);const payload={implementation_digest:IMPLEMENTATION,isolation_configuration_hash:built.isolationConfigurationHash,task,task_sha256:hash(task)};
  const response=await built.app.inject({method:'POST',url:'/v1/tasks/execute',payload:request('/v1/tasks/execute',payload,'00000000-0000-4000-8000-000000000051')});
  assert.equal(response.statusCode,503);assert.equal(cancellations,1);assert.equal((await ledger.read(task.task.nonce))?.status,'cancelled');await built.app.close();
});

test('result projection rejects an echoed task value and still contains the remote execution', async () => {
  const original=externalTask(),plan:ExternalTaskInput['plan']={...original.plan,actions:[...original.plan.actions,{op:'fill' as const,locator:{kind:'test_id' as const,value:'checkout-email'},value_ref:'buyer_email'}] as ExternalTaskInput['plan']['actions']},approval={...original.approval,plan_hash:''},secret='synthetic-private-input-value';approval.plan_hash=hash(plan);
  const task:ExternalTaskInput={...original,plan,approval,value_refs:{buyer_email:secret},task:{...original.task,plan_hash:hash(plan),approval_hash:hash(approval)}};
  const base=fakeProvider(),ledger=new MemoryRunnerExecutionLedger();let cancellations=0;
  const provider:HardenedSandboxProvider={...base.provider,async execute(input){const decoded=JSON.parse(input.taskJson) as ExternalTaskInput;if(Object.hasOwn(decoded,'provider_scope'))return base.provider.execute(input);const result=resultFor(decoded);result.attempts[0]!.errors=[secret];return {executionId:'secret-echo',taskSha256:input.taskSha256,programSha256:input.programSha256,resultSha256:hash(result),result};},async cancel(){cancellations+=1;return {status:'destroyed',cleanup_verified:true};}};
  const built=await runtime(provider,true,ledger);await activate(built);const payload={implementation_digest:IMPLEMENTATION,isolation_configuration_hash:built.isolationConfigurationHash,task,task_sha256:hash(task)};
  const response=await built.app.inject({method:'POST',url:'/v1/tasks/execute',payload:request('/v1/tasks/execute',payload,'00000000-0000-4000-8000-000000000052')});
  assert.equal(response.statusCode,503);assert.equal(response.json().error_code,'RUNNER_RESULT_UNSAFE');assert.equal(JSON.stringify(response.json()).includes(secret),false);assert.equal(cancellations,1);assert.equal((await ledger.read(task.task.nonce))?.status,'cancelled');await built.app.close();
});

test('restart reconciliation admits completed cleanup, quarantines unknown, and blocks on running work', async () => {
  const task=externalTask(),taskSha256=hash(task),programSha256=createHash('sha256').update('external').digest('hex'),result=resultFor(task);
  async function seeded(){const ledger=new MemoryRunnerExecutionLedger();await ledger.reserve(task.task.nonce,taskSha256);await ledger.transition(task.task.nonce,taskSha256,['reserved'],{status:'running',updated_at:NOW.toISOString(),recovery_task:task,execution:null});return ledger;}
  const execution={executionId:'recovered-execution',taskSha256,programSha256,resultSha256:hash(result),result};
  for(const state of ['completed','destroyed','unknown'] as const){
    const ledger=await seeded(),fake=fakeProvider(),provider:HardenedSandboxProvider={...fake.provider,async inspect(){return state==='completed'?{status:'completed',cleanup_verified:true,execution}:state==='destroyed'?{status:'destroyed',cleanup_verified:true}:{status:'unknown',cleanup_verified:false};}};
    const built=await runtime(provider,true,ledger),record=await ledger.read(task.task.nonce);
    assert.equal(record?.status,state==='completed'?'completed':state==='destroyed'?'cancelled':'containment_unknown');assert.equal((await built.app.inject({method:'GET',url:'/health/ready'})).json().reconciliation_ready,true);await built.app.close();
  }
  const ledger=await seeded();let state:'running'|'completed'='running';const fake=fakeProvider(),provider:HardenedSandboxProvider={...fake.provider,async inspect(){return state==='completed'?{status:'completed',cleanup_verified:true,execution}:{status:'running',cleanup_verified:false};}};
  const built=await runtime(provider,true,ledger);assert.equal((await built.app.inject({method:'GET',url:'/health/ready'})).json().reconciliation_ready,false);await activate(built);assert.equal((await built.app.inject({method:'GET',url:'/health/ready'})).json().execution_enabled,false);
  state='completed';const command={implementation_digest:IMPLEMENTATION,isolation_configuration_hash:built.isolationConfigurationHash,execution_key:task.task.nonce,task_sha256:taskSha256};const status=await built.app.inject({method:'POST',url:'/v1/tasks/status',payload:request('/v1/tasks/status',command,'00000000-0000-4000-8000-000000000043')});
  assert.equal(status.json().payload.status,'completed');assert.equal((await built.app.inject({method:'GET',url:'/health/ready'})).json().execution_enabled,true);await built.app.close();
});

test('selects the provider-neutral remote sandbox adapter from explicit environment configuration', async () => {
  const built = await buildExternalRunner({
    environment: {
      EXTERNAL_RUNNER_AUTH_KEY_B64: KEY.toString('base64'),
      RUNNER_PROVIDER: 'remote',
      RUNNER_PROVIDER_SCOPE: 'operator-sandbox-pool',
      RUNNER_PROBE_ORIGIN: 'https://probe.example.test',
      RUNNER_PRIVATE_PROBE_HOST: 'faultline.internal',
      REMOTE_SANDBOX_ENDPOINT: 'https://sandbox.example.test/v1/faultline',
      REMOTE_SANDBOX_AUTH_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
      REMOTE_SANDBOX_PROVIDER_ID: 'operator-cloud',
      REMOTE_SANDBOX_PROVIDER_VERSION: '2026.10',
      REMOTE_SANDBOX_ISOLATION_CONFIGURATION_HASH: 'd'.repeat(64),
      REMOTE_SANDBOX_REQUEST_TIMEOUT_MS: '5000',
    },
    nonceStore: new MemoryRunnerNonceStore(),
    executionLedger: new MemoryRunnerExecutionLedger(),
    durableStores: false,
    capabilityProgram: Buffer.from('capability'),
    externalProgram: Buffer.from('external'),
    implementationDigest: IMPLEMENTATION,
    resolveAddresses: async () => ['93.184.216.34'],
    clock: () => NOW,
  });
  assert.equal(built.provider?.metadata.adapter_id, 'faultline.hardened-sandbox.remote');
  assert.equal(built.provider?.metadata.provider_id, 'operator-cloud');
  assert.equal(built.provider?.metadata.crash_reconciliation, true);
  const ready = (await built.app.inject({method: 'GET', url: '/health/ready'})).json();
  assert.equal(ready.configured, true);
  assert.equal(ready.execution_configured, false, 'durable controller stores remain mandatory');
  assert.equal(ready.provider.adapter_id, 'faultline.hardened-sandbox.remote');
  await built.app.close();
});
