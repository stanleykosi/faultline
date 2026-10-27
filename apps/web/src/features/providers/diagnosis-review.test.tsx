import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError, resource} from '../../api';
import {commandKey, type CommandIdentity} from '../../command-key';
import type {AnalysisContext, Evidence, ReportRecord} from '../investigation/types';
import {DiagnosisSentences} from './DiagnosisModelDraft';
import {diagnosisDraftIssue, reviewedDiagnosisCommand} from './diagnosis-review';
import type {ModelProposal} from './types';

const digest = 'a'.repeat(64), revisionId = 'unit-frozen-revision';
const context: AnalysisContext = {binding: {workspace_id: 'unit-workspace', case_id: 'unit-case', revision_id: revisionId, metric_hash: digest, snapshot_hash: digest}, metric: {version: 1, template: 'session_conversion_v1', source_id: 'unit-source', unit: 'session', entry_event: 'entry', success_event: 'success', horizon_seconds: 1800, segment_property: 'device', cohorts: ['mobile'], windows: {baseline: {start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z'}, comparison: {start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z'}}, exclusion_rule: 'entry_excluded_false', timezone: 'UTC'}, comparison: null, capabilities: {model: 'unknown', external_runner: 'disabled'}};
const evidence: Evidence[] = [{id: 'unit-evidence', workspace_id: 'unit-workspace', case_id: 'unit-case', revision_id: revisionId, snapshot_id: null, source_kind: 'note', source_ref: 'unit-ui-only', content_hash: digest, captured_at: '2026-10-11T00:00:00.000Z', event_time: {kind: 'unknown', raw_description: 'Unit UI fixture'}, text: 'Independent unit rendering fixture.', redaction_status: 'sanitized', evidence_status: 'active', supersedes_id: null}];
const proposal: ModelProposal = {id: '11111111-1111-4111-8111-111111111111', profile_id: 'unit-profile', profile_hash: digest, input_hash: digest, evidence_hashes: {'unit-evidence': digest}, revision_id: revisionId, freshness: 'fresh', draft_only: true, created_at: '2026-10-11T00:00:00.000Z', value: {schema_version: 1, kind: 'diagnosis_draft', revision_id: revisionId, input_hash: digest, hypotheses: [], draft_sentences: [{qualification: 'observed', text: '<img src=x onerror=alert(1)> Model statement requires review.', evidence_ids: ['unit-evidence']}, {qualification: 'limitation', text: 'Aggregate causal effect is not established.', evidence_ids: []}, {qualification: 'next_step', text: 'Review an independent negative control.', evidence_ids: []}], questions: [], limitations: []}};
const record: ReportRecord = {id: 'unit-report', revision: 7, freshness: 'fresh', value: {id: 'unit-report', revision_id: revisionId, status: 'draft', title: 'Unit report draft', created_at: proposal.created_at, metric_hash: digest, snapshot_hash: digest, claim: {association: 'observed', mechanism: 'not_tested', correction: 'not_tested', freshness: 'fresh', coverage_quality: 'provisional', scope: 'association_only', warning: null, attribution: {scope: 'association_only', causal_effect: 'not_established'}}, findings: [], alternatives: [], limitations: ['No aggregate causal claim.'], recommended_actions: [], input_manifest_hash: digest}};

test('review sends exact sentence indexes and captured draft revision without model verdict fields, retaining identity after a lost reply', async () => {
  const command = reviewedDiagnosisCommand(proposal, record, context, evidence, [0, 1, 2]);
  assert.deepEqual(command, {body: {model_proposal_id: proposal.id, proposal_sentence_indexes: [0, 1, 2]}, revision: 7});
  const original = globalThis.fetch, identity: {current: CommandIdentity} = {current: null}, observed: RequestInit[] = [];
  let loseReply = true;
  globalThis.fetch = async (_path, init) => {observed.push(init!); if (loseReply) {loseReply = false; throw new TypeError('Unit transport reply unavailable.');} return Response.json({data: {...record, revision: 8}, meta: {request_id: 'unit-review'}});};
  const path = '/api/v1/workspaces/unit-workspace/cases/unit-case/diagnoses/unit-report';
  const submit = () => resource(path, {method: 'PATCH', csrf: 'unit-token', ...command, idempotencyKey: commandKey(identity, {path, method: 'PATCH', ...command})});
  try {
    await assert.rejects(submit(), error => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
    assert.equal(observed.length, 1, 'No automatic model request or mutation retry occurs.');
    await submit();
    const first = observed[0]!.headers as Record<string, string>, second = observed[1]!.headers as Record<string, string>;
    assert.equal(first['X-Faultline-Revision'], '7'); assert.equal(first['X-CSRF-Token'], 'unit-token'); assert.equal(first['Idempotency-Key'], second['Idempotency-Key']);
    assert.deepEqual(JSON.parse(observed[0]!.body as string), {model_proposal_id: proposal.id, proposal_sentence_indexes: [0, 1, 2]});
  } finally {globalThis.fetch = original;}
});

test('stale, published, unknown and unbound drafts cannot become reviewed current report text', () => {
  assert.match(diagnosisDraftIssue({...proposal, freshness: 'stale'}, record, context)!, /stale/);
  assert.match(diagnosisDraftIssue(proposal, {...record, value: {...record.value!, status: 'published'}}, context)!, /unpublished/);
  assert.match(diagnosisDraftIssue(proposal, {...record, freshness: undefined}, context)!, /unknown/);
  assert.match(diagnosisDraftIssue(proposal, {...record, revision: undefined}, context)!, /resource revision/);
  assert.match(diagnosisDraftIssue({...proposal, profile_hash: ''}, record, context)!, /profile/);
  assert.match(diagnosisDraftIssue(proposal, record, {...context, binding: {...context.binding, revision_id: 'new-revision'}})!, /another input revision/);
  assert.throws(() => reviewedDiagnosisCommand({...proposal, freshness: 'stale'}, record, context, evidence, [0]), /stale/);
});

test('only finite actual sentences with accessible sanitized finding citations can be selected', () => {
  for (const indexes of [[], [0, 0], [-1], [3], [0.5]]) assert.throws(() => reviewedDiagnosisCommand(proposal, record, context, evidence, indexes), /existing draft sentence/);
  assert.throws(() => reviewedDiagnosisCommand(proposal, record, context, [{...evidence[0]!, redaction_status: 'withdrawn'}], [0]), /withdrawn/);
  assert.throws(() => reviewedDiagnosisCommand({...proposal, value: {...proposal.value, draft_sentences: [{...proposal.value.draft_sentences[0]!, evidence_ids: []}]}}, record, context, evidence, [0]), /citation/);
  assert.deepEqual(reviewedDiagnosisCommand(proposal, record, context, [], [1, 2]).body.proposal_sentence_indexes, [1, 2]);
});

test('model observation labels remain qualified text and untrusted markup is escaped, with unavailable citations unselectable', () => {
  const html = renderToStaticMarkup(<DiagnosisSentences proposal={proposal} evidence={[]} selectable />);
  assert.match(html, /Model qualification: observed/); assert.match(html, /Human-reviewed model finding/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img/);
  const firstInput = html.match(/<input[^>]*name="diagnosis_sentence"[^>]*value="0"[^>]*>/)?.[0];
  assert.ok(firstInput); assert.match(firstInput, /disabled=""/);
  assert.match(html, /withdrawn or unavailable/); assert.match(html, /Report limitation/); assert.match(html, /Recommended action/);
  assert.doesNotMatch(html, />passed</);
});
