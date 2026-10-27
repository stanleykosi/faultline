import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseZetarisApprovedViews, zetarisSourceConfigFromForm} from './Sources';

const views = [
  {id: 'sessions_public', role: 'sessions', identifier: 'faultline.sessions_public', columns: {record_id: 'record_id', occurred_at: 'occurred_at', release_id: 'release_id', session_id: 'session_id', cohort: 'cohort', case_key: 'case_key', flow_key: 'flow_key', conversion_status: 'conversion_status'}},
  {id: 'releases_public', role: 'releases', identifier: 'faultline.releases_public', columns: {record_id: 'record_id', release_id: 'release_id', case_key: 'case_key'}},
];

function form(overrides: Record<string, string> = {}) {
  const value = new FormData(), fields = {adapter_id: 'reviewed_contract_v1', approved_origin: 'https://zetaris.example.test', contract_hash: 'a'.repeat(64), approved_account_scope: 'faultline_reader', approved_views: JSON.stringify(views), ...overrides};
  for (const [name, item] of Object.entries(fields)) value.set(name, item);
  return value;
}

test('Zetaris connection emits the exact versioned contract and derived approved view IDs', () => {
  const config = zetarisSourceConfigFromForm(form());
  assert.deepEqual(config, {kind: 'zetaris_federated_evidence', schema_version: 1, protocol: 'faultline-zetaris-v1', adapter_id: 'reviewed_contract_v1', approved_origin: 'https://zetaris.example.test', contract_hash: 'a'.repeat(64), approved_account_scope: 'faultline_reader', approved_views: views, approved_view_ids: ['sessions_public', 'releases_public']});
  assert.equal(Object.hasOwn(config, 'endpoint'), false);
  assert.equal(Object.hasOwn(config, 'workspace_id'), false);
  assert.equal(Object.hasOwn(config, 'source_id'), false);
});

test('approved-view JSON rejects unsupported fields, duplicate roles, unsafe identifiers and excess items', () => {
  assert.throws(() => parseZetarisApprovedViews('{'), /valid JSON/);
  assert.throws(() => parseZetarisApprovedViews(JSON.stringify([{...views[0], sql: 'select *'}])), /unsupported fields/);
  assert.throws(() => parseZetarisApprovedViews(JSON.stringify([views[0], {...views[0], id: 'other_sessions'}])), /unique sessions/);
  assert.throws(() => parseZetarisApprovedViews(JSON.stringify([{...views[0], identifier: 'sessions; DROP VIEW'}])), /finite provider relation identifier/);
  assert.throws(() => parseZetarisApprovedViews(JSON.stringify(Array.from({length: 33}, (_, index) => ({...views[0], id: `view_${index}`, role: index % 2 ? 'support' : 'sessions'})))), /1–32/);
});

test('Zetaris connection rejects non-origin URLs, non-HTTPS origins and changed contract digests before transport', () => {
  assert.throws(() => zetarisSourceConfigFromForm(form({approved_origin: 'http://zetaris.example.test'})), /exact HTTPS origin/);
  assert.throws(() => zetarisSourceConfigFromForm(form({approved_origin: 'https://zetaris.example.test/path'})), /exact HTTPS origin/);
  assert.throws(() => zetarisSourceConfigFromForm(form({contract_hash: 'A'.repeat(64)})), /64 lowercase/);
  assert.throws(() => zetarisSourceConfigFromForm(form({adapter_id: '../adapter'})), /installed adapter ID/);
});
