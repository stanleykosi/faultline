import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Workspace} from '../../api';
import type {CommandIdentity} from '../../command-key';
import {
  AgentWorkspaceView,
  completedReportProposal,
  reportReviewDestination,
  appendAgentTurn,
  actionDestination,
  agentActionNeedsRefresh,
  agentTaskDestination,
  pendingAgentTurnJob,
  pendingAgentToolAction,
  approvedActionOutcome,
  reviewAgentAction,
  savedToolSucceeded,
  modelDraftNeedsReview,
  saveReportForFuture,
  startAgentSession,
  submitMemoryFeedback,
  withdrawReportFromFuture,
  type AgentAction,
  type AgentActionKind,
  type AgentResponse,
  type AgentWorkspaceState,
} from './AgentWorkspace';

const workspace: Workspace = {id: '11111111-1111-4111-8111-111111111111', name: 'Product team', role: 'owner', revision: 2, created_at: '2026-10-19T10:00:00.000Z'};
const caseId = '22222222-2222-4222-8222-222222222222';
const base = `/api/v1/workspaces/${workspace.id}/cases/${caseId}`;
const revisionId = '33333333-3333-4333-8333-333333333333';
const readiness = [
  {key: 'data', label: 'Connect data', status: 'ready' as const, destination: `/w/${workspace.id}/cases/${caseId}/data`},
  {key: 'measure', label: 'Measure', status: 'blocked' as const, destination: ''},
  {key: 'explain', label: 'Find causes', status: 'blocked' as const, destination: ''},
  {key: 'test', label: 'Test', status: 'blocked' as const, destination: ''},
  {key: 'report', label: 'Report', status: 'blocked' as const, destination: ''},
  {key: 'follow_up', label: 'Follow up', status: 'blocked' as const, destination: ''},
];
const emptyState: AgentWorkspaceState = {stage: 'setup', readiness, active_revision_id: revisionId, model_profiles: [], sessions: [], memory_candidate: null};
const callbacks = {onSelectSession: () => {}, onStart: () => {}, onFollowUp: () => {}, onAction: () => {}, onMemoryFeedback: () => {}, onSaveMemory: () => {}, onWithdrawMemory: () => {}, navigate: () => {}};
const identity = (): {current: CommandIdentity} => ({current: null});
const action = (overrides: Partial<AgentAction> = {}): AgentAction => ({id: '44444444-4444-4444-8444-444444444444', kind: 'open_browser_tests', title: 'Review a browser test', reason: 'Reproduce the suspected mechanism.', parameters: {}, requires_approval: true, status: 'suggested', binding_hash: 'a'.repeat(64), target_job_id: null, tool_result: null, reflection_turn_id: null, last_error_code: null, created_at: '', updated_at: '', ...overrides});

test('an embedded task hides but retains agent drafts and uses one accessible task navigation',()=>{
  const state={...emptyState,model_profiles:[{id:'profile-one',name:'OpenRouter',model_name:'chosen/model',provider:'openrouter',status:'available'}]};
  const html=renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} taskContent={<form aria-label="Data review"><input name="source" /></form>} />);
  assert.equal((html.match(/aria-label="Investigation tasks"/g)??[]).length,1);
  assert.match(html,/aria-current="step"/);assert.match(html,/aria-label="Measure" aria-description="Blocked"/);
  assert.match(html,/class="agent-layout" hidden=""/);
  assert.match(html,/name="objective"/,'Keep the form mounted so task navigation retains unsaved context');
  assert.match(html,/aria-label="Data review"/);
});

test('no-model onboarding keeps all six honest stages visible', () => {
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={emptyState} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, />Add data<\/a>/); assert.match(html, />Connect agent<\/a>/); assert.match(html, new RegExp(`/w/${workspace.id}/settings/models`));
  assert.match(html, new RegExp(`/w/${workspace.id}/cases/${caseId}/data`));
  for (const label of ['Connect data', 'Measure', 'Find causes', 'Test', 'Report', 'Follow up']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /verified finding|>PASS</);
});

test('a saved investigation shows its own identity without executing its input or requiring model setup', () => {
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={emptyState} investigation={{title:'Checkout drop <script>run()</script>',question:'Why did <img src=x onerror=run()> checkout fall?'}} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /<h1>Checkout drop &lt;script&gt;run\(\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /Why did &lt;img src=x onerror=run\(\)&gt; checkout fall\?/);
  assert.match(html, />Add data<\/a>/);
  assert.doesNotMatch(html, /<script>|<img|Connect agent to begin|name="profile_id"/);
});

test('unavailable case identity has a retry and never asserts that a saved case was verified', () => {
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={emptyState} investigation={null} error={new Error('Investigation details unavailable.')} onRetryInvestigation={()=>{}} selectedSessionId="" pending="" activeJob={null} {...callbacks} />);
  assert.match(html, /role="alert"/); assert.match(html, />Reload investigation<\/button>/);
  assert.doesNotMatch(html, /class="case-brief"|>Saved<|>PASS</);
});

test('session start posts only the optional bounded focus, selected profile and active revision', async () => {
  const original = globalThis.fetch, calls: {path: string; options?: RequestInit}[] = [];
  globalThis.fetch = async (path, options) => {calls.push({path: String(path), options}); return new Response(JSON.stringify({data: {session_id: 'session-one', turn_id: 'turn-one', job_id: 'job-one', status: 'queued'}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    assert.equal((await startAgentSession({base, csrf: 'csrf-value', objective: '  Explain the mobile conversion decline.  ', profileId: 'profile-one', revisionId, identity: identity()})).job_id, 'job-one');
    assert.equal(calls.length, 1); assert.equal(calls[0]?.path, `${base}/agent/sessions`); assert.equal(calls[0]?.options?.method, 'POST');
    const headers = new Headers(calls[0]?.options?.headers); assert.equal(headers.get('X-CSRF-Token'), 'csrf-value'); assert.ok(headers.get('Idempotency-Key'));
    assert.deepEqual(JSON.parse(String(calls[0]?.options?.body)), {objective: 'Explain the mobile conversion decline.', profile_id: 'profile-one', revision_id: revisionId});
  } finally {globalThis.fetch = original;}
});

test('start investigation needs no written prompt and preserves provider disclosure', () => {
  const state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}]};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /<h2>Start investigation<\/h2>/);
  assert.match(html, /Anything to focus on\? \(optional\)/);
  assert.match(html, /type="hidden" name="profile_id" value="profile-one"/);
  assert.doesNotMatch(html, /<select name="profile_id"/);
  assert.match(html, /<textarea[^>]*name="objective"[^>]*maxLength="2000"/);
  assert.doesNotMatch(html, /<textarea[^>]*required/);
  assert.match(html, /OpenRouter receives saved case data, sanitized evidence and conversation/);
});

test('blank or omitted focus starts the built-in case investigation without an objective property', async () => {
  const original = globalThis.fetch, calls: RequestInit[] = [];
  globalThis.fetch = async (_path, options) => {calls.push(options!); return new Response(JSON.stringify({data: {session_id: 'session-one', turn_id: 'turn-one', job_id: 'job-one', status: 'queued'}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    for (const objective of [undefined, '', '  ']) await startAgentSession({base, csrf: 'csrf-value', objective, profileId: 'profile-one', revisionId, identity: identity()});
    assert.equal(calls.length, 3);
    for (const call of calls) assert.deepEqual(JSON.parse(String(call.body)), {profile_id: 'profile-one', revision_id: revisionId});
  } finally {globalThis.fetch = original;}
});

test('blank continue resumes the built-in investigation while optional context remains bounded', async () => {
  const original = globalThis.fetch, calls: {path: string; options?: RequestInit}[] = [];
  globalThis.fetch = async (path, options) => {calls.push({path: String(path), options}); return new Response(JSON.stringify({data: {session_id: 'session-one', turn_id: 'turn-two', job_id: 'job-two', status: 'queued'}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    for (const message of [undefined, '  ', '  A new release is available.  ']) await appendAgentTurn({base, csrf: 'csrf-value', sessionId: 'session-one', message, profileId: 'profile-one', revisionId, identity: identity()});
    assert.equal(calls.length, 3);
    for (const call of calls) {assert.equal(call.path, `${base}/agent/sessions/session-one/turns`); assert.ok(new Headers(call.options?.headers).get('Idempotency-Key'));}
    assert.deepEqual(JSON.parse(String(calls[0]?.options?.body)), {profile_id: 'profile-one', revision_id: revisionId});
    assert.deepEqual(JSON.parse(String(calls[1]?.options?.body)), {profile_id: 'profile-one', revision_id: revisionId});
    assert.deepEqual(JSON.parse(String(calls[2]?.options?.body)), {profile_id: 'profile-one', revision_id: revisionId, message: 'A new release is available.'});
    await assert.rejects(appendAgentTurn({base, csrf: 'csrf-value', sessionId: 'session-one', message: 'a'.repeat(4001), profileId: 'profile-one', revisionId, identity: identity()}), /4000 characters/);
    assert.equal(calls.length, 3);
  } finally {globalThis.fetch = original;}
});

test('an excessive optional focus or missing model cannot submit a start request', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => {calls += 1; throw new Error('Unexpected request');};
  try {
    await assert.rejects(startAgentSession({base, csrf: 'csrf-value', objective: 'a'.repeat(2001), profileId: 'profile-one', revisionId, identity: identity()}), /2000 characters/);
    await assert.rejects(startAgentSession({base, csrf: 'csrf-value', profileId: '', revisionId, identity: identity()}), /available Agent model/);
    assert.equal(calls, 0);
  } finally {globalThis.fetch = original;}
});

test('viewer cannot start an investigation and unavailable models do not show a start form', () => {
  const state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}]};
  const viewerHtml = renderToStaticMarkup(<AgentWorkspaceView workspace={{...workspace, role: 'viewer'}} caseId={caseId} state={state} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(viewerHtml, /<button[^>]*disabled="">Viewer access<\/button>/);
  assert.match(viewerHtml, /<textarea[^>]*disabled=""/);
  const noModelHtml = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={{...state, model_profiles: [{...state.model_profiles[0]!, status: 'unavailable'}]}} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(noModelHtml, /Connect agent/);
  assert.doesNotMatch(noModelHtml, /<form|name="objective"/);
});

test('a failed turn stays failed and offers retry without inventing a result', () => {
  const state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}], sessions: [{id: 'session-one', objective: 'Explain the decline', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'turn-one', user_message: 'Check the evidence', status: 'failed', response: null, error_code: 'MODEL_UNAVAILABLE', job_id: 'job-one', memory: null, created_at: '', updated_at: '', actions: []}]}]};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Agent turn failed/); assert.match(html, /Agent unavailable/); assert.match(html, /No draft or verified result was created/); assert.match(html, /continue the investigation to retry/i); assert.match(html, /Add context \(optional\)/); assert.match(html, />Continue investigation<\/button>/); assert.doesNotMatch(html, /<textarea[^>]*required/); assert.doesNotMatch(html, />PASS</);
});

test('v2 reasoning shows competing explanations, evidence direction, falsifier, unknowns, and related-case feedback', () => {
  const step = action({kind: 'recall_prior_investigations', title: 'Find similar cases', reason: 'Check whether a reviewed case has useful context.', parameters: {query: 'mobile checkout'}});
  const state: AgentWorkspaceState = {...emptyState, stage: 'explain', model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}], sessions: [{id: 'session-one', objective: 'Explain mobile checkout decline', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'turn-one', user_message: 'What should we examine?', status: 'succeeded', error_code: null, job_id: 'job-one', created_at: '', updated_at: '', actions: [step], memory: {id: '55555555-5555-4555-8555-555555555555', status: 'complete', metrics: null, created_at: '', capsules: [{relevance: 0.82, capsule: {capsule_id: '66666666-6666-4666-8666-666666666666', source_case_id: '77777777-7777-4777-8777-777777777777', published_report_id: '88888888-8888-4888-8888-888888888888', affected_flow: 'Mobile checkout', accepted_findings: [{text: 'A reviewed release exposure matched the affected cohort.', evidence_ids: ['evidence-release']}], rejected_or_unresolved_alternatives: [], falsifiers: ['No difference under a controlled comparison.'], limitations: ['The prior case did not establish aggregate causation.'], follow_up_outcome: null, accepted_at: '', capsule_hash: 'd'.repeat(64)}}]}, response: {schema_version: 2, revision_id: revisionId, input_hash: 'c'.repeat(64), stage: 'explain', message: 'Release timing is associated with the decline and needs a controlled test.', evidence_ids: ['evidence-analytics', 'evidence-release'], memory_capsule_ids: ['66666666-6666-4666-8666-666666666666'], analysis: {current_belief: 'Release exposure is a plausible explanation.', what_changed: 'A related reviewed case is now available.', hypotheses: [{title: 'Release exposure', statement: 'Exposure may be associated with the observed change.', supporting_evidence_ids: ['evidence-release'], contradicting_evidence_ids: ['evidence-control'], memory_capsule_ids: ['66666666-6666-4666-8666-666666666666'], falsifier: 'A controlled comparison with no effect would weaken this explanation.', confidence: 'low'}], unknowns: ['The mechanism has not been reproduced.']}, actions: [{kind: step.kind, title: step.title, reason: step.reason, requires_approval: true, parameters: step.parameters}], questions: ['Did affected sessions receive the release?'], limitations: ['Exposure is not established.']}}]}]};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
  for (const text of ['Current view', 'Release exposure is a plausible explanation', 'What changed', 'Possible explanations', 'Supporting evidence', 'Opposing evidence', 'What would change this', 'low confidence', 'Still unknown', 'Related past cases', 'Used in this draft', 'Helpful', 'Not relevant', 'Wrong', 'Approve']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /root cause|>PASS</i);
});

test('approval shows the exact bounded Zetaris source, views, filters, limits, and hashes', () => {
  const step = action({
    kind: 'gather_related_evidence', title: 'Check release exposure', reason: 'Read the approved related views.',
    parameters: {template_id: 'release_exposure', release_id: 'release-one', approval_plan: {
      schema_version: 1, kind: 'zetaris_federated_query', source_id: 'source-one', source_name: 'Product warehouse', source_revision: 4,
      config_hash: 'a'.repeat(64), probe_binding_hash: 'b'.repeat(64), credential_version: 2, approved_origin: 'https://warehouse.example', approved_account_scope: 'read:product', request_hash: 'c'.repeat(64),
      request: {template_id: 'release_exposure', view_ids: {sessions: 'session-view', releases: 'release-view'}, from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', case_key: caseId, flow_key: 'checkout', release_id: 'release-one', caps: {max_rows: 1000, max_pages: 10}},
    }},
  });
  const response: AgentResponse={schema_version: 2, revision_id: revisionId, input_hash: 'd'.repeat(64), stage: 'explain', message: 'Review this bounded query.', evidence_ids: [], memory_capsule_ids: [], analysis: {current_belief: 'Release exposure remains a hypothesis.', what_changed: 'A reviewed query is ready.', hypotheses: [], unknowns: []}, actions: [], questions: [], limitations: ['This cannot establish aggregate causation.']};
  const state: AgentWorkspaceState={...emptyState, stage: 'explain', model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}], sessions: [{id: 'session-one', objective: 'Explain checkout decline', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'turn-one', user_message: 'Gather context', status: 'succeeded', response, error_code: null, job_id: 'job-one', memory: null, created_at: '', updated_at: '', actions: [step]}]}]};
  const html=renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
  for(const value of ['Review data access','Product warehouse','release exposure','sessions: session-view','2026-10-01T00:00:00.000Z','Release: release-one','Up to 1000 rows in 10 pages','a'.repeat(64),'c'.repeat(64),'Read only'])assert.ok(html.includes(value),value);
});

test('approval accepts a queued tool job and polling wins over navigation', async () => {
  const original = globalThis.fetch, item = action({kind: 'generate_hypotheses'}); let options: RequestInit | undefined;
  globalThis.fetch = async (_path, sent) => {options = sent; return new Response(JSON.stringify({data: {id: item.id, status: 'approved', binding_hash: item.binding_hash, target_job_id: 'job-two', destination: '/must-not-open', reflection_turn_id: null}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    const reviewed = await reviewAgentAction({base, csrf: 'csrf-review', action: item, decision: 'approve', identity: identity()});
    assert.deepEqual(approvedActionOutcome(reviewed), {job_id: 'job-two', destination: null, reflection_turn_id: null});
    const headers = new Headers(options?.headers); assert.equal(headers.get('X-Faultline-Revision'), item.binding_hash); assert.equal(headers.get('X-CSRF-Token'), 'csrf-review'); assert.deepEqual(JSON.parse(String(options?.body)), {reviewed: true});
  } finally {globalThis.fetch = original;}
});

test('failed and cancelled actions retry the exact bound approval without offering dismissal', async () => {
  const original = globalThis.fetch, calls: {path: string; options?: RequestInit}[] = [], failed = action({status: 'failed', target_job_id: 'failed-job', last_error_code: 'MODEL_CALL_FAILED'}), cancelled = action({id: '55555555-5555-4555-8555-555555555555', status: 'cancelled', target_job_id: 'completed-job', last_error_code: 'MODEL_CANCELLED'});
  globalThis.fetch = async (path, options) => {calls.push({path: String(path), options}); const current = calls.length === 1 ? failed : cancelled; return new Response(JSON.stringify({data: {id: current.id, status: 'approved', binding_hash: current.binding_hash, target_job_id: calls.length === 1 ? 'retry-job' : 'completed-job', destination: null, reflection_turn_id: null}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    assert.equal((await reviewAgentAction({base, csrf: 'csrf-retry', action: failed, decision: 'approve', identity: identity()})).target_job_id, 'retry-job');
    assert.equal((await reviewAgentAction({base, csrf: 'csrf-retry', action: cancelled, decision: 'approve', identity: identity()})).target_job_id, 'completed-job');
    for (const [index, item] of [failed, cancelled].entries()) {const sent = calls[index]; assert.equal(sent?.path, `${base}/agent/actions/${item.id}/approve`); const headers = new Headers(sent?.options?.headers); assert.equal(headers.get('X-Faultline-Revision'), item.binding_hash); assert.deepEqual(JSON.parse(String(sent?.options?.body)), {reviewed: true});}
    const state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}], sessions: [{id: 'session-one', objective: 'Explain the decline', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'turn-one', user_message: 'Try the next step', status: 'succeeded', response: {schema_version: 2, revision_id: revisionId, input_hash: 'c'.repeat(64), stage: 'setup', message: 'The approved step did not finish.', evidence_ids: [], memory_capsule_ids: [], analysis: {current_belief: 'The result remains unknown.', what_changed: 'The approved run failed.', hypotheses: [], unknowns: ['The tool result is unavailable.']}, actions: [], questions: [], limitations: ['No tool result was accepted.']}, error_code: null, job_id: 'agent-job', memory: null, created_at: '', updated_at: '', actions: [failed, cancelled]}]}]};
    const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
    assert.equal((html.match(/>Retry<\/button>/g) ?? []).length, 2); assert.doesNotMatch(html, />Dismiss<\/button>/);
  } finally {globalThis.fetch = original;}
});

test('a completed recall is accepted without inventing a job or destination', async () => {
  const original = globalThis.fetch, item = action({kind: 'recall_prior_investigations', parameters: {query: 'checkout'}});
  globalThis.fetch = async () => new Response(JSON.stringify({data: {id: item.id, status: 'completed', binding_hash: item.binding_hash, target_job_id: null, destination: null, reflection_turn_id: '99999999-9999-4999-8999-999999999999'}}), {headers: {'Content-Type': 'application/json'}});
  try {
    const reviewed = await reviewAgentAction({base, csrf: 'csrf-review', action: item, decision: 'approve', identity: identity()});
    assert.deepEqual(approvedActionOutcome(reviewed), {job_id: null, destination: null, reflection_turn_id: '99999999-9999-4999-8999-999999999999'});
  } finally {globalThis.fetch = original;}
});

test('tool reflections are labeled separately and terminal action states stop follow-through polling', () => {
  const completed = action({status: 'completed', reflection_turn_id: '99999999-9999-4999-8999-999999999999'}), state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}], sessions: [{id: 'session-one', objective: 'Explain the decline', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'turn-tool', message_kind: 'tool', user_message: 'Approved tool result: {"status":"succeeded"}', status: 'queued', response: null, error_code: null, job_id: 'job-reflect', memory: null, created_at: '', updated_at: '', actions: []}]}]};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Tool result/); assert.match(html, /View saved result/); assert.doesNotMatch(html, /<p class="eyebrow">You<\/p>/);
  assert.equal(agentActionNeedsRefresh(action({status: 'approved'})), true);
  assert.equal(agentActionNeedsRefresh(completed), false);
  assert.equal(agentActionNeedsRefresh(action({status: 'failed'})), false);
});

test('memory feedback posts one bounded rating to the exact retrieval and capsule', async () => {
  const original = globalThis.fetch; let call: {path: string; options?: RequestInit} | undefined;
  const retrievalId = '55555555-5555-4555-8555-555555555555', capsuleId = '66666666-6666-4666-8666-666666666666';
  globalThis.fetch = async (path, options) => {call = {path: String(path), options}; return new Response(JSON.stringify({data: {id: 'feedback-one', capsule_id: capsuleId, kind: 'not_relevant', applied: true}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    await submitMemoryFeedback({base, csrf: 'csrf-memory', retrievalId, capsuleId, kind: 'not_relevant', identity: identity()});
    assert.equal(call?.path, `${base}/agent/memory/retrievals/${retrievalId}/capsules/${capsuleId}/feedback`); assert.equal(call?.options?.method, 'POST');
    const headers = new Headers(call?.options?.headers); assert.equal(headers.get('X-CSRF-Token'), 'csrf-memory'); assert.ok(headers.get('Idempotency-Key'));
    assert.deepEqual(JSON.parse(String(call?.options?.body)), {kind: 'not_relevant'});
  } finally {globalThis.fetch = original;}
});

test('a current published report has an explicit accepted-memory write', async () => {
  const candidate = {...emptyState, memory_candidate: {report_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Checkout findings', saved: false, capsule_id: null, capsule_hash: null, memory_status: 'not_saved' as const}};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={candidate} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Use this report in future cases/); assert.doesNotMatch(html, /saved automatically/i);
  const original = globalThis.fetch; let call: {path: string; options?: RequestInit} | undefined;
  globalThis.fetch = async (path, options) => {call = {path: String(path), options}; return new Response(JSON.stringify({data: {id: 'capsule-one', capsule_hash: 'b'.repeat(64), status: 'active'}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    await saveReportForFuture({base, csrf: 'csrf-save', reportId: candidate.memory_candidate.report_id, identity: identity()});
    assert.equal(call?.path, `${base}/agent/memory`); assert.deepEqual(JSON.parse(String(call?.options?.body)), {report_id: candidate.memory_candidate.report_id, reviewed: true});
  } finally {globalThis.fetch = original;}
});

test('active or stale investigation memory can be removed with its exact capsule hash', async () => {
  const capsuleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', capsuleHash = 'e'.repeat(64), candidate: AgentWorkspaceState = {...emptyState, memory_candidate: {report_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Old checkout findings', saved: false, capsule_id: capsuleId, capsule_hash: capsuleHash, memory_status: 'stale'}};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={candidate} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Out of date/); assert.match(html, />Remove<\/button>/); assert.doesNotMatch(html, /Use this report in future cases/);
  const original = globalThis.fetch; let call: {path: string; options?: RequestInit} | undefined;
  globalThis.fetch = async (path, options) => {call = {path: String(path), options}; return new Response(JSON.stringify({data: {id: capsuleId, capsule_hash: capsuleHash, status: 'withdrawn'}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    await withdrawReportFromFuture({base, csrf: 'csrf-withdraw', capsuleId, capsuleHash, identity: identity()});
    assert.equal(call?.path, `${base}/agent/memory/${capsuleId}/withdraw`); const headers = new Headers(call?.options?.headers); assert.equal(headers.get('X-Faultline-Revision'), capsuleHash); assert.equal(headers.get('X-CSRF-Token'), 'csrf-withdraw'); assert.deepEqual(JSON.parse(String(call?.options?.body)), {reason: 'No longer use this report in future investigations.'});
  } finally {globalThis.fetch = original;}
});

test('all thirteen action kinds have a bounded navigation or no navigation', () => {
  const root = `/w/${workspace.id}/cases/${caseId}`, kinds: AgentActionKind[] = ['open_data', 'review_metric', 'generate_hypotheses', 'open_evidence', 'open_data_checks', 'open_browser_tests', 'draft_report', 'open_follow_up', 'gather_related_evidence', 'recall_prior_investigations', 'review_results', 'draft_test_plan', 'schedule_follow_up'];
  assert.equal(kinds.length, 13);
  assert.equal(actionDestination(workspace.id, caseId, 'open_data'), `${root}/data`);
  assert.equal(actionDestination(workspace.id, caseId, 'review_results'), `${root}/investigation?tab=tests`);
  assert.equal(actionDestination(workspace.id, caseId, 'schedule_follow_up'), `${root}/investigation?tab=followup`);
  for (const kind of ['generate_hypotheses', 'draft_report', 'gather_related_evidence', 'recall_prior_investigations'] as AgentActionKind[]) assert.equal(actionDestination(workspace.id, caseId, kind), null);
  for (const kind of kinds) assert.ok(actionDestination(workspace.id, caseId, kind) === null || actionDestination(workspace.id, caseId, kind)?.startsWith(root));
});


test('task destinations embed only known sections of this exact investigation', () => {
  const root = `/w/${workspace.id}/cases/${caseId}`;
  assert.deepEqual(agentTaskDestination(workspace.id, caseId, `${root}/data`), {kind: 'data', destination: `${root}/data`});
  for (const section of ['evidence', 'timeline', 'hypotheses', 'tests', 'verification', 'staging', 'reports', 'discussion', 'followup']) assert.deepEqual(agentTaskDestination(workspace.id, caseId, `${root}/investigation?tab=${section}`), {kind: 'investigation', destination: `${root}/investigation?tab=${section}`, section});
  for (const destination of [`https://external.example${root}/data`, `${root}/data?anything=true`, `${root}/investigation?tab=unknown`, `${root}/investigation?tab=tests&tab=reports`, `${root}/investigation?tab=tests&redirect=external`, `/w/other/cases/${caseId}/data`, `/w/${workspace.id}/cases/other/data`, `${root}/overview`, `${root}/investigation?tab=tests#other`]) assert.equal(agentTaskDestination(workspace.id, caseId, destination), null, destination);
});

test('the workbench presents embedded real task content and a return control without route tabs', () => {
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={emptyState} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} taskContent={<section>Connected data task</section>} onCloseTask={() => {}} />);
  assert.match(html, /aria-label="Investigation tasks"/); assert.match(html, /aria-label="Current investigation task"/); assert.match(html, /Connected data task/); assert.match(html, /Back to investigation/);
  assert.doesNotMatch(html, /aria-label="Case navigation"/);
});

test('older pending decisions stay primary while settled history is collapsed', () => {
  const response: AgentResponse = {schema_version: 2, revision_id: revisionId, input_hash: 'd'.repeat(64), stage: 'explain', message: 'Current assessment', evidence_ids: [], memory_capsule_ids: [], analysis: {current_belief: 'A possible explanation', what_changed: 'More data arrived', hypotheses: [], unknowns: []}, actions: [], questions: [], limitations: []};
  const turn = (id: string, actions: AgentAction[]) => ({id, user_message: 'Saved context', status: 'succeeded', response, error_code: null, job_id: null, created_at: '', updated_at: '', actions, memory: null});
  const state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}], sessions: [{id: 'session-one', objective: 'Investigate the case', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [turn('settled', []), turn('pending', [action({title: 'Older decision to review'})]), turn('latest', [])]}]};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /<details><summary>Earlier investigation activity \(1\)<\/summary>/);
  assert.ok(html.indexOf('Older decision to review') < html.indexOf('Earlier investigation activity'));
  assert.equal((html.match(/>Approve<\/button>/g) ?? []).length, 1);
  assert.match(html, /<details class="agent-objective"><summary>Investigation brief/);
});


test('a queued investigation disables continue instead of starting another model turn', () => {
  const state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'profile-one', name: 'OpenRouter', model_name: 'chosen/model', provider: 'openrouter', status: 'available'}], sessions: [{id: 'session-one', objective: 'Investigate the case', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'queued-turn', user_message: 'Built-in mission', status: 'queued', response: null, error_code: null, job_id: 'job-one', created_at: '', updated_at: '', actions: [], memory: null}]}]};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /<button[^>]*disabled="">Investigation running…<\/button>/);
  assert.match(html, /<textarea[^>]*name="message"[^>]*disabled=""/);
});


test('saved pending turns resume polling on reload and follow reflection jobs after tool completion', () => {
  const state: AgentWorkspaceState = {...emptyState, sessions: [{id: 'session-one', objective: 'Investigate', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'reflection-turn', message_kind: 'tool', user_message: 'Approved result', status: 'queued', response: null, error_code: null, job_id: 'reflection-job', created_at: '', updated_at: '', actions: [], memory: null}]}]};
  assert.equal(pendingAgentTurnJob(state, 'session-one', caseId, '', null), 'reflection-job', 'synchronous recall reflection or reload');
  assert.equal(pendingAgentTurnJob(state, 'session-one', caseId, 'tool-job', {id: 'tool-job', case_id: caseId, status: 'running', result: null}), null, 'do not replace tracked tool polling');
  assert.equal(pendingAgentTurnJob(state, 'session-one', caseId, '', {id: 'tool-job', case_id: caseId, status: 'succeeded', result: null}), 'reflection-job', 'completed tool hands off to saved reflection');
  assert.equal(pendingAgentTurnJob(state, 'missing-session', caseId, '', null), null, 'no fallback to another conversation');
  assert.equal(pendingAgentTurnJob(state, 'session-one', caseId, '', {id: 'tool-job', case_id: 'other-case', status: 'succeeded', result: null}), null, 'foreign case job cannot authorize discovery');
  assert.equal(pendingAgentTurnJob(state, 'session-one', caseId, '', {id: 'reflection-job', case_id: caseId, status: 'succeeded', result: null}), null, 'stale queued state does not restart a completed job');
  for (const status of ['succeeded', 'failed', 'cancelled', 'stale']) {
    const terminal: AgentWorkspaceState = {...state, sessions: [{...state.sessions[0]!, turns: [{...state.sessions[0]!.turns[0]!, status}]}]};
    assert.equal(pendingAgentTurnJob(terminal, 'session-one', caseId, '', null), null, status);
  }
  const missingJob: AgentWorkspaceState = {...state, sessions: [{...state.sessions[0]!, turns: [{...state.sessions[0]!.turns[0]!, job_id: null}]}]};
  assert.equal(pendingAgentTurnJob(missingJob, 'session-one', caseId, '', null), null);
});


test('reload restores only an approved selected-session tool action once without issuing an approval', () => {
  const approved = action({status: 'approved', target_job_id: 'tool-job'});
  const state: AgentWorkspaceState = {...emptyState, sessions: [{id: 'session-one', objective: 'Investigate', status: 'active', profile_id: 'profile-one', created_at: '', updated_at: '', turns: [{id: 'done-turn', user_message: 'Investigation mission', status: 'succeeded', response: null, error_code: null, job_id: 'old-agent-job', created_at: '', updated_at: '', actions: [approved], memory: null}]}]};
  assert.equal(pendingAgentTurnJob(state, 'session-one', caseId, '', null), null);
  assert.equal(pendingAgentToolAction(state, 'session-one', '', new Set())?.target_job_id, 'tool-job');
  const reflectionState: AgentWorkspaceState = {...state, sessions: [{...state.sessions[0]!, turns: [...state.sessions[0]!.turns, {...state.sessions[0]!.turns[0]!, id: 'reflection-turn', status: 'queued', job_id: 'reflection-job', actions: []}]}]};
  assert.equal(pendingAgentToolAction(reflectionState, 'session-one', '', new Set()), null, 'saved reflection polling takes precedence during the same effect cycle');
  assert.equal(pendingAgentToolAction(state, 'other-session', '', new Set()), null);
  assert.equal(pendingAgentToolAction(state, 'session-one', 'reflection-job', new Set()), null, 'never interrupt active job polling');
  assert.equal(pendingAgentToolAction(state, 'session-one', '', new Set([approved.id])), null, 'bounded watcher cannot restart its cap after timeout');
  for (const change of [{status: 'suggested'}, {status: 'failed'}, {status: 'cancelled'}, {status: 'completed'}, {target_job_id: null}, {reflection_turn_id: 'reflection-turn'}]) {
    const excluded: AgentWorkspaceState = {...state, sessions: [{...state.sessions[0]!, turns: [{...state.sessions[0]!.turns[0]!, actions: [{...approved, ...change}]}]}]};
    assert.equal(pendingAgentToolAction(excluded, 'session-one', '', new Set()), null);
  }
});


test('report handoff binds the exact succeeded tool job and proposal, including failed reflection', () => {
  const result = {proposal_id: 'proposal-exact', draft_only: true};
  const step = action({kind: 'draft_report', status: 'completed', target_job_id: 'report-job', tool_result: {kind: 'draft_report', status: 'succeeded', job_id: 'report-job', result}});
  assert.equal(completedReportProposal(step), 'proposal-exact');
  assert.equal(completedReportProposal({...step, status: 'failed', last_error_code: 'MODEL_CALL_FAILED'}), 'proposal-exact');
  const destination = reportReviewDestination(workspace.id, caseId, step)!;
  assert.deepEqual(agentTaskDestination(workspace.id, caseId, destination), {kind: 'investigation', destination, section: 'reports', diagnosisProposalId: 'proposal-exact'});
  // Reconstructing the saved URL selects this proposal rather than the latest inventory item.
  const saved = new URLSearchParams({agent_task: destination}).toString();
  assert.deepEqual(agentTaskDestination(workspace.id, caseId, new URLSearchParams(saved).get('agent_task')!), agentTaskDestination(workspace.id, caseId, destination));
  for (const tool of [{kind: 'draft_report', status: 'succeeded', job_id: 'other-job', result}, {kind: 'draft_report', status: 'failed', job_id: 'report-job', result}, {kind: 'generate_hypotheses', status: 'succeeded', job_id: 'report-job', result}, {kind: 'draft_report', status: 'succeeded', job_id: 'report-job', result: {...result, draft_only: false}}, {kind: 'draft_report', status: 'succeeded', job_id: 'report-job', result: {...result, proposal_id: '../another'}}, result, null]) assert.equal(completedReportProposal({...step, tool_result: tool}), null);
  assert.equal(completedReportProposal({...step, status: 'approved'}), null);
  assert.equal(agentTaskDestination(workspace.id, caseId, destination + '&diagnosis_proposal=other'), null);
  assert.equal(agentTaskDestination(workspace.id, caseId, destination.replace('tab=reports', 'tab=tests')), null);
});

test('budget exhaustion disables new model work while preserving deterministic navigation', () => {
  const state: AgentWorkspaceState = {...emptyState, model_profiles: [{id: 'model', name: 'Existing AI', model_name: 'configured', provider: 'compatible', status: 'available'}], model_budget: {remaining_calls: 0, remaining_input: 100, remaining_output: 0, can_request: false, reason_code: 'MODEL_BUDGET_EXCEEDED'}};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /agent limit reached/);
  assert.match(html, /<button class="primary" disabled="">Start investigation/);
  assert.match(html, new RegExp(`/w/${workspace.id}/cases/${caseId}/data`));
});


test('completed report is readable with exhausted budget and viewer access without approval controls', () => {
  const step = action({kind: 'draft_report', status: 'failed', target_job_id: 'report-job', tool_result: {kind: 'draft_report', status: 'succeeded', job_id: 'report-job', result: {proposal_id: 'proposal-readonly', draft_only: true}}});
  const response: AgentResponse = {schema_version: 2, revision_id: revisionId, input_hash: 'a'.repeat(64), stage: 'report', message: 'Review the draft', evidence_ids: [], memory_capsule_ids: [], analysis: {current_belief: '', what_changed: '', hypotheses: [], unknowns: []}, actions: [], questions: [], limitations: []};
  const state: AgentWorkspaceState = {...emptyState, model_budget: {remaining_calls: 0, remaining_input: 0, remaining_output: 0, can_request: false, reason_code: 'MODEL_BUDGET_EXCEEDED'}, sessions: [{id: 'session-one', objective: 'Review report', status: 'active', profile_id: 'model', created_at: '', updated_at: '', turns: [{id: 'turn-report', user_message: '', status: 'succeeded', response, error_code: null, job_id: 'turn-job', created_at: '', updated_at: '', actions: [step], memory: null}]}]};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={{...workspace, role: 'viewer'}} caseId={caseId} state={state} selectedSessionId="session-one" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Read report draft/);
  assert.doesNotMatch(html, />Approve<|>Retry<|>Publish report<|>Continue investigation</);
});

function savedActionState(step: AgentAction): AgentWorkspaceState {
  const response: AgentResponse = {schema_version: 2, revision_id: revisionId, input_hash: 'a'.repeat(64), stage: 'report', message: 'Review the saved output.', evidence_ids: [], memory_capsule_ids: [], analysis: {current_belief: '', what_changed: '', hypotheses: [], unknowns: []}, actions: [], questions: [], limitations: []};
  return {...emptyState, model_profiles: [{id: 'model', name: 'Configured AI', model_name: 'configured', provider: 'compatible', status: 'available'}], sessions: [{id: 'saved-session', objective: 'Review saved work', status: 'active', profile_id: 'model', created_at: '', updated_at: '', turns: [{id: 'original-turn', user_message: '', status: 'succeeded', response, error_code: null, job_id: 'original-job', created_at: '', updated_at: '', actions: [step], memory: null}]}]};
}

test('explicit draft-review receipts show hypothesis and report review without inventing a continuation', () => {
  const proposalId = '55555555-5555-4555-8555-555555555555';
  for (const kind of ['generate_hypotheses', 'draft_report'] as const) {
    const step = action({kind, status: 'completed', target_job_id: 'saved-draft-job', tool_result: {kind, status: 'succeeded', job_id: 'saved-draft-job', result: {proposal_id: proposalId, draft_only: true}, reflection_policy: 'human_review'}});
    assert.equal(modelDraftNeedsReview(step), true, kind);
    assert.equal(agentActionNeedsRefresh(step), false, 'a saved human-review handoff does not wait for an unscheduled reflection');
    const state = {...savedActionState(step), model_budget: {remaining_calls: 0, remaining_input: 0, remaining_output: 0, can_request: false, reason_code: 'MODEL_BUDGET_EXHAUSTED'}};
    for (const role of ['owner', 'viewer'] as const) {
      const html = renderToStaticMarkup(<AgentWorkspaceView workspace={{...workspace, role}} caseId={caseId} state={state} selectedSessionId="saved-session" pending="" activeJob={null} error={null} {...callbacks} />);
      assert.match(html, /Draft ready · Review required/);
      assert.match(html, /Review this draft before adding it to the investigation/);
      assert.match(html, kind === 'draft_report' ? /Read report draft/ : /Read saved possible reasons/);
      assert.match(html, /View saved tool output/);
      assert.doesNotMatch(html, /agent update did not complete|agent update unavailable|agent update failed|Retry agent update|>Approve<|Result reviewed|>PASS<|>Publish report</);
    }
    if (kind === 'draft_report') assert.equal(reportReviewDestination(workspace.id, caseId, step), `/w/${workspace.id}/cases/${caseId}/investigation?tab=reports&diagnosis_proposal=${proposalId}`);
  }
});

test('human-review handoff rejects unsupported, stale, failed, malformed or unbound receipts', () => {
  const result = {proposal_id: '55555555-5555-4555-8555-555555555555', draft_only: true};
  const receipt = {kind: 'draft_report', status: 'succeeded', job_id: 'saved-draft-job', result, reflection_policy: 'human_review'};
  const step = action({kind: 'draft_report', status: 'completed', target_job_id: 'saved-draft-job', tool_result: receipt});
  const changes: Partial<AgentAction>[] = [
    {status: 'failed', last_error_code: 'MODEL_CALL_FAILED'}, {status: 'cancelled'}, {status: 'stale'}, {status: 'approved'},
    {last_error_code: 'MODEL_BUDGET_EXHAUSTED'}, {reflection_turn_id: 'historical-reflection'}, {target_job_id: null},
    {target_job_id: 'another-job'}, {target_job_id: ' ', tool_result: {...receipt, job_id: ' '}},
    {kind: 'gather_related_evidence', tool_result: {...receipt, kind: 'gather_related_evidence'}},
    {tool_result: {...receipt, kind: 'generate_hypotheses'}}, {tool_result: {...receipt, status: 'failed'}},
    {tool_result: {...receipt, reflection_policy: 'automatic'}}, {tool_result: {...receipt, reflection_policy: undefined}},
    {tool_result: {...receipt, result: {proposal_id: result.proposal_id}}}, {tool_result: {...receipt, result: {...result, draft_only: false}}},
    {tool_result: {...receipt, result: {...result, proposal_id: 'proposal-safe-but-not-uuid'}}},
    {tool_result: {...receipt, result: {...result, proposal_id: '../another-case'}}},
    {tool_result: {...receipt, result: null}}, {tool_result: {...receipt, result: []}}, {tool_result: null},
  ];
  for (const change of changes) {
    const invalid = {...step, ...change};
    assert.equal(modelDraftNeedsReview(invalid), false, JSON.stringify(change));
    const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={savedActionState(invalid)} selectedSessionId="saved-session" pending="" activeJob={null} error={null} {...callbacks} />);
    assert.doesNotMatch(html, /Draft ready · Review required|Review this draft before adding it to the investigation|Result reviewed|>PASS</);
    if (savedToolSucceeded(invalid)) assert.match(html, /agent update did not complete/, 'an unsupported handoff cannot hide missing or failed continuation');
    if (invalid.last_error_code) assert.ok(html.includes(invalid.last_error_code), 'real failure remains visible');
  }
});

test('a succeeded saved tool with exhausted continuation shows its real outcome and preserves report navigation', () => {
  const step = action({kind: 'draft_report', status: 'failed', target_job_id: 'saved-job', last_error_code: 'MODEL_BUDGET_EXHAUSTED', tool_result: {kind: 'draft_report', status: 'succeeded', job_id: 'saved-job', result: {proposal_id: 'saved-draft', draft_only: true}}});
  const state = {...savedActionState(step), model_budget: {remaining_calls: 0, remaining_input: 5000, remaining_output: 0, can_request: false, reason_code: 'MODEL_BUDGET_EXHAUSTED'}};
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="saved-session" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Tool succeeded · agent update incomplete/);
  assert.match(html, /The agent limit was reached/); assert.match(html, /View saved tool output/);
  assert.match(html, /<button class="primary" type="button">Read report draft<\/button>/);
  assert.match(html, /<button class="primary" type="button" disabled="">Retry agent update<\/button>/);
  assert.match(html, /tool will not run again/);
  assert.doesNotMatch(html, /Could not finish: MODEL_BUDGET_EXHAUSTED|>failed<|>PASS<|Result reviewed/);
});

test('an actual failed reflection remains failed even when its saved tool and action completed', () => {
  const step = action({kind: 'draft_report', status: 'completed', reflection_turn_id: 'failed-reflection', target_job_id: 'saved-job', tool_result: {kind: 'draft_report', status: 'succeeded', job_id: 'saved-job', result: {proposal_id: 'saved-draft', draft_only: true}}});
  const state = savedActionState(step);
  state.sessions[0]!.turns.push({id: 'failed-reflection', message_kind: 'tool', user_message: 'Approved tool result: {"status":"succeeded"}', status: 'failed', response: null, error_code: 'MODEL_CALL_FAILED', job_id: 'reflection-job', created_at: '', updated_at: '', actions: [], memory: null});
  const html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="saved-session" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Tool succeeded · agent update failed/);
  assert.match(html, /<strong>agent update failed<\/strong>/);
  assert.match(html, /Reason: Agent request failed/);
  assert.match(html, /Saved tool output remains available/);
  assert.match(html, /Read report draft/);
  assert.doesNotMatch(html, /No draft or verified result was created|Result reviewed|>PASS<|Retry agent update/);
});

test('saved tool success requires its exact job and kind; actual tool failure stays retryable', () => {
  const step = action({kind: 'gather_related_evidence', status: 'failed', target_job_id: 'failed-job', last_error_code: 'SOURCE_UNAVAILABLE', tool_result: {kind: 'gather_related_evidence', status: 'failed', job_id: 'failed-job', result: null}});
  assert.equal(savedToolSucceeded(step), false);
  for (const tool_result of [{kind: 'draft_report', status: 'succeeded', job_id: 'failed-job'}, {kind: step.kind, status: 'succeeded', job_id: 'another-job'}, {status: 'succeeded'}, null]) assert.equal(savedToolSucceeded({...step, tool_result}), false);
  const state = savedActionState(step), html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="saved-session" pending="" activeJob={null} error={null} {...callbacks} />);
  assert.match(html, /Could not finish: Data source unavailable/);
  assert.match(html, /<button class="primary" type="button">Retry<\/button>/);
  assert.doesNotMatch(html, /Tool succeeded|Retry agent update|View saved tool output/);
});

test('retrying incomplete AI continuation sends one reviewed approval for the saved job', async () => {
  const step = action({kind: 'gather_related_evidence', status: 'failed', target_job_id: 'saved-tool-job', last_error_code: 'MODEL_BUDGET_EXHAUSTED', tool_result: {kind: 'gather_related_evidence', status: 'succeeded', job_id: 'saved-tool-job', result: {evidence_id: 'saved-evidence'}}});
  const original = globalThis.fetch, requests: {path: string; body: unknown}[] = [];
  globalThis.fetch = async (path, init) => {requests.push({path: String(path), body: JSON.parse(String(init?.body))}); return Response.json({data: {id: step.id, status: 'approved', binding_hash: step.binding_hash, target_job_id: step.target_job_id}});};
  try {
    const reviewed = await reviewAgentAction({base, csrf: 'unit-token', action: step, decision: 'approve', identity: identity()});
    assert.equal(reviewed.target_job_id, 'saved-tool-job');
    assert.deepEqual(requests, [{path: `${base}/agent/actions/${step.id}/approve`, body: {reviewed: true}}]);
    const state = savedActionState(step), html = renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="saved-session" pending="" activeJob={null} error={null} {...callbacks} />);
    assert.match(html, />Retry agent update<\/button>/); assert.match(html, /Review saved evidence/);
    assert.match(html, /Uses the saved tool result; the tool will not run again/);
  } finally {globalThis.fetch = original;}
});

test('agent prose uses plain display words while user context, raw actions and saved response data remain untouched',()=>{
 const step=action({title:'Generate hypotheses',reason:'AI should check stratified rates and cohort mix.'});
 const state=savedActionState(step),turn=state.sessions[0]!.turns[0]!;
 turn.user_message='AI context: hypotheses and strata are raw user words.';
 turn.response!.message='AI observed lower aggregate conversion; stratified rates and cohort mix need checking.';
 turn.response!.limitations=['Aggregate causal effect not established.'];
 const original=JSON.stringify(state);
 const html=renderToStaticMarkup(<AgentWorkspaceView workspace={workspace} caseId={caseId} state={state} selectedSessionId="saved-session" pending="" activeJob={null} error={null} {...callbacks}/>);
 assert.match(html,/agent observed lower overall conversion; rates by group and group mix need checking/);assert.match(html,/Suggest possible reasons/);assert.match(html,/agent should check rates by group and group mix/);assert.match(html,/the overall cause is not proven/);
 assert.match(html,/AI context: hypotheses and strata are raw user words/);assert.equal(JSON.stringify(state),original);assert.doesNotMatch(html,/AI observed lower aggregate|Generate hypotheses/);
});
