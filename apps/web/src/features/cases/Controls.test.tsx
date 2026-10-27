import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {OperationLimits, PreflightResult, OperationAssessmentResult, SelectedOperationPreflight, operationPreflightPath, readOperationAssessment, type OperationSelection, type Preflight, type PreflightLimits} from './Controls';
import type {Investigation} from '../../api';
import type {OperationAssessment} from '../../../../../packages/core/src/preflight/assessment';

const limits: PreflightLimits = {
  source: {file_bytes: 52428800, expanded_bytes: 268435456, records: 4, files: 100, json_depth: 32, csv_field_bytes: 1048576},
  metric: {cohorts: 8, period_days: 31, horizon_seconds: 1800},
  storage: {ceiling_bytes: 1073741824, used_bytes: null, reserved_bytes: null, remaining_bytes: null},
  model: {automatic_calls: 0, input_tokens: 64, output_tokens: 32, call_timeout_seconds: 90},
  jobs: {source_capture_deadline_seconds: 1800, workspace_concurrency: 1, installation_concurrency: 2, cancel_poll_seconds: 2},
  browser: {enabled: false, task_timeout_seconds: 600, matrix_cells: 6, repeats_per_cell: 3, actions_per_cell: 30, artifact_bytes: 104857600}
};
const prerequisite: Preflight = {case_id: 'case-unit', revision_id: 'revision-unit', manual: true, metric: 'Not frozen', snapshot: 'Absent', active_work: false, model: 'none', runner: 'disabled', quality: 'Inputs still require review.'};

test('missing effective caps, usage and selected input stay unknown without inferred unused capacity', () => {
  const html = renderToStaticMarkup(<OperationLimits usage={{work_units: null, model: null}} selectedInput={{snapshot_id: null, records: null}} />);
  assert.match(html, /Limits are unknown/); assert.match(html, /Record limit per capture<\/dt><dd>Unknown/); assert.match(html, /Selected snapshot records<\/span><strong>Unknown/);
  assert.match(html, /Storage remaining<\/dt><dd>Unknown/); assert.match(html, /Model calls spent<\/dt><dd>Unknown/); assert.match(html, /Runs remaining<\/dt><dd>Unknown/);
  assert.doesNotMatch(html, /<dd>0(?: |<)|status good|>PASS<|>Healthy</); assert.match(html, /Missing usage is unknown/);
});

test('effective smaller workspace caps and disabled browser are shown exactly rather than installation defaults or activation controls', () => {
  const html = renderToStaticMarkup(<OperationLimits limits={limits} selectedInput={{snapshot_id: 'snapshot-unit', records: 3}} />);
  assert.match(html, /Record limit per capture<\/dt><dd>4/); assert.doesNotMatch(html, /Record limit per capture<\/dt><dd>100,000/);
  assert.match(html, /Total model wire attempts per revision<\/dt><dd>0/); assert.match(html, /Model input-token ceiling<\/dt><dd>64/);
  assert.match(html, /52,428,800 bytes \(50 MiB\)/); assert.match(html, /Days per metric period<\/dt><dd>31 days/); assert.match(html, /Conversion observation horizon<\/dt><dd>1,800 seconds/);
  assert.match(html, /Selected snapshot records<\/span><strong>3/); assert.match(html, /Browser tests<\/dt><dd>Disabled/); assert.doesNotMatch(html, /<button|>PASS<|status good/);
});

test('nullable ledgers are not derived from ceilings; explicitly observed zero usage remains zero', () => {
  const html = renderToStaticMarkup(<OperationLimits limits={limits} usage={{work_units: {ceiling: 12, spent: 0, reserved: 2, remaining: 10}, model: {calls_spent: 0, calls_reserved: 0, input_spent: 0, input_reserved: 0, output_spent: 0, output_reserved: 0}}} />);
  assert.match(html, /Investigation storage limit<\/dt><dd>1,073,741,824 bytes \(1 GiB\)/); assert.match(html, /Storage used<\/dt><dd>Unknown/); assert.match(html, /Storage reserved<\/dt><dd>Unknown/); assert.match(html, /Storage remaining<\/dt><dd>Unknown/);
  assert.match(html, /Runs used<\/dt><dd>0/); assert.match(html, /Runs remaining<\/dt><dd>10/); assert.match(html, /Model calls spent<\/dt><dd>0/); assert.match(html, /neither is a currency estimate/);
  const invalid = renderToStaticMarkup(<OperationLimits limits={{...limits, source: {...limits.source, records: Number.NaN}, storage: {...limits.storage, used_bytes: -1}}} />); assert.match(invalid, /Record limit per capture<\/dt><dd>Unknown/); assert.match(invalid, /Storage used<\/dt><dd>Unknown/);
});

test('prerequisite strings are escaped data and configuration does not promote health, coverage or verification truth', () => {
  const html = renderToStaticMarkup(<PreflightResult value={{...prerequisite, model: '<a href="https://untrusted.invalid">provider</a>', quality: '<script>claimPassing()</script>', revision_id: '<b>revision</b>', limits}} />);
  assert.doesNotMatch(html, /<script>|<a href=|<b>revision/); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;a href=/); assert.match(html, /&lt;b&gt;revision/);
  assert.match(html, /Ready settings do not mean a test has passed/); assert.match(html, /Browser limits do not activate a runner, approve a target or reduce required controls/); assert.doesNotMatch(html, /status good|>PASS</);
});

test('token counters are conservative budget charges and source-capture timeout is not promoted into a general job deadline', () => {
  const html = renderToStaticMarkup(<OperationLimits limits={limits} usage={{work_units: null, model: {calls_spent: 1, calls_reserved: 0, input_spent: 48, input_reserved: 16, output_spent: 12, output_reserved: 4}}} />);
  assert.match(html, /Input-token budget charged<\/dt><dd>48/); assert.match(html, /Output-token budget charged<\/dt><dd>12/); assert.match(html, /conservative budget charges and reservations/); assert.match(html, /Provider-reported token usage is unavailable/);
  assert.doesNotMatch(html, /Model input tokens spent|Model output tokens spent/);
  assert.match(html, /Source-capture deadline<\/dt><dd>1,800 seconds/); assert.match(html, /General run deadline<\/dt><dd>Unknown — no general timeout supplied/); assert.match(html, /renewable worker leases do not establish a general timeout/); assert.doesNotMatch(html, /Active run deadline/);
});

const wid = '11111111-1111-4111-8111-111111111111', cid = '22222222-2222-4222-8222-222222222222', revision = '33333333-3333-4333-8333-333333333333', resourceId = '44444444-4444-4444-8444-444444444444';
const base = `/api/v1/workspaces/${wid}/cases/${cid}`, bindingHash = 'b'.repeat(64);
const input = {id: resourceId, hash: bindingHash, revision_id: revision, frozen: true, freshness: 'current' as const};
const choice: OperationSelection = {operation: 'analytic', objective: '', hypothesis_id: '', analytic_plan_id: '', candidate_id: '', mechanism_result_id: '', plan_id: '', grant_id: '', approval_id: ''};
// Independently authored contract DTOs; no server assessment function is used
// to generate their expected statuses or prerequisites.
const assessment: OperationAssessment = {
  operation: 'analytic', status: 'blocked', revision_id: revision,
  prerequisites: [{code: 'METRIC_FROZEN', status: 'missing', detail: 'Select a frozen metric.'}, {code: 'SNAPSHOT_FROZEN', status: 'ready', detail: 'The frozen snapshot matches this revision.'}],
  selected_input: {metric: {id: null, hash: null, revision_id: null, frozen: null, freshness: 'unknown'}, snapshot: {...input, records: 120}},
  admission: {workspace_active: null, installation_active: 0, workspace_limit: 1, installation_limit: 2},
  capabilities: {runner: {configured: false, status: 'unavailable', current_recorded_binding: null, readiness: 'blocked'}, model: {configured: false, status: 'unconfigured', current_recorded_binding: null, readiness: 'blocked'}},
  required_work_units: 1, optional_model_calls: 0, expected_observations: null, browser_limits: null, requested_storage_bytes: null, requested_duration_seconds: null, assessment_scope: 'prerequisites_only', admission_reserved: false
};

test('missing frozen metric blocks the displayed assessment without calling readiness a result or reserving unknown capacity', () => {
  const html = renderToStaticMarkup(<OperationAssessmentResult assessment={assessment} />);
  assert.match(html, /data-prerequisite-code="METRIC_FROZEN"/); assert.match(html, /missing<\/span>/); assert.match(html, /Select a frozen metric/); assert.match(html, /blocked<\/span>/);
  assert.match(html, /Workspace active work<\/dt><dd>Unknown/); assert.match(html, /Installation active work<\/dt><dd>0/); assert.match(html, /Requested storage estimate<\/dt><dd>Unknown/); assert.match(html, /Requested duration estimate<\/dt><dd>Unknown/);
  assert.match(html, /Ready does not mean the test passed/); assert.match(html, /nothing runs from this check/); assert.doesNotMatch(html, /status good|>PASS<|<button/);
});

test('provisional conversion-tail coverage, unknown admission and absent optional model remain distinct actual facts', () => {
  const value: OperationAssessment = {...assessment, selected_input: {metric: input, snapshot: {...input, records: null}}, prerequisites: [
    {code: 'COVERAGE_TAIL', status: 'blocked', detail: 'The declared event watermark does not cover the conversion observation tail.', binding: {coverage_basis: 'lateness_assumption'}},
    {code: 'DATA_QUALITY', status: 'unknown', detail: 'Provisional extraction cannot establish complete source coverage.'},
    {code: 'WORKSPACE_CAPACITY', status: 'unknown', detail: 'Current workspace activity is not available.'}
  ]};
  const html = renderToStaticMarkup(<OperationAssessmentResult assessment={value} />);
  assert.match(html, /conversion observation tail/); assert.match(html, /Provisional extraction/); assert.match(html, /lateness_assumption/); assert.match(html, /Recorded rows<\/dt><dd>Unknown/);
  assert.match(html, /Optional model capability/); assert.match(html, /Recorded availability<\/dt><dd>unconfigured/); assert.match(html, /Optional model calls required<\/dt><dd>0/); assert.match(html, /Configuration and recorded availability are separate/);
  assert.match(html, /Unknown capacity and estimates remain unknown/); assert.doesNotMatch(html, /status good|>PASS<|Complete coverage/);
});

test('plan preparation readiness does not invent approval or execution; browser run exposes missing and stale exact controls', () => {
  const ready: OperationAssessment = {...assessment, operation: 'browser_plan', status: 'ready', required_work_units: 0, prerequisites: [{code: 'BROWSER_OBJECTIVE', status: 'ready', detail: 'The protected mechanism objective requires twelve observations.'}, {code: 'HYPOTHESIS_CURRENT', status: 'ready', detail: 'Current reviewed hypothesis.'}], expected_observations: 12, browser_limits: {task_timeout_seconds: 600, artifact_bytes: 104857600}};
  const planned = renderToStaticMarkup(<OperationAssessmentResult assessment={ready} />); assert.match(planned, /Prepare browser test/); assert.match(planned, /Required work units<\/dt><dd>0/); assert.match(planned, /nothing runs from this check/); assert.match(planned, /Required protected observations<\/dt><dd>12/); assert.doesNotMatch(planned, /PLAN APPROVAL CURRENT|TARGET GRANT CURRENT|Approve|Execute|status good/);
  const running: OperationAssessment = {...ready, operation: 'browser_run', status: 'blocked', required_work_units: 1, expected_observations: 18, prerequisites: [{code: 'PLAN_APPROVAL_CURRENT', status: 'missing', detail: 'Explicit approval of the exact immutable plan is required.'}, {code: 'TARGET_GRANT_CURRENT', status: 'stale', detail: 'The target grant is expired.'}]};
  const run = renderToStaticMarkup(<OperationAssessmentResult assessment={running} />); assert.match(run, /PLAN APPROVAL CURRENT/); assert.match(run, /missing<\/span>/); assert.match(run, /expired/); assert.match(run, /stale<\/span>/); assert.match(run, /Required protected observations<\/dt><dd>18/); assert.match(run, /Admission reserved<\/dt><dd>No/);
});

test('untrusted prerequisite details, selected inputs and binding strings render as escaped data', () => {
  const value: OperationAssessment = {...assessment, prerequisites: [{code: 'EVIDENCE_CURRENT', status: 'stale', detail: '<script>changeProtectedTruth()</script>', binding: {source_ref: '<img src=x onerror=run()>', approved: false, size_bytes: null}}], selected_input: {...assessment.selected_input, metric: {...input, id: '<a href="https://untrusted.invalid">metric</a>'}}};
  const html = renderToStaticMarkup(<OperationAssessmentResult assessment={value} />); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/); assert.match(html, /&lt;a href=/); assert.doesNotMatch(html, /<script>|<img|<a href=/); assert.match(html, /size bytes<\/dt><dd>Unknown/); assert.match(html, /approved<\/dt><dd>No/);
});

test('finite query construction sends only applicable named resource IDs and rejects URLs or expressions before transport', () => {
  const extras = {...choice, objective: 'correction', hypothesis_id: resourceId, analytic_plan_id: resourceId, candidate_id: resourceId, mechanism_result_id: resourceId, plan_id: resourceId, grant_id: resourceId, approval_id: resourceId, target_url: 'https://external.invalid'} as OperationSelection;
  assert.equal(operationPreflightPath(base, extras), base + '/preflight?operation=analytic&hypothesis_id=' + resourceId + '&analytic_plan_id=' + resourceId);
  const plan = new URL(operationPreflightPath(base, {...extras, operation: 'browser_plan'}), 'http://localhost:3000'); assert.deepEqual([...plan.searchParams.keys()], ['operation', 'objective', 'hypothesis_id', 'candidate_id', 'mechanism_result_id']); assert.equal(plan.searchParams.get('objective'), 'correction');
  const mechanism = new URL(operationPreflightPath(base, {...extras, operation: 'browser_plan', objective: 'mechanism'}), 'http://localhost:3000'); assert.deepEqual([...mechanism.searchParams.keys()], ['operation', 'objective', 'hypothesis_id']);
  const run = new URL(operationPreflightPath(base, {...extras, operation: 'browser_run'}), 'http://localhost:3000'); assert.deepEqual([...run.searchParams.keys()], ['operation', 'objective', 'hypothesis_id', 'candidate_id', 'mechanism_result_id', 'plan_id', 'grant_id', 'approval_id']);
  assert.throws(() => operationPreflightPath('https://external.invalid', choice), /finite operation/); assert.throws(() => operationPreflightPath(base, {...choice, operation: 'browser_run', plan_id: 'https://external.invalid'}), /UUIDs, not URLs or expressions/); assert.throws(() => operationPreflightPath(base, {...choice, operation: 'browser_plan', objective: 'execute(anything)' as 'mechanism'}), /finite mechanism or correction/);
});

test('the selected assessment transport is exactly one scoped GET, with no admission, model or mutation request', async () => {
  const originalFetch = globalThis.fetch, calls: {path: string; options: RequestInit | undefined}[] = [];
  globalThis.fetch = async (path, options) => {calls.push({path: String(path), options}); return new Response(JSON.stringify({data: {...prerequisite, case_id: cid, assessment}, meta: {request_id: 'unit-preflight'}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    assert.deepEqual(await readOperationAssessment(base, cid, choice, new AbortController().signal, revision), assessment); assert.equal(calls.length, 1); assert.equal(calls[0].path, base + '/preflight?operation=analytic'); assert.equal(calls[0].options?.method, 'GET'); assert.equal(calls[0].options?.credentials, 'same-origin'); assert.equal(calls[0].options?.body, undefined);
    const headers = new Headers(calls[0].options?.headers); assert.equal(headers.has('Idempotency-Key'), false); assert.equal(headers.has('X-CSRF-Token'), false); assert.equal(headers.has('X-Faultline-Revision'), false);
  } finally {globalThis.fetch = originalFetch;}
});

test('a foreign case, changed input revision, reserved admission or incomplete successful response cannot become an assessment', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const data of [{...prerequisite, case_id: wid, assessment}, {...prerequisite, case_id: cid, assessment: {...assessment, revision_id: resourceId}}, {...prerequisite, case_id: cid, assessment: {...assessment, admission_reserved: true}}, {...prerequisite, case_id: cid}, {...prerequisite, case_id: cid, assessment: {...assessment, status: 'PASS'}}]) {
      globalThis.fetch = async () => new Response(JSON.stringify({data}), {headers: {'Content-Type': 'application/json'}});
      await assert.rejects(readOperationAssessment(base, cid, choice, new AbortController().signal, revision), /unavailable or incomplete|input revision changed/);
    }
  } finally {globalThis.fetch = originalFetch;}
});

test('the operation form is read-only and offers finite checks without execution or approval controls', () => {
  const item = {id: cid, workspace_id: wid, active_revision_id: revision, revision: 1} as Investigation;
  const html = renderToStaticMarkup(<SelectedOperationPreflight base={base} item={item} />); assert.match(html, />Action<\/label>/); assert.match(html, /value="analytic"/); assert.match(html, /value="browser_plan"/); assert.match(html, /value="browser_run"/); assert.match(html, /Check requirements/); assert.match(html, /does not start anything/); assert.doesNotMatch(html, /Approve|Execute plan|Start runner|Request model|status good|>PASS</);
});
