import {acquireNativeLock} from '../../../packages/core/src/experiments/native-lock.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {byteHash, hash} from '../../../packages/core/src/canonical.js';
import {demand, DomainError} from '../../../packages/core/src/errors.js';
import {validateContract} from '../../../packages/contracts/src/validate.js';
import {exactKeys, executionScope, receiptRoot, requireNativeFixtureMode, runnerKey, response, verifyRequest, signatureMatches, rpcSignature, RPC_PATHS, type RunnerExecutionScope, type FixtureArtifact, type RunnerProfile, type ExecuteInput, type RpcRequest, type RpcPath} from '../../../packages/core/src/experiments/protocol.js';
import {TrustedFixtureHarness, loadTrustedFixturePatch, type FixturePlanBinding} from './trusted-fixture.js';
import {FixtureContainment} from './containment.js';
import {RunnerAdmissionController} from './admission.js';
import type {FixtureAdmissionExpectation, FixtureRunReceipt} from '../../../packages/core/src/verification/fixture.js';

requireNativeFixtureMode();
const key = await runnerKey(), generation = randomUUID(), root = receiptRoot(), stateRoot = path.resolve(process.env.RUNNER_STATE_ROOT??'.runtime/fixture-runner'), port = Number(process.env.RUNNER_FIXTURE_PORT ?? 3040);
demand(Number.isInteger(port) && port >= 1024 && port <= 65535, 'INVALID_RUNNER_PORT', 'Configure a finite private runner port.');
await fs.mkdir(root, {recursive: true, mode: 0o700}); demand(await fs.realpath(root) === root && !(await fs.lstat(root)).isSymbolicLink(), 'RUNNER_ARTIFACT_ROOT_INVALID', 'Runner artifacts require a trusted private directory.');
const nativeLock=await acquireNativeLock(stateRoot,'runtime');
await fs.mkdir(path.join(stateRoot, 'requests'), {recursive: true, mode: 0o700}); await fs.mkdir(path.join(stateRoot, 'runs'), {recursive: true, mode: 0o700});
const harnesses = new Map<FixtureArtifact, TrustedFixtureHarness>(), starts = new Map<FixtureArtifact, Promise<TrustedFixtureHarness>>(), active = new Map<string, {controller: AbortController; input: ExecuteInput}>();
const admission = new RunnerAdmissionController();
let closing=false;
const scopeFor=(input:ExecuteInput):RunnerExecutionScope=>({nonce:input.task.nonce,job_id:input.task.job_id,lease_id:input.task.lease_id,workspace_id:input.plan.workspace_id,case_id:input.plan.case_id,generation:input.generation});
const containment=new FixtureContainment(stateRoot,root,generation,key,nonce=>{const task=active.get(nonce);return task?scopeFor(task.input):null;});await containment.initialize();
async function harness(artifact: FixtureArtifact) {demand(artifact === 'candidate' || artifact === 'known_good', 'UNTRUSTED_CANDIDATE', 'Only pinned supplied fix or known-good rollback may be selected.'); const existing = harnesses.get(artifact); if (existing) return existing; let pending = starts.get(artifact); if (!pending) {pending = TrustedFixtureHarness.start({candidateArtifact: artifact, channel: process.platform === 'win32' ? 'msedge' : 'chromium', signingKey: key, artifactRoot: root}).then(value => {harnesses.set(artifact, value); return value;}); starts.set(artifact, pending);} return pending;}
async function profile(artifact: FixtureArtifact): Promise<RunnerProfile> {const value = await harness(artifact), registration = await value.registration(); return {artifact, generation, runner_id: value.runner_id, fixture_hash: value.fixture_hash, environment_hash: value.environment_hash, observation_profile_hash: value.observation_profile_hash, ...registration};}
await harness('candidate');
async function operation(route: RpcPath, payload: unknown, requestNonce:string, requestHash:string): Promise<unknown> {
  if(route==='/v1/status')return containment.status(executionScope(payload));
  if(route==='/v1/cleanup')return containment.cleanup(executionScope(payload));
  if (route === '/v1/catalog') {exactKeys(payload, []); const patch = await loadTrustedFixturePatch(), profiles: Partial<Record<FixtureArtifact, RunnerProfile>> = {}; for (const artifact of harnesses.keys()) profiles[artifact] = await profile(artifact); return {version: 1, scope: 'trusted_fixture', production_claim_eligible: false, generation, profiles, patch: {sha256: patch.sha256, size_bytes: patch.bytes.length, bytes_base64: patch.bytes.toString('base64')}};}
  if (route === '/v1/prepare') {exactKeys(payload, ['objective', 'artifact', 'binding']); exactKeys(payload.binding, ['workspace_id', 'case_id', 'revision_id', 'hypothesis_id', 'metric_hash', 'snapshot_hash']); demand(['mechanism', 'correction'].includes(payload.objective), 'INVALID_RUNNER_INPUT', 'Invalid protected objective.'); const value = await harness(payload.artifact), b = payload.binding, binding: FixturePlanBinding = {workspace_id:b.workspace_id,case_id:b.case_id,revision_id:b.revision_id,hypothesis_id:b.hypothesis_id,metric_hash:b.metric_hash,snapshot_hash:b.snapshot_hash}; return {plan: value.plan(payload.objective, binding), registration: await profile(payload.artifact)};}
  if (route === '/v1/cancel') {exactKeys(payload, ['nonce', 'job_id', 'lease_id']); const task = active.get(payload.nonce); demand(!task || task.input.task.job_id === payload.job_id && task.input.task.lease_id === payload.lease_id, 'RUNNER_TASK_BINDING_MISMATCH', 'Cancellation requires the exact run job/fence.'); task?.controller.abort(); return {cancelled: Boolean(task)};}
  if (route === '/v1/artifact') {
    exactKeys(payload, ['nonce', 'sha256']); demand(/^[a-f0-9-]{36}$/.test(payload.nonce) && /^[a-f0-9]{64}$/.test(payload.sha256), 'INVALID_RUNNER_INPUT', 'Invalid registered artifact identity.');
    const record = JSON.parse(await fs.readFile(path.join(stateRoot, 'runs', payload.nonce + '.json'), 'utf8')) as {receipt?: FixtureRunReceipt};
    const ref = record.receipt?.attempts.flatMap(a => a.artifacts).find(a => a.sha256 === payload.sha256); demand(ref, 'ARTIFACT_UNAVAILABLE', 'Artifact was not recorded by this finite task.', 404);
    const expected = path.join(root, payload.nonce, path.basename(ref.path)); demand(expected === ref.path && (await fs.realpath(expected)) === expected && !(await fs.lstat(expected)).isSymbolicLink(), 'ARTIFACT_SCOPE_DENIED', 'Artifact is outside the trusted configured task directory.');
    const bytes = await fs.readFile(expected); demand(bytes.length <= 10 * 1024 * 1024 && bytes.length === ref.size_bytes && byteHash(bytes) === ref.sha256, 'ARTIFACT_CORRUPT', 'Registered screenshot bytes changed.'); return {sha256: ref.sha256, size_bytes: bytes.length, media_type: 'image/png', bytes_base64: bytes.toString('base64')};
  }
  exactKeys(payload, ['plan', 'approval', 'grant', 'generation', 'artifact', 'task']); exactKeys(payload.task, ['job_id', 'lease_id', 'nonce', 'expires_at']);
  const input = payload as unknown as ExecuteInput; demand(input.generation === generation, 'RUNNER_GENERATION_CHANGED', 'Runner restart invalidated this outstanding plan/grant.');
  demand(!await containment.runNonceConsumed(input.task.nonce),'RUNNER_TASK_REPLAY','Fixture execution nonce was already registered or cleaned.',403);
  const plan = validateContract<any>('browser-plan', input.plan); validateContract('approval', input.approval); validateContract('target-grant', input.grant);
  demand(!closing,'RUNNER_CLOSING','The owned runner is closing.',503);
  const reservation = admission.reserve(scopeFor(input)), controller = new AbortController();
  active.set(reservation.scope.nonce, {controller, input});
  const record={scope:scopeFor(input),request_nonce:requestNonce,request_hash:requestHash};
  let registered=false;
  try {
    const value = await harness(input.artifact), task = value.task(plan, input.task), expected: FixtureAdmissionExpectation = value.expectation(task), file = path.join(stateRoot, 'runs', task.nonce + '.json');
    await fs.writeFile(file, JSON.stringify({version: 1, generation, ...record, payload_hash:hash(input), status: 'running', expected}), {flag: 'wx', mode: 0o600}); registered=true;
    try {const execution = await value.execute(plan, input.approval, input.grant, task, {signal: controller.signal}); await fs.writeFile(file, JSON.stringify({version: 1, generation, ...record, payload_hash:hash(input), status: 'received', expected, receipt: execution.receipt}), {mode: 0o600}); return {receipt: execution.receipt, expected, generation};}
    catch (error) {await fs.writeFile(file, JSON.stringify({version: 1, generation, ...record, payload_hash:hash(input), status: 'failed', expected, error_code: error instanceof DomainError ? error.code : 'BROWSER_EXECUTION_FAILED'}), {mode: 0o600}); throw error;}
  } finally {active.delete(reservation.scope.nonce);admission.release(reservation);if(registered)await containment.terminal(record);}
}
const server = createServer(async (req, res) => {
  let nonce = 'unavailable';
  try {
    requireNativeFixtureMode(); demand(!closing,'RUNNER_CLOSING','The owned runner is closing.',503); demand(req.method === 'POST' && RPC_PATHS.includes(req.url as RpcPath) && req.headers.host === `127.0.0.1:${port}` && ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''), 'RUNNER_RPC_DENIED', 'Only authenticated finite loopback POST requests are accepted.', 403);
    demand(req.headers['content-type']?.startsWith('application/json'), 'INVALID_RUNNER_INPUT', 'Fixture RPC requires bounded JSON.');
    let total = 0; const chunks: Buffer[] = []; for await (const chunk of req) {total += chunk.length; demand(total <= 1024 * 1024, 'RUNNER_REQUEST_LIMIT', 'Fixture request is too large.'); chunks.push(chunk);}
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest; verifyRequest(req.url as RpcPath, input, key); nonce = input.nonce;
    demand(!await containment.replayed(nonce),'RUNNER_REQUEST_REPLAY','Fixture RPC request was already consumed.',403);
    try {await fs.writeFile(path.join(stateRoot, 'requests', nonce + '.json'), JSON.stringify({path: req.url, hash: hash(input), at: new Date().toISOString()}), {flag: 'wx', mode: 0o600});} catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('RUNNER_REQUEST_REPLAY', 'Fixture RPC request was already consumed.', 403); throw error;}
    const result = await operation(req.url as RpcPath, input.payload,nonce,hash(input)); res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(response(nonce, result, null, key)));
  } catch (error) {res.writeHead(error instanceof DomainError ? error.status : 422, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(response(nonce, null, error instanceof DomainError ? error.code : 'RUNNER_OPERATION_FAILED', key)));}
});
server.requestTimeout = 610_000; server.headersTimeout = 10_000; server.maxConnections = 8;
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({service: 'trusted_fixture_runner', origin: `http://127.0.0.1:${port}`, generation, scope: 'trusted_fixture', production_claim_eligible: false})));
// A directly owning operator/test parent can request graceful closure through
// its private IPC channel. No page, HTTP client or product user gains this port.
if(process.send)process.on('message',message=>{void (async()=>{
 try{
  exactKeys(message,['kind','version','nonce','generation','parent_pid','signature']);
  const {signature,...body}=message;
  demand(process.connected&&body.kind==='parent_shutdown'&&body.version===1&&body.generation===generation&&body.parent_pid===process.ppid&&typeof body.nonce==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.nonce)&&signatureMatches(body,signature,key),'RUNNER_AUTHENTICATION_FAILED','Direct parent shutdown requires current authenticated scope.',403);
  const base={kind:'parent_shutdown_result',version:1,nonce:body.nonce,generation,pid:process.pid,parent_pid:process.ppid};
  const send=(value:object,exitCode?:number)=>{const result={...value,signature:rpcSignature(value,key)};process.send!(result,()=>{if(exitCode!==undefined)process.exit(exitCode);});};
  if(active.size||admission.size){send({...base,status:'busy',active:active.size,browsers_closed:false,fixture_servers_closed:false,native_lock_released:false,error_code:'RUNNER_BUSY'});return;}
  if(closing)return;closing=true;
  let released=false;
  try{
   await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
   await Promise.all(starts.values());
   await Promise.all([...harnesses.values()].map(value=>value.close()));
   const closed=[...harnesses.values()].map(value=>value.closureStatus());
   const browsers=closed.every(value=>value.browser_closed),fixtures=closed.every(value=>value.fixture_servers_closed);
   demand(browsers&&fixtures,'RUNNER_CLOSURE_UNKNOWN','Owned fixture resources did not confirm closure.',503);
   await nativeLock.release();released=true;
   send({...base,status:'closed',active:0,browsers_closed:browsers,fixture_servers_closed:fixtures,native_lock_released:released,error_code:null},0);
  }catch(error){send({...base,status:'failed',active:active.size,browsers_closed:false,fixture_servers_closed:false,native_lock_released:released,error_code:error instanceof DomainError?error.code:'RUNNER_CLOSURE_FAILED'},1);}
 }catch{/* Invalid parent messages have no lifecycle authority. */}
 })();});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {for (const task of active.values()) task.controller.abort(); server.close(() => {void Promise.allSettled([...harnesses.values()].map(value => value.close())).then(async() => {await nativeLock.release();process.exit(0);});});});
