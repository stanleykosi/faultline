import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityFilters, activityScope, activityQuery} from './activity-filter.js';
import {encodeCursor, decodeCursor} from '../cases/cursor.js';
import {DomainError} from '../errors.js';
import {assessOperation, type OperationAssessmentFacts, type PrerequisiteFact, type SelectedInputFact} from '../preflight/assessment.js';
import {operationSelection} from '../preflight/service.js';

// activity filter
const cid='70217a64-adac-42a9-a838-34a63792641a', other='4dc4a8f8-d42d-421a-9c85-ea0c622aabf7', actor='Aa1_'.repeat(8);
const fails=(action:()=>unknown,code:string)=>assert.throws(action,(error:unknown)=>error instanceof Error && 'code' in error && error.code===code);

test("activity queries bind exact workspace, principal and case", () => {
 // audit case filter is an exact bound JSON case identity, with no unrelated rows clause
 {
  const q=activityQuery('workspace','owner',true,activityFilters({case_id:cid},true),null);
     assert.equal(q.text,'SELECT * FROM faultline.audit WHERE workspace_id=$1 AND details->>\'case_id\'=$2::text ORDER BY created_at,id LIMIT $3');
     assert.deepEqual(q.values,['workspace',cid,51]);
     const absent=activityQuery('workspace','owner',true,activityFilters({case_id:other},true),null);
     assert.equal(absent.values[1],other); assert.notDeepEqual(absent.values,q.values);
 }
 // notification case filter always retains exact workspace and current principal
 {
  const q=activityQuery('workspace','viewer',false,activityFilters({case_id:cid,limit:1},false),null);
     assert.equal(q.text,'SELECT * FROM faultline.notifications WHERE workspace_id=$1 AND user_id=$2 AND case_id=$3::uuid ORDER BY created_at,id LIMIT $4');
     assert.deepEqual(q.values,['workspace','viewer',cid,2]);
     const noFilter=activityQuery('workspace','viewer',false,activityFilters({},false),null);
     assert.match(noFilter.text,/workspace_id=\$1 AND user_id=\$2/);
 }
});

test("owner actor/action filters preserve exact identity and reject unauthorized selectors", () => {
 // owner actor filter preserves opaque case-sensitive identity with case/action/half-open time
 {
  const filters=activityFilters({case_id:cid,actor_id:actor,action:'case.close',from:'2026-10-13T09:00:00Z',to:'2026-10-14T09:00:00Z',limit:1},true);
     assert.equal(filters.actor_id,actor);
     const q=activityQuery('workspace','owner',true,filters,null);
     assert.equal(q.text,'SELECT * FROM faultline.audit WHERE workspace_id=$1 AND details->>\'case_id\'=$2::text AND actor_id=$3::text AND operation=$4::text AND created_at>=$5::timestamptz AND created_at<$6::timestamptz ORDER BY created_at,id LIMIT $7');
     assert.deepEqual(q.values,['workspace',cid,actor,'case.close','2026-10-13T09:00:00.000000Z','2026-10-14T09:00:00.000000Z',2]);
     assert.ok(!q.text.includes(actor));
 }
 // invalid actor IDs are denied and personal activity cannot request or bind any actor selector
 {
  for(const value of ['',"x' OR true",actor+'!', 'x'.repeat(129),null,[]]) fails(()=>activityFilters({actor_id:value as string},true),'INVALID_ACTOR_ID');
     fails(()=>activityFilters({actor_id:actor},false),'INVALID_QUERY');
     fails(()=>activityFilters({actor_id:undefined},false),'INVALID_QUERY');
     fails(()=>activityQuery('workspace','viewer',false,activityFilters({actor_id:actor},true),null),'INVALID_QUERY');
 }
 // declared action and retained operation alias have identical canonical cursor scope
 {
  const a=activityFilters({action:'case.close'},true),b=activityFilters({operation:'case.close'},true);
     assert.deepEqual(a,b); assert.deepEqual(activityScope('w','p',true,a),activityScope('w','p',true,b));
     assert.equal(activityFilters({action:'case.close',operation:'case.close'},true).action,'case.close');
     fails(()=>activityFilters({action:'case.close',operation:'case.reopen'},true),'CONFLICTING_FILTERS');
 }
});

test("activity bounds use UTC6 half-open time and reject invalid query values", () => {
 // audit time filters normalize offsets without losing microseconds and use half-open boundaries
 {
  const filters=activityFilters({from:'2026-10-13T10:00:00.000001+01:00',to:'2026-10-13T10:00:00.000002+01:00',action:"x' OR true --"},true);
     assert.equal(filters.from,'2026-10-13T09:00:00.000001Z');
     assert.equal(filters.to,'2026-10-13T09:00:00.000002Z');
     const q=activityQuery('w','p',true,filters,{created_at:'2026-10-13T09:00:00.000001Z',id:cid});
     assert.match(q.text,/operation=\$2::text AND created_at>=\$3::timestamptz AND created_at<\$4::timestamptz AND \(created_at,id\)>\(\$5::timestamptz,\$6::uuid\)/);
     assert.ok(!q.text.includes("x' OR true")); assert.equal(q.values[1],"x' OR true --");
 }
 // invalid identifiers, calendar dates, unsupported precision and reversed intervals fail before query
 {
  for(const value of ['',"x' OR true",cid+'tail',null,[]]) fails(()=>activityFilters({case_id:value as string},true),'INVALID_CASE_ID');
     for(const value of ['2026-02-30T00:00:00Z','2026-10-13T09:00:00','2026-10-13T09:00:00-00:00','2026-10-13T09:00:00.0000001Z']) fails(()=>activityFilters({from:value},true),'INVALID_INTERVAL');
     for(const to of ['2026-10-13T09:00:00Z','2026-10-13T08:00:00Z']) fails(()=>activityFilters({from:'2026-10-13T09:00:00Z',to},true),'INVALID_INTERVAL');
 }
 // undeclared activity filters, repeated/nonstring values and invalid limits cannot silently disappear
 {
  fails(()=>activityFilters({action:'case.close'},false),'INVALID_QUERY');
     fails(()=>activityFilters({from:'2026-10-13T09:00:00Z'},false),'INVALID_QUERY');
     fails(()=>activityFilters({arbitrary:'value'} as never,true),'INVALID_QUERY');
     fails(()=>activityFilters({action:['case.close'] as never},true),'INVALID_ACTION');
     for(const limit of [0,201,1.5,NaN,'1']) fails(()=>activityFilters({limit:limit as number},true),'INVALID_LIMIT');
 }
});

test('signed pagination cursor rejects changed case, actor, action, interval, principal, workspace and authority',()=>{
  const filters=activityFilters({case_id:cid,actor_id:actor,action:'case.close',from:'2026-10-13T09:00:00Z'},true),scope=activityScope('w','p',true,filters);
  const token=encodeCursor(scope,{created_at:'2026-10-13T09:00:00.000001Z',id:cid});
  assert.deepEqual(decodeCursor(token,scope),{created_at:'2026-10-13T09:00:00.000001Z',id:cid});
  fails(()=>decodeCursor(token.slice(0,-3)+'xxx',scope),'INVALID_CURSOR');
  for(const changed of [{...scope,case_id:other},{...scope,actor_id:other},{...scope,actor_id:null},{...scope,action:'case.reopen'},{...scope,from:'2026-10-13T08:00:00.000000Z'},{...scope,pid:'other'},{...scope,wid:'other'},{...scope,ownerAudit:false}]) fails(()=>decodeCursor(token,changed),'INVALID_CURSOR');
  const equivalent=activityScope('w','p',true,activityFilters({case_id:cid.toUpperCase(),actor_id:actor,operation:'case.close',from:'2026-10-13T10:00:00+01:00',limit:10},true));
  assert.equal(decodeCursor(token,equivalent)?.id,cid);
  const changedCase=activityScope('w','p',true,activityFilters({case_id:cid,actor_id:actor.toUpperCase(),action:'case.close',from:'2026-10-13T09:00:00Z'},true));
  assert.notEqual(changedCase.actor_id,actor);
  fails(()=>decodeCursor(token,changedCase),'INVALID_CURSOR');
});

// assessment
// Independent prerequisite expectations from J010A, not observed application outputs.
const revision = 'generated-current-revision';
const ready: PrerequisiteFact = {status: 'ready', detail: 'Independent scoped fixture attests this prerequisite.', binding: {revision_id: revision}};
const frozen: SelectedInputFact = {id: 'generated-selected-input', hash: 'a'.repeat(64), revision_id: revision, frozen: true, freshness: 'current'};
function analytic(): Extract<OperationAssessmentFacts, {operation: 'analytic'}> {return {operation: 'analytic', revision_id: revision, metric: {...frozen}, snapshot: {...frozen, records: 0}, prerequisites: [], admission: {workspace_active: 0, installation_active: 0, workspace_limit: 1, installation_limit: 2}, capabilities: {runner: {configured: false, status: 'unconfigured', current_recorded_binding: null}, model: {configured: false, status: 'unconfigured', current_recorded_binding: null}}, coverage: {baseline: ready, comparison: ready, tail: ready, quality: ready}};}
function browser(operation: 'browser_plan' | 'browser_run'): Extract<OperationAssessmentFacts, {operation: 'browser_plan' | 'browser_run'}> {const base = analytic(); return {operation, revision_id: base.revision_id, metric: base.metric, snapshot: {...base.snapshot, records: 4}, prerequisites: [], admission: base.admission, capabilities: {runner: {configured: true, status: 'available', current_recorded_binding: true}}, browser: {objective: 'mechanism', limits: {task_timeout_seconds: 600, artifact_bytes: 104857600}, hypothesis: ready, evidence: ready, plan: {...frozen}, reviewed_plan: ready, trusted_provenance: ready, current_grant: {status: 'missing', detail: 'No owner grant has been created.'}, current_approval: {status: 'missing', detail: 'No immutable run approval has been created.'}}};}
const state = (result: ReturnType<typeof assessOperation>, code: string) => result.prerequisites.find(value => value.code === code)?.status;

test('deterministic analytics needs current frozen inputs and both covered windows plus tail; absent model/runner cannot block it', () => {
 const input = analytic(), before = structuredClone(input), output = assessOperation(input); assert.equal(output.status, 'ready'); assert.equal(output.optional_model_calls, 0); assert.equal(output.required_work_units, 1); assert.equal(output.selected_input.snapshot.records, 0); assert.equal(output.capabilities.model?.readiness, 'blocked'); assert.equal(output.requested_duration_seconds, null); assert.equal(output.requested_storage_bytes, null); assert.equal(output.admission_reserved, false); assert.equal(output.assessment_scope, 'prerequisites_only'); assert.deepEqual(input, before);
 for (const [key, status] of [['baseline', 'missing'], ['comparison', 'blocked'], ['tail', 'missing'], ['quality', 'blocked']] as const) {const changed = analytic(); changed.coverage[key] = {status, detail: 'Missing coverage, incomplete tail, received-only coverage or provisional quality never establishes readiness.'}; assert.equal(assessOperation(changed).status, 'blocked');}
 const changedRevision = analytic(); changedRevision.metric.revision_id = 'old-revision'; assert.equal(state(assessOperation(changedRevision), 'METRIC_FROZEN'), 'stale');
 const expired = analytic(); expired.snapshot.freshness = 'stale'; assert.equal(state(assessOperation(expired), 'SNAPSHOT_FROZEN'), 'stale');
 const changedBinding = analytic(); changedBinding.coverage.tail = {...ready, binding: {revision_id: 'old-revision'}}; assert.equal(state(assessOperation(changedBinding), 'COVERAGE_TAIL'), 'stale');
 const unknown = analytic(); unknown.coverage.tail = {status: 'unknown', detail: 'No event watermark record is available.'}; assert.equal(assessOperation(unknown).status, 'unknown');
 const busy = analytic(); busy.admission.workspace_active = 1; assert.equal(state(assessOperation(busy), 'WORKSPACE_CAPACITY'), 'blocked'); const unknownAdmission = analytic(); unknownAdmission.admission.installation_active = null; assert.equal(assessOperation(unknownAdmission).status, 'unknown');
 for (const bad of [NaN, -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {const invalid = analytic(); invalid.admission.workspace_active = bad; assert.throws(() => assessOperation(invalid), error => error instanceof DomainError && error.code === 'INVALID_PREFLIGHT_FACTS');}
 const duplicated = analytic(); duplicated.prerequisites = [{code: 'CURRENT_AUTHORITY', ...ready}, {code: 'CURRENT_AUTHORITY', status: 'blocked', detail: 'Authority was revoked.'}]; assert.throws(() => assessOperation(duplicated), error => error instanceof DomainError && error.code === 'DUPLICATE_PREFLIGHT_PREREQUISITE');
});
test('browser planning excludes run grant/approval while execution requires all current reviewed provenance and authority; protected12/18 policies remain intact', () => {
 const plan = browser('browser_plan'), output = assessOperation(plan); assert.equal(output.status, 'ready'); assert.equal(output.required_work_units, 0); assert.equal(output.expected_observations, 12); assert.deepEqual(output.browser_limits, {task_timeout_seconds: 600, artifact_bytes: 104857600}); assert.equal(output.prerequisites.some(value => ['PLAN_REVIEWED', 'TARGET_GRANT_CURRENT', 'PLAN_APPROVAL_CURRENT'].includes(value.code)), false);
 const run = browser('browser_run'); assert.equal(assessOperation(run).status, 'blocked'); assert.equal(state(assessOperation(run), 'TARGET_GRANT_CURRENT'), 'missing'); run.browser.current_grant = ready; run.browser.current_approval = ready; assert.equal(assessOperation(run).status, 'ready'); assert.equal(assessOperation(run).required_work_units, 1);
 const busyPlan = structuredClone(plan); busyPlan.admission.workspace_active = 1; busyPlan.admission.installation_active = 2; busyPlan.prerequisites = [{code: 'BUDGET_AVAILABLE', status: 'blocked', detail: 'The revision job work-unit allowance is exhausted.'}]; const preparedWhileBusy = assessOperation(busyPlan); assert.equal(preparedWhileBusy.status, 'ready'); assert.equal(preparedWhileBusy.required_work_units, 0); assert.equal(preparedWhileBusy.admission.workspace_active, 1); assert.equal(preparedWhileBusy.admission.installation_active, 2); assert.equal(preparedWhileBusy.prerequisites.some(value => ['BUDGET_AVAILABLE', 'WORKSPACE_CAPACITY', 'INSTALLATION_CAPACITY'].includes(value.code)), false); const busyRun = structuredClone(run); busyRun.admission = busyPlan.admission; busyRun.prerequisites = busyPlan.prerequisites; assert.equal(assessOperation(busyRun).status, 'blocked'); assert.equal(state(assessOperation(busyRun), 'WORKSPACE_CAPACITY'), 'blocked'); assert.equal(state(assessOperation(busyRun), 'BUDGET_AVAILABLE'), 'blocked');
 for (const key of ['reviewed_plan', 'trusted_provenance', 'current_grant', 'current_approval'] as const) {const changed = structuredClone(run); changed.browser[key] = {status: 'stale', detail: 'The exact plan authorization/provenance binding was revoked or changed.'}; assert.equal(assessOperation(changed).status, 'blocked');}
 const unknownRunner = structuredClone(run); unknownRunner.capabilities.runner.current_recorded_binding = null; assert.equal(assessOperation(unknownRunner).status, 'unknown'); const staleRunner = structuredClone(run); staleRunner.capabilities.runner.current_recorded_binding = false; assert.equal(state(assessOperation(staleRunner), 'RUNNER_AVAILABLE'), 'stale');
 const correction = browser('browser_plan'); correction.browser.objective = 'correction'; assert.equal(assessOperation(correction).status, 'unknown'); assert.equal(assessOperation(correction).expected_observations, 18); correction.browser.candidate = ready; correction.browser.mechanism_result = ready; assert.equal(assessOperation(correction).status, 'ready');
 const frozenInput = structuredClone(run); Object.freeze(frozenInput.browser.limits); Object.freeze(frozenInput.capabilities.runner); assert.equal(assessOperation(frozenInput).status, 'ready');
});

// service
const id='00000000-0000-4000-8000-000000000001';
test('operation selectors remain finite and plan preparation cannot borrow execution or foreign selectors',()=>{
 assert.deepEqual(operationSelection({}),{});assert.deepEqual(operationSelection({operation:'analytic',analytic_plan_id:id}),{operation:'analytic',analytic_plan_id:id});
 assert.deepEqual(operationSelection({operation:'browser_plan',objective:'correction',candidate_id:id}),{operation:'browser_plan',objective:'correction',candidate_id:id});
 for(const request of [{operation:['analytic','browser_run']},{operation:'analytic',target:'https://example.com'},{operation:'analytic',plan_id:id},{operation:'browser_plan',grant_id:id},{operation:'browser_run',analytic_plan_id:id},{operation:'browser_plan',objective:'mechanism',candidate_id:id},{hypothesis_id:id},{operation:'analytic',hypothesis_id:'../private'},null])assert.throws(()=>operationSelection(request));
});
