import {displayLabel, plainSummary} from '../../plain-language';
import React, {lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent} from 'react';
import {casePath, resource, workspacePath, type Investigation, type Workspace} from '../../api';
import {boundedResource} from '../../read-state';
import {commandKey, type CommandIdentity} from '../../command-key';
import {ErrorNotice, Field, Loading, Status, formError} from '../../ui';
import {safeId, type Job} from '../data/types';

const EmbeddedDataWorkflow = lazy(() => import('../data/DataWorkflow').then(module => ({default: module.DataWorkflow})));
const EmbeddedInvestigationWorkspace = lazy(() => import('../investigation/InvestigationWorkspace').then(module => ({default: module.InvestigationWorkspace})));

export type AgentStage = 'setup' | 'measure' | 'explain' | 'test' | 'report' | 'follow_up';
export type AgentActionKind = 'open_data' | 'review_metric' | 'generate_hypotheses' | 'open_evidence' | 'open_data_checks' | 'open_browser_tests' | 'draft_report' | 'open_follow_up' | 'gather_related_evidence' | 'recall_prior_investigations' | 'review_results' | 'draft_test_plan' | 'schedule_follow_up';
export type AgentReadiness = {key: string; label: string; status: 'complete' | 'ready' | 'needs_input' | 'blocked' | 'stale'; destination: string};
export type AgentModelProfile = {id: string; name: string; model_name: string; provider: string; status: string};
export type AgentApprovalPlan =
  | {schema_version: 1; kind: 'blocked'; reason_code: string}
  | {schema_version: 1; kind: 'meterless_recall'; revision_id: string; query: string; query_hash: string; catalog_hash: string; max_results: 5}
  | {schema_version: 1; kind: 'test_plan_draft'; revision_id: string; test_kind: 'data_validation' | 'controlled_comparison' | 'external_browser'}
  | {schema_version: 1; kind: 'zetaris_federated_query'; source_id: string; source_name: string; source_revision: number; config_hash: string; probe_binding_hash: string; credential_version: number; approved_origin: string; approved_account_scope: string; request_hash: string; request: {template_id: string; view_ids: Record<string, string>; from: string; to: string; case_key: string; flow_key?: string; release_id?: string; affected_cohort?: string; control_cohort?: string; caps?: Record<string, number>}};
export type AgentActionParameters = {template_id?: 'release_exposure' | 'support_symptoms' | 'change_timeline' | 'cohort_context' | 'contrary_evidence' | 'followup_recheck'; query?: string; release_id?: string; affected_cohort?: string; control_cohort?: string; test_kind?: 'data_validation' | 'controlled_comparison' | 'external_browser'; approval_plan?: AgentApprovalPlan};
export type AgentHypothesis = {title: string; statement: string; supporting_evidence_ids: string[]; contradicting_evidence_ids: string[]; memory_capsule_ids: string[]; falsifier: string; confidence: 'low' | 'medium' | 'high'};
export type AgentResponse = {
  schema_version: 2;
  revision_id: string;
  input_hash: string;
  stage: AgentStage;
  message: string;
  evidence_ids: string[];
  memory_capsule_ids: string[];
  analysis: {current_belief: string; what_changed: string; hypotheses: AgentHypothesis[]; unknowns: string[]};
  actions: {kind: AgentActionKind; title: string; reason: string; requires_approval: boolean; parameters: AgentActionParameters}[];
  questions: string[];
  limitations: string[];
};
export type AgentAction = {
  id: string;
  kind: AgentActionKind;
  title: string;
  reason: string;
  parameters: AgentActionParameters;
  requires_approval: boolean;
  status: string;
  binding_hash: string;
  target_job_id: string | null;
  tool_result: unknown | null;
  reflection_turn_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
};
export type AgentMemoryCapsule = {capsule_id: string; source_case_id: string; published_report_id: string; affected_flow: string; accepted_findings: {text: string; evidence_ids: string[]}[]; rejected_or_unresolved_alternatives: unknown[]; falsifiers: string[]; limitations: string[]; follow_up_outcome: string | null; accepted_at: string; capsule_hash: string};
export type AgentMemory = {id: string; status: 'complete' | 'empty' | 'unavailable'; capsules: {capsule: AgentMemoryCapsule; relevance: number}[]; metrics: unknown | null; created_at: string};
export type AgentTurn = {
  id: string;
  user_message: string;
  message_kind?: 'user' | 'tool';
  status: string;
  response: AgentResponse | null;
  error_code: string | null;
  job_id: string | null;
  created_at: string;
  updated_at: string;
  actions: AgentAction[];
  memory: AgentMemory | null;
};
export type AgentSession = {
  id: string;
  objective: string;
  status: string;
  profile_id: string;
  created_at: string;
  updated_at: string;
  turns: AgentTurn[];
};
export type AgentWorkspaceState = {
  model_budget?: {remaining_calls: number; remaining_input: number; remaining_output: number; can_request: boolean; reason_code: string | null};
  stage: AgentStage;
  readiness: AgentReadiness[];
  active_revision_id: string;
  model_profiles: AgentModelProfile[];
  sessions: AgentSession[];
  memory_candidate: {report_id: string; title: string; saved: boolean; capsule_id: string | null; capsule_hash: string | null; memory_status: 'not_saved' | 'active' | 'stale' | 'withdrawn'} | null;
};
export type AcceptedAgentTurn = {session_id: string; turn_id: string; job_id: string; status: 'queued'};
export type AgentActionReview = {id: string; status: 'approved' | 'completed' | 'dismissed'; binding_hash: string; target_job_id: string | null; destination?: string | null; reflection_turn_id?: string | null};
export type MemoryFeedbackKind = 'helpful' | 'not_relevant' | 'wrong';
export type MemoryFeedbackResult = {id: string; capsule_id: string; kind: MemoryFeedbackKind; applied: true};
export type SavedReportMemory = {id: string; capsule_hash: string; status: 'active'};
export type WithdrawnReportMemory = {id: string; capsule_hash: string; status: 'withdrawn'};

type Identity = {current: CommandIdentity};
type StartInput = {base: string; csrf: string; objective?: string; profileId: string; revisionId: string; identity: Identity};
type FollowUpInput = Omit<StartInput, 'objective'> & {sessionId: string; message?: string};
type ActionInput = {base: string; csrf: string; action: AgentAction; decision: 'approve' | 'dismiss'; identity: Identity; reason?: string};
type MemoryFeedbackInput = {base: string; csrf: string; retrievalId: string; capsuleId: string; kind: MemoryFeedbackKind; identity: Identity};
type SaveReportMemoryInput = {base: string; csrf: string; reportId: string; identity: Identity};
type WithdrawReportMemoryInput = {base: string; csrf: string; capsuleId: string; capsuleHash: string; identity: Identity};

function acceptedTurn(value: AcceptedAgentTurn): AcceptedAgentTurn {
  if (!value?.session_id || !value.turn_id || !value.job_id || value.status !== 'queued') throw new Error('The agent did not return a queued saved turn.');
  return value;
}

export async function startAgentSession(input: StartInput): Promise<AcceptedAgentTurn> {
  const objective = input.objective?.trim();
  if ((objective?.length ?? 0) > 2000) throw new Error('Keep the optional focus within 2000 characters.');
  if (!input.profileId || !input.revisionId) throw new Error('Choose an available Agent model and refresh the investigation.');
  const body = {profile_id: input.profileId, revision_id: input.revisionId, ...(objective ? {objective} : {})};
  const path = `${input.base}/agent/sessions`;
  const value = acceptedTurn(await resource<AcceptedAgentTurn>(path, {method: 'POST', body, csrf: input.csrf, idempotencyKey: commandKey(input.identity, {path, body})}));
  input.identity.current = null;
  return value;
}

export async function appendAgentTurn(input: FollowUpInput): Promise<AcceptedAgentTurn> {
  const message = input.message?.trim();
  if ((message?.length ?? 0) > 4000) throw new Error('Keep the optional context within 4000 characters.');
  if (!input.sessionId || !input.profileId || !input.revisionId) throw new Error('Choose an available Agent model and refresh the investigation.');
  const body = {profile_id: input.profileId, revision_id: input.revisionId, ...(message ? {message} : {})};
  const path = `${input.base}/agent/sessions/${encodeURIComponent(input.sessionId)}/turns`;
  const value = acceptedTurn(await resource<AcceptedAgentTurn>(path, {method: 'POST', body, csrf: input.csrf, idempotencyKey: commandKey(input.identity, {path, body})}));
  input.identity.current = null;
  return value;
}

export async function reviewAgentAction(input: ActionInput): Promise<AgentActionReview> {
  const retryable = input.decision === 'approve' && ['failed', 'cancelled'].includes(input.action.status) && Boolean(input.action.target_job_id);
  if (!input.action.id || !input.action.binding_hash || (input.action.status !== 'suggested' && !retryable)) throw new Error('This suggestion is no longer ready for review. Refresh the investigation.');
  const suffix = input.decision === 'approve' ? 'approve' : 'dismiss';
  const body = input.decision === 'approve' ? {reviewed: true} : {reason: input.reason?.trim() || 'Dismissed after review.'};
  const path = `${input.base}/agent/actions/${encodeURIComponent(input.action.id)}/${suffix}`;
  const value = await resource<AgentActionReview>(path, {
    method: 'POST', body, csrf: input.csrf,
    // The API uses the immutable action binding hash as its If-Match value.
    revision: input.action.binding_hash,
    idempotencyKey: commandKey(input.identity, {path, body, binding_hash: input.action.binding_hash}),
  });
  const acceptedStatus = input.decision === 'approve' ? ['approved', 'completed'] : ['dismissed'];
  if (value?.id !== input.action.id || !acceptedStatus.includes(value.status) || value.binding_hash !== input.action.binding_hash) throw new Error('The service did not return the reviewed agent suggestion. Refresh before continuing.');
  input.identity.current = null;
  return value;
}

export async function submitMemoryFeedback(input: MemoryFeedbackInput): Promise<MemoryFeedbackResult> {
  if (!input.retrievalId || !input.capsuleId || !['helpful', 'not_relevant', 'wrong'].includes(input.kind)) throw new Error('Choose a prior case and a rating.');
  const body = {kind: input.kind}, path = `${input.base}/agent/memory/retrievals/${encodeURIComponent(input.retrievalId)}/capsules/${encodeURIComponent(input.capsuleId)}/feedback`;
  const value = await resource<MemoryFeedbackResult>(path, {method: 'POST', body, csrf: input.csrf, idempotencyKey: commandKey(input.identity, {path, body})});
  if (value?.capsule_id !== input.capsuleId || value.kind !== input.kind || value.applied !== true) throw new Error('The rating was not saved. Refresh and try again.');
  input.identity.current = null;
  return value;
}

export async function saveReportForFuture(input: SaveReportMemoryInput): Promise<SavedReportMemory> {
  if (!input.reportId) throw new Error('Choose a published report.');
  const body = {report_id: input.reportId, reviewed: true as const}, path = `${input.base}/agent/memory`;
  const value = await resource<SavedReportMemory>(path, {method: 'POST', body, csrf: input.csrf, idempotencyKey: commandKey(input.identity, {path, body})});
  if (!value?.id || !value.capsule_hash || value.status !== 'active') throw new Error('The report was not saved for future cases.');
  input.identity.current = null;
  return value;
}

export async function withdrawReportFromFuture(input: WithdrawReportMemoryInput): Promise<WithdrawnReportMemory> {
  if (!input.capsuleId || !/^[a-f0-9]{64}$/.test(input.capsuleHash)) throw new Error('The saved report binding is unavailable. Refresh and try again.');
  const body = {reason: 'No longer use this report in future investigations.'}, path = `${input.base}/agent/memory/${encodeURIComponent(input.capsuleId)}/withdraw`;
  const value = await resource<WithdrawnReportMemory>(path, {method: 'POST', body, csrf: input.csrf, revision: input.capsuleHash, idempotencyKey: commandKey(input.identity, {path, body, capsule_hash: input.capsuleHash})});
  if (value?.id !== input.capsuleId || value.capsule_hash !== input.capsuleHash || value.status !== 'withdrawn') throw new Error('The saved report was not removed from future cases.');
  input.identity.current = null;
  return value;
}

export function approvedActionOutcome(value: AgentActionReview): {job_id: string | null; destination: string | null; reflection_turn_id: string | null} {
  return {job_id: value.target_job_id || null, destination: value.target_job_id ? null : value.destination || null, reflection_turn_id: value.reflection_turn_id || null};
}

export function agentActionNeedsRefresh(action: AgentAction | undefined): boolean {
  return Boolean(action && !action.reflection_turn_id && ['suggested', 'approved'].includes(action.status));
}

export function pendingAgentToolAction(state: AgentWorkspaceState | null, sessionId: string, currentJobId: string, restoredActionIds: ReadonlySet<string>): AgentAction | null {
  if (!state || !sessionId || currentJobId) return null;
  const session = state.sessions.find(item => item.id === sessionId);
  if (session?.turns.some(turn => ['queued', 'running'].includes(turn.status) && typeof turn.job_id === 'string' && turn.job_id.trim().length > 0)) return null;
  return session?.turns.flatMap(turn => turn.actions).find(action => action.status === 'approved' && !action.reflection_turn_id && typeof action.target_job_id === 'string' && action.target_job_id.trim().length > 0 && !restoredActionIds.has(action.id)) ?? null;
}

export function pendingAgentTurnJob(state: AgentWorkspaceState | null, sessionId: string, caseId: string, currentJobId: string, observedJob: Job | null): string | null {
  // A tracked tool run owns polling until it finishes. Only saved turns authorize
  // discovering a reflection; an action's reflection ID is not itself a job ID.
  if (!state || !sessionId || !caseId || currentJobId || (observedJob?.case_id && observedJob.case_id !== caseId)) return null;
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return null;
  const turn = [...session.turns].reverse().find(item => ['queued', 'running'].includes(item.status) && typeof item.job_id === 'string' && item.job_id.trim().length > 0 && !(observedJob?.id === item.job_id && !['queued', 'running', 'cancel_requested'].includes(observedJob.status)));
  return turn?.job_id ?? null;
}

const stageLabels = ['Connect data', 'Measure', 'Find causes', 'Test', 'Report', 'Follow up'];

export function actionDestination(workspaceId: string, caseId: string, kind: AgentActionKind): string | null {
  const root = `/w/${encodeURIComponent(workspaceId)}/cases/${encodeURIComponent(caseId)}`;
  if (kind === 'open_data') return `${root}/data`;
  if (kind === 'review_metric') return `${root}/data`;
  const tab: Partial<Record<AgentActionKind, string>> = {
    open_evidence: 'evidence', open_data_checks: 'tests', open_browser_tests: 'verification', open_follow_up: 'followup', review_results: 'tests', draft_test_plan: 'tests', schedule_follow_up: 'followup',
  };
  return tab[kind] ? `${root}/investigation?tab=${tab[kind]}` : null;
}

export function completedReportProposal(action: AgentAction): string | null {
  if (action.kind !== 'draft_report' || !['completed', 'failed'].includes(action.status) || !action.target_job_id || !action.tool_result || typeof action.tool_result !== 'object') return null;
  const tool = action.tool_result as Record<string, unknown>;
  if (tool.kind !== 'draft_report' || tool.status !== 'succeeded' || tool.job_id !== action.target_job_id || !tool.result || typeof tool.result !== 'object') return null;
  const result = tool.result as Record<string, unknown>;
  return result.draft_only === true && typeof result.proposal_id === 'string' ? safeId(result.proposal_id) || null : null;
}

export function savedToolSucceeded(action: AgentAction): boolean {
  if (!action.target_job_id || !action.tool_result || typeof action.tool_result !== 'object') return false;
  const tool = action.tool_result as Record<string, unknown>;
  return tool.kind === action.kind && tool.status === 'succeeded' && tool.job_id === action.target_job_id;
}

export function modelDraftNeedsReview(action: AgentAction): boolean {
  if (!['generate_hypotheses', 'draft_report'].includes(action.kind) || action.status !== 'completed' || action.reflection_turn_id !== null || action.last_error_code !== null || !action.target_job_id?.trim() || !savedToolSucceeded(action) || Array.isArray(action.tool_result)) return false;
  const tool = action.tool_result as Record<string, unknown>;
  if (tool.reflection_policy !== 'human_review' || !tool.result || typeof tool.result !== 'object' || Array.isArray(tool.result)) return false;
  const result = tool.result as Record<string, unknown>;
  return result.draft_only === true && typeof result.proposal_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.proposal_id);
}

export function reportReviewDestination(workspaceId: string, caseId: string, action: AgentAction): string | null {
  const id = completedReportProposal(action);
  return id ? `/w/${encodeURIComponent(workspaceId)}/cases/${encodeURIComponent(caseId)}/investigation?tab=reports&diagnosis_proposal=${encodeURIComponent(id)}` : null;
}

export type AgentTask = {kind: 'data'; destination: string} | {kind: 'investigation'; destination: string; section: string; diagnosisProposalId?: string};

export function agentTaskDestination(workspaceId: string, caseId: string, destination: string): AgentTask | null {
  const root = `/w/${encodeURIComponent(workspaceId)}/cases/${encodeURIComponent(caseId)}`;
  if (destination === `${root}/data`) return {kind: 'data', destination};
  if (!destination.startsWith(`${root}/investigation?`)) return null;
  const query = new URLSearchParams(destination.slice(destination.indexOf('?') + 1)), section = query.get('tab');
  if ([...query.keys()].some(key => key !== 'tab' && !(section === 'reports' && key === 'diagnosis_proposal')) || query.getAll('tab').length !== 1 || !section || !['evidence', 'timeline', 'hypotheses', 'tests', 'verification', 'staging', 'reports', 'discussion', 'followup'].includes(section)) return null;
  const proposal = query.get('diagnosis_proposal');
  if (proposal !== null && (query.getAll('diagnosis_proposal').length !== 1 || !safeId(proposal))) return null;
  return {kind: 'investigation', destination, section, ...(proposal ? {diagnosisProposalId: proposal} : {})};
}

function link(event: MouseEvent, destination: string, navigate: (path: string) => void) {
  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {event.preventDefault(); navigate(destination);}
}

function TaskNavigation({readiness, stage, navigate}: {readiness: AgentReadiness[]; stage: AgentStage; navigate: (path: string) => void}) {
  const currentIndex = Math.max(0, ['setup', 'measure', 'explain', 'test', 'report', 'follow_up'].indexOf(stage));
  return <nav className="agent-tasks" aria-label="Investigation tasks"><ol>{stageLabels.map((label, index) => {
    const saved = readiness[index], status = saved?.status ?? (index < currentIndex ? 'complete' : index === currentIndex ? 'ready' : 'blocked');
    const name=saved?.label || label, stateLabel=status === 'complete' ? 'Done' : status === 'ready' ? 'Ready' : status === 'needs_input' ? 'Needs input' : status === 'stale' ? 'Stale' : 'Blocked';
    const content=<><span aria-hidden="true">{status === 'complete' ? '✓' : index + 1}</span><strong>{name}</strong>{status !== 'complete' && status !== 'ready' && <small>{stateLabel}</small>}</>;
    return <li key={label} className={`agent-task-${status}`}>{saved?.destination ? <a href={saved.destination} aria-label={name} aria-description={stateLabel} aria-current={index === currentIndex ? 'step' : undefined} onClick={event=>link(event,saved.destination,navigate)}>{content}</a> : <span aria-label={name} aria-description={stateLabel} aria-disabled="true">{content}</span>}</li>;
  })}</ol></nav>;
}

function EvidenceIds({label, ids}: {label: string; ids: string[]}) {
  return ids.length ? <details><summary>{label}</summary><ul className="citation-list">{ids.map(id => <li key={id}><code>{id}</code></li>)}</ul></details> : null;
}

function TurnView({turn, turns, canAct, pending, onAction, onMemoryFeedback, workspaceId, caseId, navigate, canRequestModel = true}: {canRequestModel?: boolean; workspaceId: string; caseId: string; navigate: (path: string) => void; turn: AgentTurn; turns: AgentTurn[]; canAct: boolean; pending: string; onAction: (action: AgentAction, decision: 'approve' | 'dismiss') => void; onMemoryFeedback: (retrievalId: string, capsuleId: string, kind: MemoryFeedbackKind) => void}) {
  const response = turn.response, toolTurn = turn.message_kind === 'tool';
  return <article className="agent-turn">
    <details className="agent-message user-message"><summary>{toolTurn ? 'Tool result' : 'Investigation context'}</summary>{toolTurn ? <details><summary>View saved result</summary><pre>{turn.user_message.replace(/^Approved tool result:\s*/, '')}</pre></details> : <p>{turn.user_message}</p>}</details>
    {turn.status === 'succeeded' && response ? <div className="agent-message agent-draft"><div className="section-heading"><Status tone="warning">Draft</Status></div><p>{plainSummary(response.message)}</p>
      <details className="agent-reasoning"><summary>Review analysis</summary><h3>Current view</h3><p>{plainSummary(response.analysis.current_belief)}</p><h3>What changed</h3><p>{plainSummary(response.analysis.what_changed)}</p>
        {!!response.analysis.hypotheses.length && <div><h3>Possible explanations</h3>{response.analysis.hypotheses.map((hypothesis, index) => <section className="agent-action" key={`${plainSummary(hypothesis.title)}:${index}`}><div className="section-heading"><h4>{plainSummary(hypothesis.title)}</h4><Status tone="muted">{hypothesis.confidence} confidence</Status></div><p>{plainSummary(hypothesis.statement)}</p><EvidenceIds label="Supporting evidence" ids={hypothesis.supporting_evidence_ids} /><EvidenceIds label="Opposing evidence" ids={hypothesis.contradicting_evidence_ids} /><p><strong>What would change this</strong><br />{plainSummary(hypothesis.falsifier)}</p></section>)}</div>}
        {!!response.analysis.unknowns.length && <details><summary>Still unknown ({response.analysis.unknowns.length})</summary><ul>{response.analysis.unknowns.map((item, index) => <li key={index}>{plainSummary(item)}</li>)}</ul></details>}
      </details>
      {!!response.evidence_ids.length && <details><summary>Evidence considered ({response.evidence_ids.length})</summary><ul className="citation-list">{response.evidence_ids.map(id => <li key={id}><code>{id}</code></li>)}</ul></details>}
      {!!turn.memory?.capsules.length && <details className="agent-memory"><summary>Related past cases ({turn.memory.capsules.length})</summary>{turn.memory.capsules.map(({capsule}) => {const cited = response.memory_capsule_ids.includes(capsule.capsule_id), feedbackPending = pending.startsWith(`memory:${capsule.capsule_id}:`); return <section className="agent-action" key={capsule.capsule_id}><div className="section-heading"><h4>{capsule.affected_flow || 'Prior case'}</h4>{cited && <Status tone="muted">Used in this draft</Status>}</div>{capsule.accepted_findings.slice(0, 3).map((finding, index) => <p key={index}>{finding.text}</p>)}{!!capsule.limitations.length && <p className="fine-print">Limit: {capsule.limitations[0]}</p>}{canAct && <div className="button-row" aria-label={`Rate prior case ${capsule.affected_flow || capsule.capsule_id}`}><button className="text-button" type="button" disabled={feedbackPending} onClick={() => onMemoryFeedback(turn.memory!.id, capsule.capsule_id, 'helpful')}>Helpful</button><button className="text-button" type="button" disabled={feedbackPending} onClick={() => onMemoryFeedback(turn.memory!.id, capsule.capsule_id, 'not_relevant')}>Not relevant</button><button className="text-button" type="button" disabled={feedbackPending} onClick={() => onMemoryFeedback(turn.memory!.id, capsule.capsule_id, 'wrong')}>Wrong</button></div>}</section>;})}</details>}
      {!!response.questions.length && <section className="notice"><h3>Needs your input</h3><ul>{response.questions.map((question, index) => <li key={index}>{plainSummary(question)}</li>)}</ul></section>}
      {!!response.limitations.length && <details><summary>Limits</summary><ul>{response.limitations.map((item, index) => <li key={index}>{plainSummary(item)}</li>)}</ul></details>}
      {!!turn.actions.length && <div className="agent-actions"><h3>Next steps</h3>{turn.actions.map(action => <AgentActionView key={action.id} action={action} reflection={turns.find(item => item.id === action.reflection_turn_id)} workspaceId={workspaceId} caseId={caseId} navigate={navigate} canAct={canAct} pending={pending} canRequestModel={canRequestModel} onAction={onAction} />)}</div>}
    </div> : ['queued', 'running'].includes(turn.status) ? <div className="agent-message"><Loading label={toolTurn ? 'agent update is reviewing the saved tool result…' : turn.status === 'queued' ? 'Agent turn queued…' : 'Agent is reviewing the saved evidence…'} /></div> : <div className="notice warning" role="status"><strong>{toolTurn ? `agent update ${['failed', 'cancelled', 'stale'].includes(turn.status) ? turn.status : 'unavailable'}` : turn.status === 'failed' ? 'Agent turn failed' : turn.status === 'cancelled' ? 'Agent turn cancelled' : turn.status === 'stale' ? 'Agent turn is out of date' : 'Agent result unavailable'}</strong><p>{turn.error_code ? `Reason: ${displayLabel(turn.error_code)}. ` : ''}{toolTurn ? 'Saved tool output remains available. No completed agent update is assumed. Continue when the issue is resolved.' : 'No draft or verified result was created. You can continue the investigation to retry.'}</p></div>}
  </article>;
}

function AgentActionView({action, reflection, workspaceId, caseId, navigate, canAct, pending, canRequestModel, onAction}: {action: AgentAction; reflection?: AgentTurn; workspaceId: string; caseId: string; navigate: (path: string) => void; canAct: boolean; pending: string; canRequestModel: boolean; onAction: (action: AgentAction, decision: 'approve' | 'dismiss') => void}) {
  const saved = savedToolSucceeded(action), retryable = ['failed', 'cancelled'].includes(action.status) && Boolean(action.target_job_id), blocked = action.parameters.approval_plan?.kind === 'blocked';
  const draftNeedsReview = modelDraftNeedsReview(action);
  const continuation = reflection?.status ?? (action.last_error_code || action.status === 'failed' ? 'incomplete' : 'unavailable');
  const continuationComplete = continuation === 'succeeded', continuationPending = ['queued', 'running'].includes(continuation);
  const label = draftNeedsReview ? 'Draft ready · Review required' : saved ? `Tool succeeded${continuationComplete ? '' : ` · agent update ${continuationPending ? 'pending' : continuation}`}` : action.status;
  const destination = reportReviewDestination(workspaceId, caseId, action);
  const outputDestination = saved && action.kind === 'generate_hypotheses' ? `/w/${encodeURIComponent(workspaceId)}/cases/${encodeURIComponent(caseId)}/investigation?tab=hypotheses` : saved && action.kind === 'gather_related_evidence' ? actionDestination(workspaceId, caseId, 'open_evidence') : null;
  return <section className="agent-action">
    <div className="section-heading"><h4>{plainSummary(action.title)}</h4><Status tone={saved ? continuationComplete ? 'muted' : 'warning' : action.status === 'suggested' ? 'warning' : action.status === 'completed' ? 'good' : 'muted'}>{label}</Status></div>
    <p>{plainSummary(action.reason)}</p><ActionPlan parameters={action.parameters} />
    {draftNeedsReview && <p>Review this draft before adding it to the investigation.</p>}
    {saved && !continuationComplete && !draftNeedsReview && <p className="notice warning">Saved tool output is available. {continuationPending ? 'agent update is pending.' : continuation === 'failed' ? 'agent update failed.' : 'agent update did not complete.'} {action.last_error_code === 'MODEL_BUDGET_EXHAUSTED' || reflection?.error_code === 'MODEL_BUDGET_EXHAUSTED' ? 'The agent limit was reached. Review saved work or ask an owner to review the allowance before continuing.' : ''}</p>}
    {action.status === 'suggested' && canAct && <div className="button-row"><button className="primary" type="button" disabled={!!pending || blocked || (!canRequestModel && ['generate_hypotheses', 'draft_report'].includes(action.kind))} onClick={() => onAction(action, 'approve')}>{pending === action.id ? 'Starting…' : blocked ? 'Not ready' : 'Approve'}</button><button className="text-button" type="button" disabled={!!pending} onClick={() => onAction(action, 'dismiss')}>Dismiss</button></div>}
    {retryable && canAct && <><button className="primary" type="button" disabled={!!pending || (!canRequestModel && (saved || ['generate_hypotheses', 'draft_report'].includes(action.kind)))} onClick={() => onAction(action, 'approve')}>{pending === action.id ? 'Retrying…' : saved ? 'Retry agent update' : 'Retry'}</button>{saved && <p className="fine-print">Uses the saved tool result; the tool will not run again.</p>}</>}
    {destination && <button className="primary" type="button" onClick={() => navigate(destination)}>Read report draft</button>}
    {outputDestination && <button className="secondary" type="button" onClick={() => navigate(outputDestination)}>{action.kind === 'generate_hypotheses' ? 'Read saved possible reasons' : 'Review saved evidence'}</button>}
    {saved && <details><summary>View saved tool output</summary><pre>{JSON.stringify(action.tool_result, null, 2)}</pre></details>}
    {action.kind === 'draft_report' && action.status === 'completed' && !completedReportProposal(action) && <p className="notice warning">The report run has no recognized draft-only proposal. Refresh its saved result before review.</p>}
    {action.target_job_id && <details className="technical-details"><summary>Run details</summary><code>{action.target_job_id}</code>{action.last_error_code && <p>Code: <code>{action.last_error_code}</code></p>}{action.reflection_turn_id && <p>agent update: {reflection?.status ?? 'unavailable'}</p>}</details>}
    {action.last_error_code && <p className="notice warning">{saved ? 'agent update incomplete' : 'Could not finish'}: {action.last_error_code ? displayLabel(action.last_error_code) : null}</p>}
  </section>;
}

function ActionPlan({parameters}: {parameters: AgentActionParameters}) {
  const plan=parameters.approval_plan;
  if(!plan){
    if(parameters.test_kind)return <p className="fine-print"><strong>Creates:</strong> {parameters.test_kind.replaceAll('_',' ')} plan</p>;
    return null;
  }
  if(plan.kind==='blocked')return <p className="notice warning">This step is not ready: {plan.reason_code}</p>;
  if(plan.kind==='meterless_recall')return <details><summary>Review memory search</summary><dl><dt>Search</dt><dd>{plan.query}</dd><dt>Maximum results</dt><dd>{plan.max_results}</dd><dt>Saved memory version</dt><dd><code>{plan.catalog_hash}</code></dd></dl></details>;
  if(plan.kind==='test_plan_draft')return <p className="fine-print"><strong>Creates:</strong> {plan.test_kind.replaceAll('_',' ')} plan for this case revision</p>;
  const filters=[plan.request.flow_key&&`Flow: ${plan.request.flow_key}`,plan.request.release_id&&`Release: ${plan.request.release_id}`,plan.request.affected_cohort&&`Affected: ${plan.request.affected_cohort}`,plan.request.control_cohort&&`Control: ${plan.request.control_cohort}`].filter(Boolean);
  return <details open><summary>Review data access</summary><dl><dt>Connection</dt><dd>{plan.source_name} · <code>{plan.source_id}</code></dd><dt>Origin</dt><dd>{plan.approved_origin}</dd><dt>Account scope</dt><dd>{plan.approved_account_scope}</dd><dt>Template</dt><dd>{plan.request.template_id.replaceAll('_',' ')}</dd><dt>Views</dt><dd>{Object.entries(plan.request.view_ids).map(([role,id])=>`${role}: ${id}`).join(', ')}</dd><dt>Period</dt><dd>{plan.request.from} to {plan.request.to}</dd>{filters.length>0&&<><dt>Filters</dt><dd>{filters.join('; ')}</dd></>}<dt>Limit</dt><dd>Up to {plan.request.caps?.max_rows ?? 1000} rows in {plan.request.caps?.max_pages ?? 10} pages</dd><dt>Source binding</dt><dd><code>{plan.config_hash}</code></dd><dt>Query binding</dt><dd><code>{plan.request_hash}</code></dd></dl><p className="fine-print">Read only. Results stay restricted until reviewed.</p></details>;
}

export function AgentWorkspaceView({workspace, caseId, state, selectedSessionId, pending, activeJob, error, onSelectSession, onStart, onFollowUp, onAction, onMemoryFeedback, onSaveMemory, onWithdrawMemory, navigate, taskContent, onCloseTask, investigation, investigationLoading = false, onRetryInvestigation}: {
  investigation?: Pick<Investigation, 'title' | 'question'> | null; investigationLoading?: boolean; onRetryInvestigation?: () => void;
  taskContent?: React.ReactNode; onCloseTask?: () => void;
  workspace: Workspace; caseId: string; state: AgentWorkspaceState; selectedSessionId: string; pending: string; activeJob: Job | null; error: Error | null;
  onSelectSession: (id: string) => void; onStart: (event: FormEvent<HTMLFormElement>) => void; onFollowUp: (event: FormEvent<HTMLFormElement>) => void;
  onAction: (action: AgentAction, decision: 'approve' | 'dismiss') => void; onMemoryFeedback: (retrievalId: string, capsuleId: string, kind: MemoryFeedbackKind) => void; onSaveMemory: () => void; onWithdrawMemory: () => void; navigate: (path: string) => void;
}) {
  const available = state.model_profiles.filter(profile => profile.status === 'available'), selected = state.sessions.find(item => item.id === selectedSessionId) ?? state.sessions.at(-1), sessionProfile = available.find(profile => profile.id === selected?.profile_id), canWrite = workspace.role !== 'viewer';
  const canRequestModel = state.model_budget?.can_request !== false;
  const next = state.readiness.find(item => item.status !== 'complete');
  const latestTurn = selected?.turns.at(-1), visibleTurns = selected?.turns.filter(turn => turn.id === latestTurn?.id || turn.actions.some(action => ['suggested', 'approved', 'failed', 'cancelled'].includes(action.status))) ?? [], pastTurns = selected?.turns.filter(turn => !visibleTurns.includes(turn)) ?? [];
  const runActive = Boolean(selected?.turns.some(turn => ['queued', 'running'].includes(turn.status)) || (activeJob && ['queued', 'running', 'cancel_requested'].includes(activeJob.status)));
  const settings = `/w/${encodeURIComponent(workspace.id)}/settings/models`;
  const dataDestination = `/w/${encodeURIComponent(workspace.id)}/cases/${encodeURIComponent(caseId)}/data`;
  return <><button className="back-link" onClick={() => navigate(`/w/${workspace.id}/cases`)}>← All investigations</button><div className="page-heading"><h1>{investigation?.title ?? (investigationLoading ? 'Loading investigation…' : 'Investigation')}</h1></div>{investigation && <details className="case-brief"><summary>Your question</summary><p>{investigation.question}</p></details>}<ErrorNotice error={error} />{onRetryInvestigation && <button className="secondary" type="button" onClick={onRetryInvestigation}>Reload investigation</button>}
    {!canRequestModel && <p className="notice warning">agent limit reached. Saved work is available.</p>}
    <TaskNavigation readiness={state.readiness} stage={state.stage} navigate={navigate} />
    {taskContent && <section className="agent-task-workspace" aria-label="Current investigation task"><button className="back-link" type="button" onClick={onCloseTask}>← Back to investigation</button>{taskContent}</section>}
    <div className="agent-layout" hidden={Boolean(taskContent)}><section className="agent-conversation">
      {state.memory_candidate && <details className="agent-memory-option"><summary>Use report in future investigations</summary><h2>{state.memory_candidate.title}</h2>{state.memory_candidate.memory_status === 'not_saved' ? <><p>Save this reviewed report so Faultline can find it in similar cases.</p><button className="secondary" type="button" disabled={!canWrite || !!pending || !canRequestModel} onClick={onSaveMemory}>{pending === 'save-memory' ? 'Saving…' : 'Use this report in future cases'}</button></> : state.memory_candidate.memory_status === 'withdrawn' ? <Status tone="muted">Removed from future cases</Status> : <><Status tone={state.memory_candidate.memory_status === 'active' ? 'good' : 'warning'}>{state.memory_candidate.memory_status === 'active' ? 'Available to future cases' : 'Out of date'}</Status>{canWrite && <button className="text-button danger" type="button" disabled={!!pending} onClick={onWithdrawMemory}>{pending === 'withdraw-memory' ? 'Removing…' : 'Remove'}</button>}</>}</details>}
      {!state.sessions.length ? !available.length ? <section className="panel agent-start"><h2>Start with your data</h2><div className="button-row"><a className="primary button-link" href={dataDestination} onClick={event => link(event, dataDestination, navigate)}>{canWrite ? 'Add data' : 'View data'}</a><a className="secondary button-link" href={settings} onClick={event => link(event, settings, navigate)}>Connect agent</a></div></section> : <section className="panel agent-start"><h2>Start investigation</h2><form onSubmit={onStart}><details className="optional-fields"><summary>Add context</summary><Field label="Anything to focus on? (optional)"><textarea name="objective" maxLength={2000} rows={2} disabled={!canWrite || !!pending || !canRequestModel} placeholder="Mobile checkout" /></Field></details>{available.length === 1 ? <input type="hidden" name="profile_id" value={available[0]!.id} /> : <Field label="Agent model"><select name="profile_id" required>{available.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model_name}</option>)}</select></Field>}<button className="primary" disabled={!canWrite || !!pending || !canRequestModel}>{pending === 'start' ? 'Starting…' : canWrite ? 'Start investigation' : 'Viewer access'}</button></form><p className="fine-print">{available.length === 1 ? available[0]!.name : 'Your selected agent provider'} receives saved case data, sanitized evidence and conversation.</p></section> : <>
        {state.sessions.length > 1 && <Field label="Investigation run"><select value={selected?.id ?? ''} onChange={event => onSelectSession(event.target.value)}>{state.sessions.map(session => <option key={session.id} value={session.id}>{session.objective}</option>)}</select></Field>}
        {selected && <><details className="agent-objective"><summary>Investigation brief</summary><p>{selected.objective}</p><p>agent provider: {sessionProfile?.name ?? 'Unavailable'}. Receives reviewed case data and conversation.</p></details>{visibleTurns.map(turn => <TurnView workspaceId={workspace.id} caseId={caseId} navigate={navigate} canRequestModel={state.model_budget?.can_request !== false} key={turn.id} turn={turn} turns={selected.turns} canAct={canWrite} pending={pending} onAction={onAction} onMemoryFeedback={onMemoryFeedback} />)}{!!pastTurns.length && <details><summary>Earlier investigation activity ({pastTurns.length})</summary>{pastTurns.map(turn => <TurnView workspaceId={workspace.id} caseId={caseId} navigate={navigate} canRequestModel={state.model_budget?.can_request !== false} key={turn.id} turn={turn} turns={selected.turns} canAct={false} pending={pending} onAction={onAction} onMemoryFeedback={onMemoryFeedback} />)}</details>}
          {canWrite && sessionProfile ? <form className="agent-follow-up" onSubmit={onFollowUp}><details className="optional-fields"><summary>Add context</summary><Field label="Add context (optional)"><textarea name="message" maxLength={4000} disabled={!!pending || runActive || !canRequestModel} rows={2} placeholder="A recent release or customer report" /></Field></details><button className="primary" disabled={!!pending || runActive || !canRequestModel}>{pending === 'turn' ? 'Continuing…' : runActive ? 'Investigation running…' : 'Continue investigation'}</button></form> : !sessionProfile && <section className="notice warning"><strong>Agent model unavailable</strong><p>Reconnect this investigation’s model before continuing.</p><a href={settings} onClick={event => link(event, settings, navigate)}>Open Agent models</a></section>}</>}
      </>}
      {activeJob && ['failed', 'cancelled', 'stale'].includes(activeJob.status) && <div className="notice warning" role="status"><strong>Agent run {activeJob.status}</strong><p>{activeJob.error_code ? `Reason: ${activeJob.error_code}. ` : ''}No completed draft is assumed. Continue the investigation when the issue is resolved.</p></div>}
    </section></div></>;
}

export function AgentWorkspace({workspace, csrf, currentUserId, caseId, navigate}: {workspace: Workspace; csrf: string; currentUserId: string; caseId: string; navigate: (path: string) => void}) {
  const [investigation, setInvestigation] = useState<Investigation | null>(null), [investigationError, setInvestigationError] = useState<Error | null>(null), [investigationRefresh, setInvestigationRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setInvestigation(null); setInvestigationError(null);
    void boundedResource<Investigation>(casePath(workspace.id, caseId), controller.signal).then(value => {
      if (!value || value.id !== caseId || value.workspace_id !== workspace.id || typeof value.title !== 'string' || typeof value.question !== 'string') throw new Error('The investigation details are unavailable. Reload to try again.');
      if (!controller.signal.aborted) setInvestigation(value);
    }).catch(cause => {if (!controller.signal.aborted) setInvestigationError(formError(cause));});
    return () => controller.abort();
  }, [workspace.id, caseId, investigationRefresh]);
  const [task, setTask] = useState<AgentTask | null>(() => {const saved = new URLSearchParams(location.search).get('agent_task'); return saved ? agentTaskDestination(workspace.id, caseId, saved) : null;});
  const restoredActionIds = useRef(new Set<string>());
  const openTask = (destination: string) => {const embedded = agentTaskDestination(workspace.id, caseId, destination); if (embedded) {setTask(embedded); const url = new URL(location.href); url.searchParams.set('agent_task', destination); history.replaceState(null, '', url.pathname + url.search);} else navigate(destination);};
  const base = casePath(workspace.id, caseId), [state, setState] = useState<AgentWorkspaceState | null>(null), [known, setKnown] = useState(false), [error, setError] = useState<Error | null>(null), [pending, setPending] = useState(''), [selectedSessionId, setSelectedSessionId] = useState(''), [jobId, setJobId] = useState(''), [watchedActionId, setWatchedActionId] = useState(''), [activeJob, setActiveJob] = useState<Job | null>(null), startIdentity = useRef<CommandIdentity>(null), turnIdentity = useRef<CommandIdentity>(null), memoryIdentity = useRef<CommandIdentity>(null), withdrawMemoryIdentity = useRef<CommandIdentity>(null), actionPollAttempts = useRef(0), actionIdentities = useRef<Record<string, Identity>>({}), feedbackIdentities = useRef<Record<string, Identity>>({});
  const load = useCallback(async (signal?: AbortSignal) => {try {const value = await resource<AgentWorkspaceState>(`${base}/agent`, {signal}); if (!Array.isArray(value?.readiness) || !Array.isArray(value?.model_profiles) || !Array.isArray(value?.sessions) || !value.active_revision_id) throw new Error('The saved agent workspace was unavailable.'); if (!signal?.aborted) {setState(value); setKnown(true); setSelectedSessionId(current => value.sessions.some(item => item.id === current) ? current : value.sessions.at(-1)?.id ?? '');}} catch (cause) {if (!signal?.aborted) {setKnown(false); setError(formError(cause));}}}, [base]);
  useEffect(() => {const controller = new AbortController(); void load(controller.signal); return () => controller.abort();}, [load]);
  useEffect(() => {if (!jobId) return; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; async function poll() {try {const value = await resource<Job>(`${workspacePath(workspace.id)}/jobs/${encodeURIComponent(jobId)}`, {signal: controller.signal}); if (value.case_id && value.case_id !== caseId) throw new Error('The returned agent run belongs to another investigation.'); if (controller.signal.aborted) return; setActiveJob(value); if (['queued', 'running', 'cancel_requested'].includes(value.status)) timer = setTimeout(poll, 2000); else {await load(); setJobId('');}} catch (cause) {if (!controller.signal.aborted) setError(formError(cause));}} void poll(); return () => {controller.abort(); if (timer) clearTimeout(timer);};}, [jobId, workspace.id, caseId, load]);
  useEffect(() => {
    if (!known) return;
    const discovered = pendingAgentTurnJob(state, selectedSessionId, caseId, jobId, activeJob);
    if (discovered) {setJobId(discovered); setActiveJob(null);}
  }, [known, state, selectedSessionId, caseId, jobId, activeJob]);
  useEffect(() => {
    if (!known || pending || watchedActionId || (activeJob?.case_id && activeJob.case_id !== caseId)) return;
    const restored = pendingAgentToolAction(state, selectedSessionId, jobId, restoredActionIds.current);
    if (!restored) return;
    // Restore each saved action once per mount. The existing bounded watcher
    // refreshes until its reflection appears; timing out must not reset its cap.
    restoredActionIds.current.add(restored.id);
    actionPollAttempts.current = 0;
    setWatchedActionId(restored.id);
    const alreadyTerminal = activeJob?.id === restored.target_job_id && !['queued', 'running', 'cancel_requested'].includes(activeJob.status);
    if (!alreadyTerminal) {setJobId(restored.target_job_id!); setActiveJob(null);}
  }, [known, pending, watchedActionId, activeJob, caseId, state, selectedSessionId, jobId]);
  useEffect(() => {if (!watchedActionId || !state) return; const watched = state.sessions.flatMap(session => session.turns).flatMap(turn => turn.actions).find(item => item.id === watchedActionId); if (!agentActionNeedsRefresh(watched)) {setWatchedActionId(''); actionPollAttempts.current = 0; return;} if (actionPollAttempts.current >= 60) {setWatchedActionId(''); setError(new Error('The run finished, but its agent update is still pending. Refresh to check again.')); return;} const controller = new AbortController(), timer = setTimeout(() => {actionPollAttempts.current += 1; void load(controller.signal);}, 2000); return () => {controller.abort(); clearTimeout(timer);};}, [watchedActionId, state, load]);
  async function start(event: FormEvent<HTMLFormElement>) {event.preventDefault(); if (!state) return; const form = new FormData(event.currentTarget); setPending('start'); setError(null); try {const value = await startAgentSession({base, csrf, objective: String(form.get('objective') ?? ''), profileId: String(form.get('profile_id')), revisionId: state.active_revision_id, identity: startIdentity}); setSelectedSessionId(value.session_id); setJobId(value.job_id); setActiveJob(null); await load();} catch (cause) {setError(formError(cause));} finally {setPending('');}}
  async function followUp(event: FormEvent<HTMLFormElement>) {event.preventDefault(); if (!state || !selectedSessionId) return; const selected = state.sessions.find(item => item.id === selectedSessionId); if (!selected) return; const element = event.currentTarget, form = new FormData(element); setPending('turn'); setError(null); try {const value = await appendAgentTurn({base, csrf, sessionId: selectedSessionId, message: String(form.get('message') ?? ''), profileId: selected.profile_id, revisionId: state.active_revision_id, identity: turnIdentity}); element.reset(); setJobId(value.job_id); setActiveJob(null); await load();} catch (cause) {setError(formError(cause));} finally {setPending('');}}
  async function action(action: AgentAction, decision: 'approve' | 'dismiss') {const slot = actionIdentities.current[`${action.id}:${decision}`] ??= {current: null}; setPending(action.id); setError(null); try {const reviewed = await reviewAgentAction({base, csrf, action, decision, identity: slot}), outcome = approvedActionOutcome(reviewed); await load(); if (decision === 'approve' && outcome.job_id) {restoredActionIds.current.add(action.id); actionPollAttempts.current = 0; setWatchedActionId(action.id); setJobId(outcome.job_id); setActiveJob(null);} else if (decision === 'approve' && outcome.destination) openTask(outcome.destination);} catch (cause) {setError(formError(cause));} finally {setPending('');}}
  async function memoryFeedback(retrievalId: string, capsuleId: string, kind: MemoryFeedbackKind) {const key = `${retrievalId}:${capsuleId}:${kind}`, slot = feedbackIdentities.current[key] ??= {current: null}; setPending(`memory:${capsuleId}:${kind}`); setError(null); try {await submitMemoryFeedback({base, csrf, retrievalId, capsuleId, kind, identity: slot}); await load();} catch (cause) {setError(formError(cause));} finally {setPending('');}}
  async function saveMemory() {if (!state?.memory_candidate || state.memory_candidate.saved) return; setPending('save-memory'); setError(null); try {await saveReportForFuture({base, csrf, reportId: state.memory_candidate.report_id, identity: memoryIdentity}); await load();} catch (cause) {setError(formError(cause));} finally {setPending('');}}
  async function withdrawMemory() {const candidate = state?.memory_candidate; if (!candidate?.capsule_id || !candidate.capsule_hash || !['active', 'stale'].includes(candidate.memory_status)) return; setPending('withdraw-memory'); setError(null); try {await withdrawReportFromFuture({base, csrf, capsuleId: candidate.capsule_id, capsuleHash: candidate.capsule_hash, identity: withdrawMemoryIdentity}); await load();} catch (cause) {setError(formError(cause));} finally {setPending('');}}
  if (!known && !state) return <><ErrorNotice error={error} />{!error && <Loading label="Loading agent…" />}</>;
  if (!state) return null;
  return <AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} investigation={investigation} investigationLoading={!investigation && !investigationError} onRetryInvestigation={investigationError ? () => setInvestigationRefresh(value => value + 1) : undefined} selectedSessionId={selectedSessionId} pending={pending} activeJob={activeJob} error={error ?? investigationError} onSelectSession={setSelectedSessionId} onStart={start} onFollowUp={followUp} onAction={(item, decision) => void action(item, decision)} onMemoryFeedback={(retrievalId, capsuleId, kind) => void memoryFeedback(retrievalId, capsuleId, kind)} onSaveMemory={() => void saveMemory()} onWithdrawMemory={() => void withdrawMemory()} navigate={openTask} onCloseTask={() => {setTask(null); const url = new URL(location.href); url.searchParams.delete('agent_task'); history.replaceState(null, '', url.pathname + url.search); void load();}} taskContent={task && <Suspense fallback={<Loading label="Loading investigation task…" />}>{task.kind === 'data' ? <EmbeddedDataWorkflow workspace={workspace} csrf={csrf} caseId={caseId} navigate={openTask} embedded onChanged={load} /> : <EmbeddedInvestigationWorkspace key={task.destination} workspace={workspace} csrf={csrf} currentUserId={currentUserId} caseId={caseId} navigate={openTask} embedded initialSection={task.section} initialDiagnosisProposalId={task.diagnosisProposalId} preferredModelProfileId={state.sessions.find(item => item.id === selectedSessionId)?.profile_id} onChanged={load} />}</Suspense>} />;
}
