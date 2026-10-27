import {demand} from '../errors.js';

/** Server-scoped facts only. This assessment neither admits work nor proves a test outcome. */
export type AssessmentOperation = 'analytic' | 'browser_plan' | 'browser_run';
export type PrerequisiteStatus = 'ready' | 'missing' | 'stale' | 'blocked' | 'unknown';
export type AssessmentStatus = 'ready' | 'blocked' | 'unknown';
export type AssessmentBinding = Readonly<Record<string, string | number | boolean | null>>;
export const supplementalPrerequisiteCodes = ['CASE_CURRENT', 'CURRENT_AUTHORITY', 'TEST_PROPOSED', 'STORAGE_CAPACITY', 'BUDGET_AVAILABLE'] as const;
export type SupplementalPrerequisiteCode = typeof supplementalPrerequisiteCodes[number];
export type PrerequisiteCode = SupplementalPrerequisiteCode | 'METRIC_FROZEN' | 'SNAPSHOT_FROZEN' | 'SNAPSHOT_RECORD_COUNT' | 'COVERAGE_BASELINE' | 'COVERAGE_COMPARISON' | 'COVERAGE_TAIL' | 'DATA_QUALITY' | 'WORKSPACE_CAPACITY' | 'INSTALLATION_CAPACITY' | 'RUNNER_AVAILABLE' | 'BROWSER_OBJECTIVE' | 'BROWSER_LIMITS' | 'HYPOTHESIS_CURRENT' | 'EVIDENCE_CURRENT' | 'CANDIDATE_CURRENT' | 'REPRODUCED_MECHANISM' | 'PLAN_CURRENT' | 'PLAN_REVIEWED' | 'TRUSTED_PROVENANCE' | 'TARGET_GRANT_CURRENT' | 'PLAN_APPROVAL_CURRENT';
export interface PrerequisiteFact {status: PrerequisiteStatus; detail: string; binding?: AssessmentBinding;}
export interface AssessmentPrerequisite extends PrerequisiteFact {code: PrerequisiteCode;}
export interface SelectedInputFact {id: string | null; hash: string | null; revision_id: string | null; frozen: boolean | null; freshness: 'current' | 'stale' | 'unknown';}
export interface SnapshotInputFact extends SelectedInputFact {records: number | null;}
export interface CapabilityFact {configured: boolean | null; status: 'available' | 'unconfigured' | 'unavailable' | 'unsupported' | 'unknown'; current_recorded_binding: boolean | null; binding?: AssessmentBinding;}
export interface AdapterCapabilityFact extends CapabilityFact {kind: string; id?: string;}
export interface CapabilityAssessment extends CapabilityFact {readiness: PrerequisiteStatus;}
export interface AdmissionFacts {workspace_active: number | null; installation_active: number | null; workspace_limit: number | null; installation_limit: number | null;}
export interface CoverageFacts {baseline: PrerequisiteFact; comparison: PrerequisiteFact; tail: PrerequisiteFact; quality: PrerequisiteFact;}
export interface BrowserFacts {
 objective: 'mechanism' | 'correction' | null;
 limits: {task_timeout_seconds: number | null; artifact_bytes: number | null};
 hypothesis?: PrerequisiteFact; evidence?: PrerequisiteFact;
 candidate?: PrerequisiteFact; mechanism_result?: PrerequisiteFact;
 plan?: SelectedInputFact; reviewed_plan?: PrerequisiteFact; trusted_provenance?: PrerequisiteFact;
 current_grant?: PrerequisiteFact; current_approval?: PrerequisiteFact;
}
interface SharedAssessmentFacts {
 revision_id: string | null; metric: SelectedInputFact; snapshot: SnapshotInputFact;
 /** Extra scoped guards only. Core prerequisite codes are derived from their named facts. */
 prerequisites: readonly (PrerequisiteFact & {code: SupplementalPrerequisiteCode})[];
 admission: AdmissionFacts;
 capabilities: {runner: CapabilityFact; model?: CapabilityFact; adapters?: readonly AdapterCapabilityFact[];};
}
export type OperationAssessmentFacts = SharedAssessmentFacts & ({operation: 'analytic'; coverage: CoverageFacts;} | {operation: 'browser_plan' | 'browser_run'; browser: BrowserFacts;});
export interface OperationAssessment {
 operation: AssessmentOperation; status: AssessmentStatus; revision_id: string | null;
 prerequisites: AssessmentPrerequisite[];
 selected_input: {metric: SelectedInputFact; snapshot: SnapshotInputFact;};
 admission: AdmissionFacts;
 capabilities: {runner: CapabilityAssessment; model?: CapabilityAssessment; adapters?: (AdapterCapabilityFact & {readiness: PrerequisiteStatus})[];};
 required_work_units: 0 | 1; optional_model_calls: 0;
 expected_observations: 12 | 18 | null;
 browser_limits: BrowserFacts['limits'] | null;
 requested_storage_bytes: null; requested_duration_seconds: null;
 assessment_scope: 'prerequisites_only'; admission_reserved: false;
}

const statuses: readonly PrerequisiteStatus[] = ['ready', 'missing', 'stale', 'blocked', 'unknown'];
const safeNumber = (value: number | null, positive = false): void => {
 demand(value === null || Number.isSafeInteger(value) && value >= (positive ? 1 : 0), 'INVALID_PREFLIGHT_FACTS', 'Preflight counts and limits must be known safe integers or null.');
};
const identifier = (value: string | null): void => {demand(value === null || typeof value === 'string' && value.length > 0 && value.length <= 128, 'INVALID_PREFLIGHT_FACTS', 'Preflight resource identity must be a bounded string or null.');};
function checkedBinding(binding?: AssessmentBinding): AssessmentBinding | undefined {
 if (binding === undefined) return undefined;
 demand(binding && typeof binding === 'object' && !Array.isArray(binding) && Object.keys(binding).length <= 32, 'INVALID_PREFLIGHT_FACTS', 'Preflight binding must be finite metadata.');
 for (const [key, value] of Object.entries(binding)) {
  demand(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key), 'INVALID_PREFLIGHT_FACTS', 'Preflight binding keys must be finite safe metadata names.');
  demand(value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 256 || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'INVALID_PREFLIGHT_FACTS', 'Preflight bindings contain bounded scalar metadata only.');
 }
 return {...binding};
}
function fact(code: PrerequisiteCode, value: PrerequisiteFact | undefined, revision: string | null, missingDetail: string): AssessmentPrerequisite {
 if (!value) return {code, status: 'unknown', detail: missingDetail};
 demand(statuses.includes(value.status) && typeof value.detail === 'string' && value.detail.length > 0 && value.detail.length <= 2000, 'INVALID_PREFLIGHT_FACTS', 'Preflight prerequisite status and detail must be explicit.');
 const binding = checkedBinding(value.binding), boundRevision = binding?.revision_id;
 const status = boundRevision !== undefined && (typeof boundRevision !== 'string' || revision === null) ? 'unknown' : boundRevision !== undefined && boundRevision !== revision ? 'stale' : value.status;
 return {code, status, detail: status === 'stale' && status !== value.status ? 'This prerequisite is bound to a different input revision. ' + value.detail : value.detail, ...(binding ? {binding} : {})};
}
function inputFact(code: 'METRIC_FROZEN' | 'SNAPSHOT_FROZEN' | 'PLAN_CURRENT', input: SelectedInputFact | undefined, revision: string | null): AssessmentPrerequisite {
 if (!input) return {code, status: 'unknown', detail: 'No scoped selected-input fact was supplied.'};
 identifier(input.id); identifier(input.revision_id);
 demand(input.hash === null || typeof input.hash === 'string' && /^[a-f0-9]{64}$/.test(input.hash), 'INVALID_PREFLIGHT_FACTS', 'Selected-input hashes must be SHA-256 or null.');
 demand((input.frozen === null || typeof input.frozen === 'boolean') && ['current', 'stale', 'unknown'].includes(input.freshness), 'INVALID_PREFLIGHT_FACTS', 'Frozen state and freshness must be explicit.');
 const status: PrerequisiteStatus = input.id === null ? 'missing' : input.freshness === 'stale' || input.revision_id !== null && revision !== null && input.revision_id !== revision ? 'stale' : input.frozen === false ? 'blocked' : input.hash === null || input.revision_id === null || revision === null || input.frozen === null || input.freshness === 'unknown' ? 'unknown' : 'ready';
 return {code, status, detail: status === 'ready' ? 'The selected immutable input matches the current scoped revision.' : status === 'missing' ? 'Select this required frozen input.' : status === 'stale' ? 'The selected input is withdrawn, expired, changed or bound to a different revision; review current inputs.' : status === 'blocked' ? 'Freeze the selected input before this operation.' : 'The selected input binding or freshness has not been established.', binding: {resource_id: input.id, hash: input.hash, revision_id: input.revision_id}};
}
function capability(value: CapabilityFact, revision: string | null): CapabilityAssessment {
 demand(value && (value.configured === null || typeof value.configured === 'boolean') && (value.current_recorded_binding === null || typeof value.current_recorded_binding === 'boolean') && ['available', 'unconfigured', 'unavailable', 'unsupported', 'unknown'].includes(value.status), 'INVALID_PREFLIGHT_FACTS', 'Capability configuration, availability and current recorded binding must be explicit.');
 const binding = checkedBinding(value.binding);
 const readiness: PrerequisiteStatus = value.configured === false ? 'blocked' : value.configured === null || value.status === 'unknown' ? 'unknown' : value.status === 'unconfigured' ? 'missing' : value.status !== 'available' ? 'blocked' : value.current_recorded_binding === false ? 'stale' : value.current_recorded_binding === null ? 'unknown' : 'ready';
 const bound = fact('RUNNER_AVAILABLE', {status: readiness, detail: 'Capability readiness reflects its current recorded configuration binding; no probe was executed.', ...(binding ? {binding} : {})}, revision, 'Capability state is unknown.');
 return {configured: value.configured, status: value.status, current_recorded_binding: value.current_recorded_binding, readiness: bound.status, ...(binding ? {binding} : {})};
}
function admissionFact(code: 'WORKSPACE_CAPACITY' | 'INSTALLATION_CAPACITY', active: number | null, limit: number | null): AssessmentPrerequisite {
 safeNumber(active); safeNumber(limit, true);
 return {code, status: active === null || limit === null ? 'unknown' : active >= limit ? 'blocked' : 'ready', detail: active === null || limit === null ? 'Current active work or the configured capacity is unknown.' : active >= limit ? 'Recorded active work occupies the configured capacity. Wait or explicitly cancel work.' : 'The observed capacity permits one work unit; admission is rechecked atomically when queued.', binding: {observed_active: active, configured_limit: limit}};
}

export function assessOperation(facts: OperationAssessmentFacts): OperationAssessment {
 demand(facts && ['analytic', 'browser_plan', 'browser_run'].includes(facts.operation), 'INVALID_PREFLIGHT_FACTS', 'Select a finite preflight operation.');
 identifier(facts.revision_id); safeNumber(facts.snapshot.records);
 demand(Array.isArray(facts.prerequisites) && facts.prerequisites.length <= supplementalPrerequisiteCodes.length, 'INVALID_PREFLIGHT_FACTS', 'Supplemental preflight guards must be finite.');
 const prerequisites: AssessmentPrerequisite[] = [], seen = new Set<PrerequisiteCode>();
 const add = (value: AssessmentPrerequisite) => {demand(!seen.has(value.code), 'DUPLICATE_PREFLIGHT_PREREQUISITE', 'Duplicate prerequisite codes cannot overwrite a prior state.'); seen.add(value.code); prerequisites.push(value);};
 const supplementalSeen = new Set<SupplementalPrerequisiteCode>();
 for (const value of facts.prerequisites) {demand((supplementalPrerequisiteCodes as readonly string[]).includes(value.code), 'INVALID_PREFLIGHT_FACTS', 'Core prerequisite statuses must use their named facts.'); demand(!supplementalSeen.has(value.code), 'DUPLICATE_PREFLIGHT_PREREQUISITE', 'Duplicate prerequisite codes cannot overwrite a prior state.'); supplementalSeen.add(value.code); const checked = fact(value.code, value, facts.revision_id, 'Scoped guard unavailable.'); if (facts.operation !== 'browser_plan' || value.code !== 'BUDGET_AVAILABLE') add(checked);}
 add(inputFact('METRIC_FROZEN', facts.metric, facts.revision_id)); add(inputFact('SNAPSHOT_FROZEN', facts.snapshot, facts.revision_id));
 add({code: 'SNAPSHOT_RECORD_COUNT', status: facts.snapshot.records === null ? 'unknown' : 'ready', detail: facts.snapshot.records === null ? 'Selected snapshot row count is unknown.' : 'Recorded selected snapshot row count is available.', binding: {records: facts.snapshot.records}});
 const workspaceCapacity = admissionFact('WORKSPACE_CAPACITY', facts.admission.workspace_active, facts.admission.workspace_limit), installationCapacity = admissionFact('INSTALLATION_CAPACITY', facts.admission.installation_active, facts.admission.installation_limit);
 // Plan preparation performs no job enqueue or work-unit reservation. Observed
 // admission counts remain visible but constrain only operations that enqueue.
 if (facts.operation !== 'browser_plan') {add(workspaceCapacity); add(installationCapacity);}
 const runner = capability(facts.capabilities.runner, facts.revision_id), model = facts.capabilities.model ? capability(facts.capabilities.model, facts.revision_id) : undefined;
 demand(facts.capabilities.adapters === undefined || Array.isArray(facts.capabilities.adapters) && facts.capabilities.adapters.length <= 200, 'INVALID_PREFLIGHT_FACTS', 'Adapter capability inventory must be bounded.');
 const adapters = facts.capabilities.adapters?.map(value => {identifier(value.kind); if (value.id !== undefined) identifier(value.id); return {kind: value.kind, ...(value.id === undefined ? {} : {id: value.id}), ...capability(value, facts.revision_id)};});
 let expectedObservations: 12 | 18 | null = null, browserLimits: BrowserFacts['limits'] | null = null;
 if (facts.operation === 'analytic') {
  for (const [code, value] of [['COVERAGE_BASELINE', facts.coverage.baseline], ['COVERAGE_COMPARISON', facts.coverage.comparison], ['COVERAGE_TAIL', facts.coverage.tail], ['DATA_QUALITY', facts.coverage.quality]] as const) add(fact(code, value, facts.revision_id, 'Current event-time coverage and quality facts are required.'));
 } else {
  const browser = facts.browser; demand(browser && (browser.objective === null || ['mechanism', 'correction'].includes(browser.objective)), 'INVALID_PREFLIGHT_FACTS', 'Browser objective must be mechanism, correction or unknown.');
  expectedObservations = browser.objective === 'mechanism' ? 12 : browser.objective === 'correction' ? 18 : null;
  safeNumber(browser.limits.task_timeout_seconds, true); safeNumber(browser.limits.artifact_bytes, true); browserLimits = {...browser.limits};
  add({code: 'BROWSER_OBJECTIVE', status: browser.objective === null ? 'missing' : 'ready', detail: browser.objective === null ? 'Select the finite protected mechanism or correction objective.' : 'The protected objective requires ' + expectedObservations + ' observations; planning does not establish any outcome.'});
  add({code: 'BROWSER_LIMITS', status: browser.limits.task_timeout_seconds === null || browser.limits.artifact_bytes === null ? 'unknown' : 'ready', detail: 'Supplied browser deadline and artifact ceiling are configured limits, not runtime or storage estimates.'});
  add({code: 'RUNNER_AVAILABLE', status: runner.readiness, detail: 'Browser preparation and execution require an available runner with a current recorded binding. Configuration alone does not establish availability.', ...(runner.binding ? {binding: runner.binding} : {})});
  add(fact('HYPOTHESIS_CURRENT', browser.hypothesis, facts.revision_id, 'Review a current hypothesis proposing this typed browser objective.'));
  add(fact('EVIDENCE_CURRENT', browser.evidence, facts.revision_id, 'Review the current accessible evidence hashes.'));
  if (browser.objective === 'correction') {add(fact('CANDIDATE_CURRENT', browser.candidate, facts.revision_id, 'Register a current pinned correction candidate.')); add(fact('REPRODUCED_MECHANISM', browser.mechanism_result, facts.revision_id, 'Correction requires a fresh matching reproduced mechanism result.'));}
  if (facts.operation === 'browser_run') {
   add(inputFact('PLAN_CURRENT', browser.plan, facts.revision_id));
   for (const [code, value, detail] of [['PLAN_REVIEWED', browser.reviewed_plan, 'Explicitly review this exact immutable plan.'], ['TRUSTED_PROVENANCE', browser.trusted_provenance, 'Trusted target/build and observation-profile provenance is required.'], ['TARGET_GRANT_CURRENT', browser.current_grant, 'A current owner-issued exact target grant is required.'], ['PLAN_APPROVAL_CURRENT', browser.current_approval, 'A current approval bound to this plan, oracle and grant is required.']] as const) add(fact(code, value, facts.revision_id, detail));
  }
 }
 const status: AssessmentStatus = prerequisites.some(value => ['missing', 'stale', 'blocked'].includes(value.status)) ? 'blocked' : prerequisites.some(value => value.status === 'unknown') ? 'unknown' : 'ready';
 return {operation: facts.operation, status, revision_id: facts.revision_id, prerequisites, selected_input: {metric: {...facts.metric}, snapshot: {...facts.snapshot}}, admission: {...facts.admission}, capabilities: {runner, ...(model ? {model} : {}), ...(adapters ? {adapters} : {})}, required_work_units: facts.operation === 'browser_plan' ? 0 : 1, optional_model_calls: 0, expected_observations: expectedObservations, browser_limits: browserLimits, requested_storage_bytes: null, requested_duration_seconds: null, assessment_scope: 'prerequisites_only', admission_reserved: false};
}
