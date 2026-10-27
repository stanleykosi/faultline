import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {BudgetView, RetentionImpactView, readPolicyPatch, reviewedPolicyBody, type RetentionPreview} from './Policies';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const values = {max_automatic_model_calls: 4, max_input_tokens: 40000, max_output_tokens: 8000, max_records_per_snapshot: 100000, raw_upload_retention_days: 30, canonical_event_retention_days: 90, attachment_retention_days: 90, report_retention_days: 365, audit_retention_days: 365};
const record = {value: values, revision: 3, installation_ceilings: values};
function form(changed: Partial<Record<string, string>> = {}) {const result = new FormData(); for (const [key, value] of Object.entries(values)) result.set(key, changed[key] ?? String(value)); return result;}
function preview(): RetentionPreview {return {policy_revision: 3, previous_policy_hash: 'a'.repeat(64), policy_hash: 'b'.repeat(64), patch: {canonical_event_retention_days: 1}, as_of: '2026-10-11T12:00:00.000Z', effective_at: '2026-10-18T12:00:00.000Z', grace_days: 7, impact_hash: 'c'.repeat(64), review_token: 'private-review-unit-fixture', review_expires_at: '2026-10-11T12:05:00.000Z', backup_notice: 'Private bytes remain pending separate review.', impact: {resources: [{resource_kind: 'snapshot', resource_id: 'reviewed-snapshot', case_id: 'case-id', content_hash: 'd'.repeat(64), captured_at: '2026-10-01T12:00:00.000Z', age_days: 10, revision_id: 'frozen-input-id', resource_revision: null, object_keys: ['private-object-hash'], previous_expires_at: '2026-12-30T12:00:00.000Z', expires_at: '2026-10-18T12:00:00.000Z', shortened: true, shared_reference_count: 2, binding: {source_id: 'reviewed-source'}, caused_by: [], cited_reports: [{resource_kind: 'report', resource_id: 'cited-report-id', content_hash: 'e'.repeat(64), revision_id: 'frozen-input-id'}], report_downloads: [{resource_kind: 'report_export', resource_id: 'dependent-download-id', content_hash: 'f'.repeat(64), revision_id: 'frozen-input-id'}]}], counts: {total: 1, snapshot: 1, shared_objects: 1}, affected_citations: 0, physical_cleanup: 'pending_separate_review'}};}

test('finite policy input emits only changed named fields and enforces actual installation ceilings', () => {
  assert.deepEqual(readPolicyPatch(form({canonical_event_retention_days: '1', max_automatic_model_calls: '0'}), record), {max_automatic_model_calls: 0, canonical_event_retention_days: 1});
  for (const changed of [{canonical_event_retention_days: '0'}, {max_records_per_snapshot: '100001'}, {max_input_tokens: '1.5'}, {max_automatic_model_calls: ''}]) assert.throws(() => readPolicyPatch(form(changed), record));
  assert.throws(() => readPolicyPatch(form(), record), /actual policy change/);
  assert.throws(() => readPolicyPatch(form({max_automatic_model_calls: '1'}), {...record, installation_ceilings: {max_automatic_model_calls: 0}}), /integer from 0 to 0/);
});

test('generous agent allowance accepts its declared ceilings while lower workspace limits, zero and tighter server caps remain authoritative',()=>{
 const ceilings={...values,max_automatic_model_calls:24,max_input_tokens:500000,max_output_tokens:64000},current={...record,installation_ceilings:ceilings};
 assert.deepEqual(readPolicyPatch(form({max_automatic_model_calls:'24',max_input_tokens:'500000',max_output_tokens:'64000'}),current),{max_automatic_model_calls:24,max_input_tokens:500000,max_output_tokens:64000});
 assert.deepEqual(readPolicyPatch(form({max_automatic_model_calls:'0',max_input_tokens:'0',max_output_tokens:'0'}),current),{max_automatic_model_calls:0,max_input_tokens:0,max_output_tokens:0});
 assert.deepEqual(readPolicyPatch(form({max_automatic_model_calls:'2',max_input_tokens:'10000',max_output_tokens:'2000'}),current),{max_automatic_model_calls:2,max_input_tokens:10000,max_output_tokens:2000});
 for(const patch of [{max_automatic_model_calls:'25'},{max_input_tokens:'500001'},{max_output_tokens:'64001'}])assert.throws(()=>readPolicyPatch(form(patch),current),/must be an integer/);
 assert.throws(()=>readPolicyPatch(form({max_automatic_model_calls:'5'}),record),/integer from 0 to 4/);
 assert.throws(()=>readPolicyPatch(form({max_automatic_model_calls:'24'}),{...record,installation_ceilings:undefined}),/no recorded installation ceiling/);
});

test('retention PATCH requires explicit exact-impact review and preserves the private server token with mixed finite changes', () => {
  const patch = {canonical_event_retention_days: 1, max_automatic_model_calls: 0}, value = preview();
  assert.throws(() => reviewedPolicyBody(patch, value, 3, false, now), /Review the exact affected/);
  assert.deepEqual(reviewedPolicyBody(patch, value, 3, true, now), {...patch, retention_review_token: value.review_token});
  assert.throws(() => reviewedPolicyBody({...patch, canonical_event_retention_days: 2}, value, 3, true, now), /exact changed fields/);
  assert.throws(() => reviewedPolicyBody(patch, value, 4, true, now), /policy revision/);
  assert.throws(() => reviewedPolicyBody(patch, value, 3, true, now + 5 * 60_000), /expired/);
});

test('shortened grace, incomplete inventory and unknown capture ages never authorize retention', () => {
  const patch = {canonical_event_retention_days: 1};
  for (const change of [(p: RetentionPreview) => {p.effective_at = '2026-10-17T12:00:00.000Z';}, (p: RetentionPreview) => {p.grace_days = 0;}, (p: RetentionPreview) => {p.impact.counts.total = 2;}, (p: RetentionPreview) => {p.impact.resources[0].age_days = Number.NaN;}]) {const p = preview(); change(p); assert.throws(() => reviewedPolicyBody(patch, p, 3, true, now));}
});

test('review renders exact resource/hash/capture and shared report dependencies while keeping cleanup pending', () => {
  const html = renderToStaticMarkup(<RetentionImpactView impact={preview().impact} />);
  for (const text of ['reviewed-snapshot', 'd'.repeat(64), '2026-10-01T12:00:00.000Z', '10.000000 days', '2 shared references', 'cited-report-id', 'dependent-download-id', 'pending separate review']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Cleanup complete|>passed</);
});

test('missing versus empty model usage remains unknown versus unrecorded; real call/token counts remain separate from work units', () => {
  const common = {work_units: [], model_calls: 'Separate call accounting.', installation_expensive_jobs: 2, workspace_expensive_jobs: 1};
  assert.match(renderToStaticMarkup(<BudgetView budgets={common} />), /consumption remain unknown/);
  assert.match(renderToStaticMarkup(<BudgetView budgets={{...common, model_usage: []}} />), /No model usage rows have been recorded/);
  const html = renderToStaticMarkup(<BudgetView budgets={{...common, model_usage: [{case_id: 'case', revision_id: 'revision', calls_reserved: 1, calls_spent: 2, input_reserved: 30, input_spent: 40, output_reserved: 5, output_spent: 6}]}} />);
  for (const label of ['Calls reserved', 'Calls spent', 'Input tokens reserved', 'Input tokens spent', 'Output tokens reserved', 'Output tokens spent']) assert.ok(html.includes(label));
});
