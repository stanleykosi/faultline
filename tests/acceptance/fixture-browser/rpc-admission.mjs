import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {hash, byteHash} from '../../../dist/server/packages/core/src/canonical.js';
import {request, verifyResponse, rpcSignature, signatureMatches} from '../../../dist/server/packages/core/src/experiments/protocol.js';
import {admitFixtureReceipt, evaluateFixtureVerification} from '../../../dist/server/packages/core/src/verification/fixture.js';

// Explicit first-party fixture authority only. No application, database or provider credentials.
const root = path.resolve('.'), nonce = randomUUID(), port = 3041, origin = `http://127.0.0.1:${port}`;
const started = Date.now(), deadline = started + 420000, workAbort = new AbortController();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const options = new Map();
const expectedOptions = ['harness-sha256', 'runner-source-sha256', 'runner-main-sha256', 'admission-source-sha256', 'admission-compiled-sha256', 'fixture-harness-source-sha256', 'fixture-harness-compiled-sha256'];
for (const argument of process.argv.slice(2)) {
  const match = /^--([a-z0-9-]+)=([a-f0-9]{64})$/.exec(argument);
  assert.ok(match && expectedOptions.includes(match[1]) && !options.has(match[1]), 'Pass each finite candidate hash argument exactly once.');
  options.set(match[1], match[2]);
}
assert.equal(options.size, expectedOptions.length, 'All runner/source/harness candidate hashes are mandatory.');

const runtimeRoot = path.join(root, '.runtime', 'acceptance', `rpc-admission-${nonce}`);
const stateRoot = path.join(runtimeRoot, 'state'), artifactRoot = path.join(runtimeRoot, 'artifacts'), keyPath = path.join(runtimeRoot, 'runner.key');
const outputRoot = path.join(root, 'reports', 'application', `runner-rpc-admission-${nonce}`), outputPath = path.join(outputRoot, 'result.json');
const requests = [], checks = [], protocolViolations = [], scopes = [], tasks = new Map(), ipcReplies = [], matrices = [];
const report = {schema_version: 1, status: 'running', nonce, started_at: new Date(started).toISOString(), deadline_ms: 420000,
  scope: 'Actual signed compiled-runner RPC admission and supplied trusted fixture mechanism matrices; explicit test-harness authorization, no product actor or production verification.',
  runner_origin: origin, production_claim_eligible: false, generated_scope: true, requests, checks, scopes, matrices, ipc_replies: ipcReplies,
  protocol_violations: protocolViolations, external_url_inputs: 0, product_mutations: 0, database_connections: 0,
  not_run: ['Product UI/API/worker/database', 'External target isolation', 'Live source or model integration', 'Production verification', 'Correction matrix', 'Full browser request inventory: not exposed by runner RPC'],
  resources: {runner_exit: 'not_started', browser_closed: 'unknown', fixture_servers_closed: 'unknown', native_lock_released: 'unknown', runner_port_closed: 'unknown', request_sockets_closed: 'unknown'}};
let key, child, generation, childExit, readyResolve, readyReject, cleanupDeadline, outputReady = false;
let stdoutBytes = 0, stderrBytes = 0, stdoutText = '', childClosed = false, readySettled = false;
const stdoutDigest = [], stderrDigest = [], liveRequests = new Set(), liveSockets = new Set(), pendingIpc = new Map();
const ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
// Readiness failures may precede the awaited setup step; retain them without unhandled rejection.
ready.catch(() => {});
const consumed = new Set();
const timer = setTimeout(() => workAbort.abort(Error('420-second RPC admission deadline exceeded.')), 420000).unref();
function remaining(maximum = 15000, cleanup = false) {
  const available = (cleanup ? cleanupDeadline : deadline) - Date.now();
  assert.ok(available > 0 && (cleanup || !workAbort.signal.aborted), cleanup ? 'Bounded owned-child cleanup expired.' : '420-second RPC admission deadline exceeded.');
  return Math.min(maximum, available);
}
async function bounded(promise, maximum, label) {
  let clock;
  try {return await Promise.race([promise, new Promise((_, reject) => {clock = setTimeout(() => reject(Error(`${label} exceeded ${maximum}ms.`)), maximum);})]);}
  finally {clearTimeout(clock);}
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const relative = file => path.relative(root, file).split(path.sep).join('/');
const safeError = error => ({name: error instanceof Error ? error.name : 'Error', code: typeof error?.code === 'string' ? error.code : null, message: String(error?.message ?? 'Unspecified failure').slice(0, 2000)});
async function contained(file, missing = false) {
  const absolute = path.resolve(file), rel = path.relative(root, absolute), actualRoot = await fs.realpath(root);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'All acceptance paths must remain inside the repository.');
  let current = root;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    try {
      assert.equal((await fs.lstat(current)).isSymbolicLink(), false, 'Redirected acceptance paths are forbidden.');
      const actual = path.relative(actualRoot, await fs.realpath(current));
      assert.ok(actual === '' || !actual.startsWith('..') && !path.isAbsolute(actual), 'Acceptance path escaped the repository.');
    } catch (error) {if (error.code !== 'ENOENT' || !missing) throw error;}
  }
  return absolute;
}
async function regularBytes(file, maximum = 2 * 1024 * 1024) {
  await contained(file); const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'Expected a bounded regular candidate file.');
  return fs.readFile(file);
}
async function assertPortUnused() {
  const server = net.createServer();
  await bounded(new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);}), 3000, 'Fixed private port availability');
  await bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 3000, 'Availability socket closure');
}
async function portClosed() {
  const socket = net.createConnection({host: '127.0.0.1', port});
  try {
    const result = await bounded(new Promise(resolve => {socket.once('connect', () => resolve('open')); socket.once('error', error => resolve(error.code));}), 2000, 'Runner port closure observation');
    assert.equal(result, 'ECONNREFUSED', 'Actual runner port must refuse a connection after shutdown.');
  } finally {socket.destroy();}
}
async function persist() {
  if (!outputReady) return;
  await contained(outputRoot); await contained(outputPath, true);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
}
async function check(name, operation) {
  const row = {name, status: 'running', started_at: new Date().toISOString()}; checks.push(row); report.phase = name; await persist();
  try {row.evidence = await operation(); row.status = 'passed'; row.finished_at = new Date().toISOString(); await persist(); console.log(JSON.stringify({check: name, status: row.status}));}
  catch (error) {row.status = 'failed'; row.error = safeError(error); row.finished_at = new Date().toISOString(); await persist(); throw error;}
}
function signedRpc(route, payload, {cleanup = false, forged = false, maximum = 180000} = {}) {
  assert.ok(['/v1/catalog', '/v1/prepare', '/v1/execute', '/v1/status', '/v1/cancel'].includes(route), 'Only the assigned finite runner RPC paths are permitted.');
  const body = request(route, payload, key);
  if (forged) body.signature = rpcSignature({...body, deliberately_invalid: true}, randomBytes(32));
  const bytes = Buffer.from(JSON.stringify(body)); assert.ok(bytes.length <= 1024 * 1024);
  const row = {route, method: 'POST', origin, request_nonce: body.nonce, request_sha256: byteHash(bytes), payload_hash: hash(payload), task_nonce: payload?.task?.nonce ?? payload?.nonce ?? null,
    observed_at: new Date().toISOString(), authentication: forged ? 'deliberately_invalid_signature' : 'signed_private_fixture_key'};
  requests.push(row); assert.ok(requests.length <= 250, 'Finite RPC request ledger exceeded.');
  const timeout = remaining(maximum, cleanup);
  return new Promise((resolve, reject) => {
    let settled = false, responseBytes = 0, responseChunks = [];
    const controller = new AbortController();
    const abort = () => controller.abort(workAbort.signal.reason);
    if (!cleanup) workAbort.signal.addEventListener('abort', abort, {once: true});
    const clock = setTimeout(() => controller.abort(Error('Bounded actual RPC transport expired.')), timeout);
    const settle = (error, result) => {
      if (settled) return; settled = true; clearTimeout(clock); workAbort.signal.removeEventListener('abort', abort);
      liveRequests.delete(req); row.finished_at = new Date().toISOString();
      if (error) {row.transport_error = safeError(error); reject(error);} else resolve(result);
    };
    const req = http.request({hostname: '127.0.0.1', port, path: route, method: 'POST', agent: false, signal: controller.signal,
      headers: {'Content-Type': 'application/json', 'Content-Length': String(bytes.length), 'Connection': 'close'}}, response => {
      row.http_status = response.statusCode; row.content_type = response.headers['content-type'] ?? null;
      response.on('data', chunk => {responseBytes += chunk.length; if (responseBytes > 1024 * 1024) {req.destroy(Error('Bounded runner response exceeded one MiB.')); return;} responseChunks.push(chunk);});
      response.once('error', error => settle(error));
      response.once('end', () => {
        try {
          assert.match(row.content_type ?? '', /^application\/json\b/);
          const raw = Buffer.concat(responseChunks), value = JSON.parse(raw.toString('utf8'));
          row.response_sha256 = byteHash(raw); row.response_bytes = raw.length;
          verifyResponse(value, forged ? 'unavailable' : body.nonce, key);
          row.authenticated_response = true; row.error_code = value.error_code; row.ok = value.ok;
          assert.equal(value.ok, value.error_code === null);
          settle(null, {status: row.http_status, value, row});
        } catch (error) {row.response_validation_error = safeError(error); settle(error);}
      });
    });
    liveRequests.add(req);
    req.on('socket', socket => {liveSockets.add(socket); socket.once('close', () => liveSockets.delete(socket));});
    req.once('error', error => settle(error)); req.end(bytes);
  });
}
function ok(result) {assert.equal(result.status, 200); assert.equal(result.value.ok, true); assert.equal(result.value.error_code, null); return result.value.payload;}
function denied(result, code, status) {assert.equal(result.status, status); assert.equal(result.value.ok, false); assert.equal(result.value.error_code, code); assert.equal(result.value.payload, null);}
function executionScope(payload) {return {nonce: payload.task.nonce, job_id: payload.task.job_id, lease_id: payload.task.lease_id, workspace_id: payload.plan.workspace_id, case_id: payload.plan.case_id, generation: payload.generation};}
async function prepare(workspaceId = randomUUID()) {
  const binding = {workspace_id: workspaceId, case_id: randomUUID(), revision_id: randomUUID(), hypothesis_id: randomUUID(),
    metric_hash: hash({scope: 'generated_rpc_admission_metric', nonce, workspaceId}), snapshot_hash: hash({scope: 'supplied_fixture_rpc_snapshot', nonce, workspaceId})};
  const prepared = ok(await signedRpc('/v1/prepare', {objective: 'mechanism', artifact: 'candidate', binding}, {maximum: 30000}));
  const plan = prepared.plan; assert.equal(plan.objective, 'mechanism'); assert.equal(plan.mode, 'trusted_fixture');
  for (const field of Object.keys(binding)) assert.equal(plan[field], binding[field]);
  assert.equal(plan.repeats, 3); assert.deepEqual(plan.cohorts, ['mobile', 'desktop']); assert.equal(plan.arms.length, 2);
  assert.equal(prepared.registration.generation, generation); assert.equal(plan.fixture_hash, report.fixture_hash);
  for (const arm of plan.arms) {const url = new URL(arm.origin); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.match(arm.build_digest, sha256);}
  scopes.push({...binding, plan_hash: hash(plan), oracle_hash: plan.oracle_hash});
  return plan;
}
function authorize(plan) {
  const expires = new Date(Date.now() + 590000).toISOString();
  const grant = {id: `fixture-rpc-grant-${randomUUID()}`, workspace_id: plan.workspace_id, origins: plan.arms.map(arm => arm.origin), expires_at: expires, revoked: false};
  const approval = {workspace_id: plan.workspace_id, reviewer_id: 'explicit-rpc-acceptance-owner', reviewer_role: 'owner', plan_hash: hash(plan), oracle_hash: plan.oracle_hash,
    grant_hash: hash(grant), expires_at: expires, revoked: false};
  return {plan, approval, grant, generation, artifact: 'candidate', task: {job_id: randomUUID(), lease_id: randomUUID(), nonce: randomUUID(), expires_at: expires}};
}
function registerTask(payload) {tasks.set(payload.task.nonce, payload); return payload;}
function shutdown({cleanup = false} = {}) {
  assert.ok(child?.connected && uuid.test(generation), 'Authenticated direct-parent IPC is unavailable.');
  const body = {kind: 'parent_shutdown', version: 1, nonce: randomUUID(), generation, parent_pid: process.pid};
  return new Promise((resolve, reject) => {
    const clock = setTimeout(() => {pendingIpc.delete(body.nonce); reject(Error('Authenticated parent shutdown reply deadline exceeded.'));}, remaining(15000, cleanup));
    pendingIpc.set(body.nonce, {resolve: value => {clearTimeout(clock); resolve(value);}, reject: error => {clearTimeout(clock); reject(error);}});
    child.send({...body, signature: rpcSignature(body, key)}, error => {if (error) {pendingIpc.get(body.nonce)?.reject(error); pendingIpc.delete(body.nonce);}});
  });
}
async function awaitRunning(payloads, requiredCount) {
  const until = Date.now() + remaining(10000);
  while (Date.now() < until) {
    const running = [];
    for (const payload of payloads) {
      const status = ok(await signedRpc('/v1/status', executionScope(payload), {maximum: 3000}));
      if (status.state === 'running') {assert.equal(status.stopped, false); running.push(payload);}
    }
    if (running.length >= requiredCount) return running;
    await sleep(100);
  }
  throw Error('The required number of actual running tasks was not observed while the concurrent RPCs were outstanding.');
}
async function verifyMatrix(payload, response) {
  const execution = ok(response), {receipt, expected} = execution;
  assert.equal(execution.generation, generation);
  assert.equal(expected.artifact_directory, path.join(artifactRoot, payload.task.nonce));
  assert.equal(receipt.engine.channel, process.platform === 'win32' ? 'msedge' : 'chromium');
  const admitted = admitFixtureReceipt(receipt, payload.plan, key, expected, consumed);
  const current = {...payload.plan, plan_hash: hash(payload.plan)};
  const result = evaluateFixtureVerification(admitted, current);
  assert.equal(result.observed_runs, 12); assert.equal(result.expected_runs, 12); assert.equal(result.outcome, 'passed');
  assert.equal(result.mechanism, 'reproduced'); assert.equal(result.correction, 'not_tested');
  assert.equal(result.production_claim_eligible, false); assert.equal(result.attribution.causal_effect, 'not_established');
  assert.equal(receipt.observations.length, 12); assert.equal(receipt.attempts.length, 12);
  assert.equal(new Set(receipt.attempts.map(attempt => attempt.attempt_id)).size, 12);
  const networkCodes = ['NETWORK_SCOPE_DENIED', 'ATTEMPT_SCOPE_DENIED', 'WEBSOCKET_DENIED', 'POPUP_DENIED'];
  for (const observation of receipt.observations) {
    assert.equal(observation.status, 'observed');
    const broken = observation.arm === 'incident' && observation.cohort === 'mobile';
    assert.deepEqual(observation.actual, broken ? {checkout_completed: false, order_created_count: 0, error_code: 'PAY_BUTTON_HANDLER_MISSING'} : {checkout_completed: true, order_created_count: 1, error_code: null});
  }
  for (const attempt of receipt.attempts) {assert.equal(attempt.artifacts.length, 1); assert.ok(!attempt.errors.some(code => networkCodes.includes(code)));}
  const directory = path.join(artifactRoot, payload.task.nonce); await contained(directory);
  const journal = await regularBytes(path.join(directory, 'observations.jsonl'));
  assert.equal(journal.toString('utf8').trim().split('\n').length, 12);
  const stored = JSON.parse((await regularBytes(path.join(stateRoot, 'runs', payload.task.nonce + '.json'))).toString('utf8'));
  assert.equal(stored.status, 'received'); assert.deepEqual(stored.scope, executionScope(payload)); assert.equal(stored.payload_hash, hash(payload));
  assert.equal(hash(stored.receipt), hash(receipt));
  const terminal = ok(await signedRpc('/v1/status', executionScope(payload), {maximum: 5000}));
  assert.equal(terminal.stopped, true); assert.equal(terminal.state, 'stopped'); assert.match(terminal.terminal_proof_hash, sha256);
  const value = {scope: executionScope(payload), plan_hash: hash(payload.plan), receipt_hash: hash(receipt), result, observations: receipt.observations,
    attempts: receipt.attempts, engine: receipt.engine, journal_sha256: byteHash(journal), terminal_proof_hash: terminal.terminal_proof_hash,
    artifacts: receipt.attempts.flatMap(attempt => attempt.artifacts).map(item => ({...item, path: relative(item.path)}))};
  matrices.push(value); assert.ok(matrices.length <= 4 && matrices.reduce((sum, item) => sum + item.observations.length, 0) <= 48);
  return {job_id: receipt.job_id, nonce: receipt.nonce, observed_runs: 12, mechanism: result.mechanism, aggregate_causal_effect: result.attribution.causal_effect};
}
async function burst(payloads, expectedAccepted, {testDuplicate = false, expectedActive} = {}) {
  const issued = payloads.map(payload => {
    registerTask(payload);
    return signedRpc('/v1/execute', payload).then(response => ({payload, response}), error => ({payload, error}));
  });
  const running = await awaitRunning(payloads, expectedActive);
  const busy = await shutdown(); assert.equal(busy.status, 'busy'); assert.equal(busy.error_code, 'RUNNER_BUSY');
  assert.equal(busy.active, expectedActive); assert.equal(busy.browsers_closed, false); assert.equal(busy.fixture_servers_closed, false); assert.equal(busy.native_lock_released, false);
  if (testDuplicate) denied(await signedRpc('/v1/execute', running[0], {maximum: 5000}), 'RUNNER_TASK_REPLAY', 403);
  const completed = await bounded(Promise.all(issued), remaining(180000), 'Concurrent authenticated execution wave');
  assert.ok(completed.every(item => !item.error), 'A transport failure cannot be an admission denial.');
  const accepted = completed.filter(item => item.response.status === 200);
  assert.equal(accepted.length, expectedAccepted);
  const rejected = completed.filter(item => item.response.status !== 200);
  for (const item of rejected) {
    denied(item.response, 'RUNNER_BUSY', 429);
    const status = ok(await signedRpc('/v1/status', executionScope(item.payload), {maximum: 5000}));
    assert.equal(status.state, 'containment_unknown'); assert.equal(status.stopped, false);
    await assert.rejects(fs.lstat(path.join(stateRoot, 'runs', item.payload.task.nonce + '.json')), error => error.code === 'ENOENT');
    await assert.rejects(fs.lstat(path.join(artifactRoot, item.payload.task.nonce)), error => error.code === 'ENOENT');
  }
  const proofs = [];
  for (const item of accepted) proofs.push(await verifyMatrix(item.payload, item.response));
  return {issued: payloads.length, admitted: accepted.length, rejected: rejected.length, busy_ipc_active: busy.active,
    running_scopes: running.map(executionScope), duplicate_nonce_denied: testDuplicate, full_matrices: proofs};
}

try {
  await contained(outputRoot, true); await fs.mkdir(outputRoot, {recursive: true, mode: 0o700}); await contained(outputRoot); outputReady = true;
  await check('candidate_original_fixture_and_private_runtime_preflight', async () => {
    const files = [
      ['tests/acceptance/fixture-browser/rpc-admission.mjs', 'harness-sha256'], ['apps/runner/src/main.ts', 'runner-source-sha256'],
      ['dist/server/apps/runner/src/main.js', 'runner-main-sha256'], ['apps/runner/src/admission.ts', 'admission-source-sha256'],
      ['dist/server/apps/runner/src/admission.js', 'admission-compiled-sha256'], ['apps/runner/src/trusted-fixture.ts', 'fixture-harness-source-sha256'],
      ['dist/server/apps/runner/src/trusted-fixture.js', 'fixture-harness-compiled-sha256']];
    report.candidate_files = {};
    for (const [file, option] of files) {const digest = byteHash(await regularBytes(path.join(root, file))); assert.equal(digest, options.get(option), `Candidate hash mismatch: ${file}`); report.candidate_files[file] = digest;}
    for (const file of ['dist/server/apps/runner/src/containment.js', 'dist/server/packages/core/src/experiments/protocol.js', 'dist/server/packages/core/src/verification/fixture.js', 'dist/server/packages/core/src/experiments/native-lock.js']) report.candidate_files[file] = byteHash(await regularBytes(path.join(root, file)));
    const fixtures = {'server.mjs': 'e4e65c3fba725a80dd1eb880346b94a4c7167a0730581420309d882f1e059f1e',
      'known_good.js': '019a28e7dad4620735443786c6b1d9a3e4636d11a8dd2ac8d053f12ea3006ed3', 'incident.js': 'e9feb82a796dd57a34c0d5494fd22e1f2c4c75acc18c21f1ea14d06ac7d2f9df',
      'candidate.js': '1ddbde59937c00e7fabd6f7ecd191600a0b21bc820f934a4b8454210a1da0bf1'};
    for (const [name, digest] of Object.entries(fixtures)) assert.equal(byteHash(await regularBytes(path.join(root, 'fixtures', 'checkout-site', name))), digest);
    report.original_fixture_files = fixtures; report.fixture_hash = hash({version: 1, files: fixtures, reset: 'fresh_attempt', receipt: 'isolated_sandbox_order_v1'});
    assert.equal(byteHash(await regularBytes(path.join(root, 'fixtures', 'checkout-site', 'candidate.patch'))), 'c215610e51d3b6bc076c2d7f1180aab01f011d8d837c5b82f0b519c3712a3ec7');
    await assertPortUnused();
    await contained(runtimeRoot, true); await fs.mkdir(runtimeRoot, {recursive: true, mode: 0o700}); await contained(runtimeRoot);
    for (const folder of [stateRoot, artifactRoot]) {await fs.mkdir(folder, {mode: 0o700}); await contained(folder);}
    key = randomBytes(32); await fs.writeFile(keyPath, key, {flag: 'wx', mode: 0o600}); assert.equal((await fs.lstat(keyPath)).size, 32);
    report.private_runtime = {state_root: relative(stateRoot), artifact_root: relative(artifactRoot), key_location: relative(keyPath), key_bytes: 32, port_checked_unused: true};
    return {candidate_pins: Object.keys(report.candidate_files).length, immutable_fixture_files: 4, private_port: port, private_key_bytes: 32};
  });
  await check('compiled_runner_actual_signed_catalog_and_authentication', async () => {
    const env = {};
    for (const [name, value] of Object.entries(process.env)) if (['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE', 'HOMEPATH'].includes(name.toUpperCase())) env[name] = value;
    Object.assign(env, {NODE_ENV: 'test', RUNNER_MODE: 'trusted_fixture', ALLOW_FIXTURE_ADAPTERS: 'true', RUNNER_FIXTURE_PORT: String(port), RUNNER_AUTH_KEY_PATH: keyPath, RUNNER_STATE_ROOT: stateRoot, RUNNER_ARTIFACT_ROOT: artifactRoot});
    child = spawn(process.execPath, ['--max-old-space-size=128', path.join(root, 'dist', 'server', 'apps', 'runner', 'src', 'main.js')], {cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
    report.child = {pid: child.pid, parent_pid: process.pid, compiled_entry: 'dist/server/apps/runner/src/main.js', v8_old_generation_mib: 128, inherited_runtime_credentials: false, force_kill_fallback: false};
    child.on('error', error => {if (!readySettled) {readySettled = true; readyReject(error);}});
    childExit = new Promise(resolve => child.once('exit', (code, signal) => {childClosed = true; report.resources.runner_exit = {code, signal, observed_at: new Date().toISOString()}; if (!readySettled) {readySettled = true; readyReject(Error('Owned compiled runner exited before readiness.'));} resolve({code, signal});}));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      stdoutBytes += Buffer.byteLength(text); if (stdoutBytes > 65536) {protocolViolations.push('Runner stdout exceeded its finite limit.'); workAbort.abort(Error(protocolViolations.at(-1))); return;}
      stdoutDigest.push(Buffer.from(text)); stdoutText += text;
      let index;
      while ((index = stdoutText.indexOf('\n')) !== -1) {
        const line = stdoutText.slice(0, index); stdoutText = stdoutText.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          assert.equal(message.service, 'trusted_fixture_runner'); assert.equal(message.origin, origin); assert.equal(message.scope, 'trusted_fixture'); assert.equal(message.production_claim_eligible, false); assert.match(message.generation, uuid);
          if (!readySettled) {readySettled = true; generation = message.generation; readyResolve(message);}
          else protocolViolations.push('Unexpected additional runner readiness output.');
        } catch {protocolViolations.push('Unexpected nonfinite runner stdout.');}
      }
    });
    child.stderr.on('data', bytes => {stderrBytes += bytes.length; if (stderrBytes <= 65536) stderrDigest.push(bytes); else {protocolViolations.push('Runner stderr exceeded its finite limit.'); workAbort.abort(Error(protocolViolations.at(-1)));}});
    child.on('message', message => {
      try {
        assert.ok(message && typeof message === 'object' && !Array.isArray(message));
        assert.deepEqual(Object.keys(message).sort(), ['kind', 'version', 'nonce', 'generation', 'pid', 'parent_pid', 'status', 'active', 'browsers_closed', 'fixture_servers_closed', 'native_lock_released', 'error_code', 'signature'].sort());
        const {signature, ...body} = message;
        assert.ok(signatureMatches(body, signature, key), 'Parent lifecycle result did not authenticate.');
        assert.equal(body.kind, 'parent_shutdown_result'); assert.equal(body.version, 1); assert.match(body.nonce, uuid); assert.equal(body.generation, generation);
        assert.equal(body.pid, child.pid); assert.equal(body.parent_pid, process.pid); assert.ok(['busy', 'closed', 'failed'].includes(body.status));
        assert.ok(Number.isSafeInteger(body.active) && body.active >= 0 && body.active <= 2);
        for (const field of ['browsers_closed', 'fixture_servers_closed', 'native_lock_released']) assert.equal(typeof body[field], 'boolean');
        assert.ok(body.error_code === null || typeof body.error_code === 'string' && /^[A-Z_]{1,100}$/.test(body.error_code));
        const pending = pendingIpc.get(body.nonce); assert.ok(pending, 'Unexpected lifecycle nonce.'); pendingIpc.delete(body.nonce); ipcReplies.push({...body, authenticated: true}); pending.resolve(body);
      } catch (error) {protocolViolations.push(safeError(error).message); for (const pending of pendingIpc.values()) pending.reject(error); pendingIpc.clear();}
    });
    await bounded(ready, remaining(45000), 'Compiled runner browser/server startup');
    const catalog = ok(await signedRpc('/v1/catalog', {}, {maximum: 15000}));
    assert.equal(catalog.generation, generation); assert.equal(catalog.scope, 'trusted_fixture'); assert.equal(catalog.production_claim_eligible, false);
    assert.equal(catalog.profiles.candidate.fixture_hash, report.fixture_hash);
    report.catalog = {generation, profile_hash: hash(catalog.profiles.candidate), fixture_hash: catalog.profiles.candidate.fixture_hash, environment_hash: catalog.profiles.candidate.environment_hash, observation_profile_hash: catalog.profiles.candidate.observation_profile_hash};
    denied(await signedRpc('/v1/catalog', {}, {forged: true, maximum: 5000}), 'RUNNER_AUTHENTICATION_FAILED', 403);
    return {pid: child.pid, generation, signed_catalog_verified: true, invalid_rpc_signature_rejected: true, supplied_fixture_profile: report.catalog};
  });
  await check('same_workspace_concurrent_burst_one_reservation_and_active_duplicate_denial', async () => {
    const plan = await prepare();
    return burst(Array.from({length: 4}, () => authorize(plan)), 1, {testDuplicate: true, expectedActive: 1});
  });
  await check('distinct_workspace_concurrent_burst_two_total_reservations', async () => {
    const plans = [];
    for (let i = 0; i < 4; i++) plans.push(await prepare());
    return burst(plans.map(authorize), 2, {expectedActive: 2});
  });
  await check('expired_revoked_and_wrong_hash_authority_rejected_without_browser_attempts', async () => {
    const plan = await prepare(), proofs = [];
    const variants = [
      ['grant_expired', payload => {payload.grant.expires_at = '2000-01-01T00:00:00.000Z'; payload.approval.grant_hash = hash(payload.grant);}, 'APPROVAL_EXPIRED'],
      ['approval_expired', payload => {payload.approval.expires_at = '2000-01-01T00:00:00.000Z';}, 'APPROVAL_EXPIRED'],
      ['grant_revoked', payload => {payload.grant.revoked = true; payload.approval.grant_hash = hash(payload.grant);}, 'APPROVAL_REVOKED'],
      ['approval_revoked', payload => {payload.approval.revoked = true;}, 'APPROVAL_REVOKED'],
      ['plan_hash_changed', payload => {payload.approval.plan_hash = hash({independent_wrong_plan: true});}, 'APPROVAL_BINDING_MISMATCH'],
      ['oracle_hash_changed', payload => {payload.approval.oracle_hash = hash({independent_wrong_oracle: true});}, 'APPROVAL_BINDING_MISMATCH'],
      ['grant_hash_changed', payload => {payload.approval.grant_hash = hash({independent_wrong_grant: true});}, 'APPROVAL_BINDING_MISMATCH'],
    ];
    for (const [name, mutate, errorCode] of variants) {
      const payload = registerTask(authorize(plan)); mutate(payload);
      const response = await signedRpc('/v1/execute', payload, {maximum: 10000}); denied(response, errorCode, 403);
      const status = ok(await signedRpc('/v1/status', executionScope(payload), {maximum: 5000})); assert.equal(status.state, 'stopped'); assert.equal(status.stopped, true);
      const record = JSON.parse((await regularBytes(path.join(stateRoot, 'runs', payload.task.nonce + '.json'))).toString('utf8'));
      assert.equal(record.status, 'failed'); assert.equal(record.error_code, errorCode); assert.equal(record.receipt, undefined); assert.equal(record.payload_hash, hash(payload));
      await assert.rejects(fs.lstat(path.join(artifactRoot, payload.task.nonce)), error => error.code === 'ENOENT');
      proofs.push({variant: name, task_nonce: payload.task.nonce, error_code: errorCode, http_status: response.status, browser_attempts: 0, terminal_proof_hash: status.terminal_proof_hash});
    }
    return {rejections: proofs};
  });
  await check('capacity_returns_after_failed_authority_and_complete_matrices', async () => {
    const payload = registerTask(authorize(await prepare()));
    const proof = await verifyMatrix(payload, await signedRpc('/v1/execute', payload));
    assert.equal(matrices.length, 4); assert.equal(matrices.reduce((sum, item) => sum + item.observations.length, 0), 48);
    denied(await signedRpc('/v1/execute', payload, {maximum: 5000}), 'RUNNER_TASK_REPLAY', 403);
    return {proof, actual_cells: 48, completed_execution_nonce_replay_denied: true};
  });
  assert.equal(protocolViolations.length, 0); assert.ok(requests.every(row => row.authenticated_response && !row.transport_error && !row.response_validation_error));
  for (const [file, digest] of Object.entries(report.candidate_files)) assert.equal(byteHash(await regularBytes(path.join(root, file))), digest, 'Candidate code changed during the RPC acceptance.');
  for (const [file, digest] of Object.entries(report.original_fixture_files)) assert.equal(byteHash(await regularBytes(path.join(root, 'fixtures', 'checkout-site', file))), digest, 'Original fixture changed during the RPC acceptance.');
  report.candidate_and_fixture_bookend = 'unchanged';
  report.status = 'passed';
} catch (error) {report.status = 'failed'; report.failure = safeError(error);}
finally {
  clearTimeout(timer); cleanupDeadline = Date.now() + 30000;
  if (child && !childClosed && generation) {
    try {
      if (report.status !== 'passed') {
        for (const payload of tasks.values()) {
          try {ok(await signedRpc('/v1/cancel', {nonce: payload.task.nonce, job_id: payload.task.job_id, lease_id: payload.task.lease_id}, {cleanup: true, maximum: 2000}));}
          catch (error) {report.cancellation_cleanup_errors ??= []; report.cancellation_cleanup_errors.push(safeError(error));}
        }
      }
      let closed;
      while (Date.now() < cleanupDeadline) {
        closed = await shutdown({cleanup: true});
        if (closed.status !== 'busy') break;
        assert.equal(closed.error_code, 'RUNNER_BUSY'); await sleep(200);
      }
      assert.equal(closed?.status, 'closed'); assert.equal(closed.active, 0); assert.equal(closed.error_code, null);
      assert.equal(closed.browsers_closed, true); assert.equal(closed.fixture_servers_closed, true); assert.equal(closed.native_lock_released, true);
      const exit = await bounded(childExit, remaining(5000, true), 'Authenticated compiled runner exit'); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
      await assert.rejects(fs.lstat(path.join(stateRoot, 'native-runtime.lock')), error => error.code === 'ENOENT');
      await portClosed();
      Object.assign(report.resources, {browser_closed: true, fixture_servers_closed: true, native_lock_released: true, runner_port_closed: true});
    } catch (error) {report.status = 'failed'; report.cleanup_error = safeError(error);}
  } else if (child) {report.status = 'failed'; report.cleanup_error ??= {message: 'Runner exited before an authenticated graceful closure proof or never became ready.'};}
  for (const req of liveRequests) req.destroy(Error('Acceptance transport closure'));
  for (const socket of liveSockets) socket.destroy();
  let socketPoll;
  try {await bounded(new Promise(resolve => {const poll = () => {if (liveRequests.size || liveSockets.size) socketPoll = setTimeout(poll, 20); else resolve();}; poll();}), 2000, 'Owned request socket closure'); report.resources.request_sockets_closed = true;}
  catch (error) {report.status = 'failed'; report.socket_cleanup_error = safeError(error);}
  finally {clearTimeout(socketPoll);}
  report.stdout = {bytes: stdoutBytes, sha256: byteHash(Buffer.concat(stdoutDigest))}; report.stderr = {bytes: stderrBytes, sha256: byteHash(Buffer.concat(stderrDigest)), content_recorded: false};
  report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
  if (protocolViolations.length) report.status = 'failed';
  if (child && !childClosed) {
    // Never kill an unknown browser/process tree or claim closure. Preserve exact owned-child identity.
    report.status = 'failed'; report.resources.runner_exit = 'closure_unknown';
    report.unblock = {owned_runner_pid: child.pid, parent_pid: process.pid, state_root: relative(stateRoot), required_action: 'Inspect this exact owned runner and use authenticated parent lifecycle/explicit operator containment. No forced shutdown occurred.'};
    child.stdout.destroy(); child.stderr.destroy(); if (child.connected) child.disconnect(); child.unref();
  }
  await persist();
  console.log(JSON.stringify({status: report.status, checks: checks.filter(row => row.status === 'passed').length, actual_cells: matrices.reduce((sum, item) => sum + item.observations.length, 0), receipt: relative(outputPath), resources: report.resources}));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
