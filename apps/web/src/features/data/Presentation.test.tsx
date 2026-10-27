import type {Comparison} from './types';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError} from '../../api';
import type {CommandIdentity} from '../../command-key';
import {ComparisonResult, JobPanel, RecoveryAcceptance, FollowupJobOutcome, recordedFollowupOutcome, jobRecoveryMode, recoverJob, type JobRecoveryReceipt, type RecoveryJob} from './Presentation';
import type {JobStreamView} from './job-stream';

const failed: RecoveryJob = {id: 'original-job', case_id: 'case-unit', kind: 'analytic_compute', status: 'failed', attempt: 3, result: null, error_code: 'WORKER_INTERRUPTED'};
const receipt: JobRecoveryReceipt = {job_id: 'new-job', status: 'queued', retry_of: failed.id, attempt: 0};
const callback = async () => receipt;
const panel = (job: RecoveryJob, role?: 'owner' | 'analyst' | 'viewer') => renderToStaticMarkup(<JobPanel job={job} role={role} pending={false} error={null} onRefresh={() => {}} onRetry={callback} onResume={callback} onCancel={async () => {}} />);

test('owner and analyst can review retries only for real registered failed work; viewer and unknown roles have no mutations', () => {
  for (const role of ['owner', 'analyst'] as const) assert.match(panel(failed, role), />Retry<\/button>/);
  for (const role of ['viewer', undefined] as const) {
    assert.doesNotMatch(panel(failed, role), />Retry<\/button>|>Resume<\/button>|Request cancellation/);
    assert.doesNotMatch(panel({...failed, status: 'running'}, role), /Request cancellation/);
  }
  assert.doesNotMatch(panel({...failed, kind: 'not_a_registered_handler'}, 'owner'), />Retry<\/button>/);
  assert.doesNotMatch(panel({...failed, status: 'succeeded'}, 'owner'), />Retry<\/button>/);
  assert.match(panel({...failed, attempt: undefined}, 'analyst'), /disabled=""[^>]*>Retry<\/button>/);
});

test('resume is exposed only for the exact recorded follow-up missing-data checkpoint', () => {
  const waiting = {...failed, kind: 'followup_due', status: 'waiting_for_input', error_code: 'FOLLOWUP_DATA_REQUIRED'};
  assert.equal(jobRecoveryMode(waiting, 'analyst'), 'resume'); assert.match(panel(waiting, 'analyst'), />Resume<\/button>/);
  for (const job of [{...waiting, error_code: 'HANDLER_UNAVAILABLE'}, {...waiting, error_code: null}, {...waiting, kind: 'analytic_compute'}]) {
    assert.equal(jobRecoveryMode(job, 'owner'), null); assert.doesNotMatch(panel(job, 'owner'), />Resume<\/button>/); assert.match(panel(job, 'owner'), /no available resume command/);
  }
});

test('history and new-job relationships remain explicit, escaped and separate from a queued acceptance', () => {
  const html = renderToStaticMarkup(<JobPanel job={{...failed, id: receipt.job_id, retry_of: failed.id, status: 'queued', attempt: 0}} role="analyst" history={[{...failed, error_code: '<script>untrusted()</script>'}]} pending={false} error={null} onRefresh={() => {}} />);
  assert.match(html, /Retry of run original-job/); assert.match(html, /Current run new-job; status queued; attempt 0/);
  assert.match(html, /Original run history/); assert.match(html, /original-job<\/strong> · failed · attempt 3/); assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  const accepted = renderToStaticMarkup(<RecoveryAcceptance receipt={receipt} />);
  assert.match(accepted, /role="status"/); assert.match(accepted, /Retry started/); assert.match(accepted, /earlier result is still saved/); assert.doesNotMatch(accepted, /PASS|passed/);
});
test('recognized follow-up checkpoints expose only recorded domain state; missing or inconsistent results stay unknown', () => {
  const job = {...failed, kind: 'followup_due', status: 'succeeded', result: {id: 'followup-unit', state: 'compared'}};
  assert.deepEqual(recordedFollowupOutcome(job), {id: 'followup-unit', state: 'compared'});
  const html = renderToStaticMarkup(<FollowupJobOutcome job={job} />); assert.match(html, /Recorded follow-up followup-unit: compared/); assert.match(html, /does not prove the overall cause/); assert.doesNotMatch(html, /PASS|passed/);
  for (const result of [null, {id: 'followup-unit', state: 'waiting_for_data'}, {state: 'compared'}]) {
    const unknown = {...job, result}; assert.equal(recordedFollowupOutcome(unknown), null); assert.match(renderToStaticMarkup(<FollowupJobOutcome job={unknown} />), /result remains unknown/);
  }
});

test('real UI transport reuses the command key after a lost response, sends job attempt and accepts only the linked new queued job', async () => {
  const originalFetch = globalThis.fetch, seen: {path: string; headers: Headers; body: string}[] = [], identity: {current: CommandIdentity} = {current: null};
  globalThis.fetch = async (input, options) => {
    seen.push({path: String(input), headers: new Headers(options?.headers), body: String(options?.body)});
    if (seen.length === 1) throw new TypeError('Unit fixture simulates commit-then-lost-response');
    return new Response(JSON.stringify({data: receipt, meta: {request_id: 'unit-request'}}), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  try {
    const intent = {workspaceId: 'workspace-unit', caseId: 'case-unit', role: 'analyst' as const, csrf: 'unit-csrf', job: failed, mode: 'retry' as const, identity};
    await assert.rejects(recoverJob(intent), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
    const retainedKey = identity.current?.key; assert.ok(retainedKey);
    assert.deepEqual(await recoverJob(intent), receipt); assert.equal(identity.current, null);
    assert.equal(seen.length, 2); assert.equal(seen[0].headers.get('Idempotency-Key'), retainedKey); assert.equal(seen[1].headers.get('Idempotency-Key'), retainedKey);
    for (const call of seen) {assert.equal(call.path, '/api/v1/workspaces/workspace-unit/jobs/original-job/retry'); assert.equal(call.headers.get('X-Faultline-Revision'), '3'); assert.equal(call.headers.get('X-CSRF-Token'), 'unit-csrf'); assert.equal(call.body, '{}');}
  } finally {globalThis.fetch = originalFetch;}
});

test('resume submits an empty finite prerequisite list and stale-attempt errors remain errors with the uncertain identity retained', async () => {
  const originalFetch = globalThis.fetch, identity: {current: CommandIdentity} = {current: null}; let seen: {path: string; headers: Headers; body: string} | undefined;
  globalThis.fetch = async (input, options) => {seen = {path: String(input), headers: new Headers(options?.headers), body: String(options?.body)}; return new Response(JSON.stringify({error: {code: 'STALE_INPUTS', message: 'Job attempt changed.'}, meta: {request_id: 'unit-stale'}}), {status: 409, headers: {'Content-Type': 'application/json'}});};
  try {
    await assert.rejects(recoverJob({workspaceId: 'workspace-unit', caseId: 'case-unit', role: 'owner', csrf: 'unit-csrf', job: {...failed, kind: 'followup_due', status: 'waiting_for_input', error_code: 'FOLLOWUP_DATA_REQUIRED'}, mode: 'resume', identity}), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'STALE_INPUTS');
    assert.equal(seen?.path, '/api/v1/workspaces/workspace-unit/jobs/original-job/resume'); assert.equal(seen?.headers.get('X-Faultline-Revision'), '3'); assert.deepEqual(JSON.parse(seen!.body), {prerequisite_ids: []}); assert.ok(identity.current?.key);
  } finally {globalThis.fetch = originalFetch;}
});

test('unknown roles, unsupported waiting handlers and cross-case jobs cannot issue a transport call; an unlinked response never means accepted', async () => {
  const originalFetch = globalThis.fetch, identity: {current: CommandIdentity} = {current: null}; let calls = 0;
  globalThis.fetch = async () => {calls++; return new Response(JSON.stringify({data: {...receipt, retry_of: 'wrong-original'}}), {status: 200, headers: {'Content-Type': 'application/json'}});};
  try {
    const intent = {workspaceId: 'workspace-unit', caseId: 'case-unit', csrf: 'unit-csrf', job: failed, mode: 'retry' as const, identity};
    await assert.rejects(recoverJob({...intent, role: undefined}), /Refresh this run/);
    await assert.rejects(recoverJob({...intent, role: 'owner', job: {...failed, case_id: 'other-case'}}), /Refresh this run/);
    await assert.rejects(recoverJob({...intent, role: 'owner', mode: 'resume', job: {...failed, status: 'waiting_for_input', error_code: 'HANDLER_UNAVAILABLE'}}), /Refresh this run/);
    assert.equal(calls, 0);
    await assert.rejects(recoverJob({...intent, role: 'owner'}), /did not return a new queued run/); assert.equal(calls, 1); assert.ok(identity.current?.key);
  } finally {globalThis.fetch = originalFetch;}
});

test('stream success metadata cannot override a failed authoritative JSON result or promote a passing badge', () => {
  const stream: JobStreamView = {connection: {state: 'connected', cursor: '42'}, lastEvent: {id: '42', status: 'succeeded', created_at: '2026-10-12T10:00:00.123456Z'}, lastJobReadAt: '2026-10-12T10:00:01.000Z'};
  const html = renderToStaticMarkup(<JobPanel job={failed} role="analyst" stream={stream} pending={false} error={null} onRefresh={() => {}} onRetry={callback} />);
  assert.match(html, /aria-label="Progress connection"/); assert.match(html, /data-event-cursor="42"/); assert.match(html, /Live updates: Connected/); assert.match(html, /The run failed/); assert.match(html, />Retry<\/button>/); assert.doesNotMatch(html, /Finished|status good|PASS/);
  assert.match(html, /Connection details/);
});

test('disconnected progress keeps only explicitly last-known status and hides commands until JSON authority is refreshed', () => {
  const stream: JobStreamView = {connection: {state: 'reconnecting', cursor: '8', reason: '<script>untrusted transport data</script>'}, lastEvent: {id: '8', status: 'running', attempt: 1, created_at: '2026-10-12T10:00:00.123456Z'}, lastJobReadAt: null};
  const html = renderToStaticMarkup(<JobPanel job={{...failed, status: 'running'}} role="owner" stream={stream} authority="unknown" pending={false} error={null} onRefresh={() => {}} onCancel={async () => {}} />);
  assert.match(html, /Disconnected; reconnecting/); assert.match(html, /Progress may be out of date/); assert.match(html, /displayed status is last known\s+and may be stale/); assert.match(html, /still checking the saved\s+run/); assert.doesNotMatch(html, /Request cancellation|>Retry<\/button>|>Resume<\/button>|<script>/); assert.match(html, /&lt;script&gt;/);
});

test('access closure hides stale job, domain references and original history even if a caller supplies cached records', () => {
  const cached = {...failed, id: 'private-cached-job', status: 'succeeded', result: {snapshot_id: 'private-snapshot-id'}};
  const stream: JobStreamView = {connection: {state: 'access_closed', cursor: '19'}, lastEvent: {id: '19', status: 'succeeded', created_at: '2026-10-12T10:00:00.123456Z'}, lastJobReadAt: '2026-10-12T10:00:01.000Z'};
  const html = renderToStaticMarkup(<JobPanel job={cached} role="owner" stream={stream} history={[failed]} pending={false} error={new Error('Current job access closed')} onRefresh={() => {}} onCancel={async () => {}} onRetry={callback} onResume={callback} />);
  assert.match(html, /Live updates: Access closed/); assert.match(html, /Cleared when access closed/); assert.match(html, /outcome is unknown/); assert.doesNotMatch(html, /private-cached-job|private-snapshot-id|original-job|Original run history|Finished|Request cancellation|>Retry<\/button>|>Resume<\/button>/);
});

test('traffic-mix warning uses the plain summary without changing retained comparison data',()=>{
 const rate=(eligible:number,converted:number)=>({eligible,converted,rate:converted/eligible,interval:null});
 const value:Comparison={id:'comparison',revision_id:'revision',metric_hash:'a'.repeat(64),snapshot_hash:'b'.repeat(64),freshness:'fresh',value:{metric_hash:'a'.repeat(64),quality:'complete_attested',basis:'operator_attestation',baseline:{...rate(1000,340),strata:{mobile:rate(200,20),desktop:rate(800,320)},unknown_cohort_count:0},comparison:{...rate(1000,160),strata:{mobile:rate(800,80),desktop:rate(200,80)},unknown_cohort_count:0},delta_pp:-18,relative_change:(160-340)/340},mix:{status:'complete',standardized_rate:0.34,within_component_pp:0,composition_component_pp:-18,baseline_weights:{mobile:0.2,desktop:0.8},missing_comparison_strata:[],comparison_only_strata:[],limitations:['Baseline-mix standardization is a descriptive accounting identity, not a causal contribution.']}};
 const original=JSON.stringify(value),html=renderToStaticMarkup(<ComparisonResult result={value}/>);
 assert.match(html,/Using the earlier group sizes does not prove the cause/);assert.doesNotMatch(html,/descriptive accounting identity|causal contribution/);assert.equal(JSON.stringify(value),original);
});
