import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError, resource} from '../../api';
import {commandKey, type CommandIdentity} from '../../command-key';
import {addressDraft, changeAddressFormat, changeAddressText, confirmAddressFormat, mappingFromForm, parseAddress, sameMapping} from './mapping';

function analyticsForm(): FormData {const form = new FormData(); for (const [name, value] of Object.entries({event_id_path: 'Record UID', session_id_path: 'Visit UID', event_time_path: 'Event instant', event_name_path: 'Action name', device_path: 'Device class', exclusion_default: 'reviewed'})) form.set(name, value); form.append('device_source', 'Phone'); form.append('device_cohort', 'mobile'); form.append('device_source', 'Computer'); form.append('device_cohort', 'desktop'); return form;}

test('reviewed ordinary CSV headers produce only the finite analytics wire contract', () => {
  const value = mappingFromForm('analytics', 'fields', analyticsForm());
  assert.deepEqual(value, {kind: 'analytics', event_id_path: 'Record UID', session_id_path: 'Visit UID', event_time_path: 'Event instant', event_name_path: 'Action name', device_path: 'Device class', device_map: [{source_value: 'Phone', cohort: 'mobile'}, {source_value: 'Computer', cohort: 'desktop'}], precision_policy: 'lossless_utc_microseconds'});
  assert.ok(sameMapping({...value}, value));
  const unsafe = analyticsForm(); unsafe.set('event_id_path', '__proto__'); assert.throws(() => mappingFromForm('analytics', 'fields', unsafe), /safe exact names/);
  const ambiguous = analyticsForm(); ambiguous.delete('device_source'); ambiguous.append('device_source', 'Phone'); ambiguous.append('device_source', 'Phone'); assert.throws(() => mappingFromForm('analytics', 'fields', ambiguous), /only one group/);
  const unreviewed = analyticsForm(); unreviewed.delete('exclusion_default'); assert.throws(() => mappingFromForm('analytics', 'fields', unreviewed), /excluded=false default/);
});

test('support and release mappings retain unknown time and canonical mode uses its actual discriminator', () => {
  const support = new FormData(); support.set('record_id_path', 'Ticket'); support.set('text_path', 'Customer text');
  assert.deepEqual(mappingFromForm('support', 'fields', support), {kind: 'support', record_id_path: 'Ticket', text_path: 'Customer text'});
  const release = new FormData(); release.set('record_id_path', 'Release UID'); release.set('description_path', 'Notes'); release.set('published_at_path', 'Published');
  assert.deepEqual(mappingFromForm('release', 'fields', release), {kind: 'release', record_id_path: 'Release UID', description_path: 'Notes', published_at_path: 'Published'});
  for (const record_type of ['analytics', 'support', 'release'] as const) assert.deepEqual(mappingFromForm(record_type, 'canonical', new FormData()), {kind: 'canonical', record_type, schema_version: 1});
});

test('explicit finite nested addresses preserve literal names and exact path components', () => {
  assert.equal(parseAddress('properties.basket', 'literal'), 'properties.basket');
  assert.equal(parseAddress('[field.name]', 'literal'), '[field.name]');
  assert.equal(parseAddress('["properties","basket"]', 'literal'), '["properties","basket"]');
  const form = analyticsForm();
  for (const [field, parts] of Object.entries({event_id_path: ['properties', 'uid'], session_id_path: ['properties', 'basket'], event_time_path: ['timestamp'], event_name_path: ['event'], device_path: ['properties', 'device'], excluded_path: ['properties', 'drop'], release_id_path: ['properties', 'release']})) {form.set(field, JSON.stringify(parts)); form.set(`${field}_format`, 'array');}
  const mapping = mappingFromForm('analytics', 'fields', form);
  assert.deepEqual(mapping, {kind: 'analytics', event_id_path: ['properties', 'uid'], session_id_path: ['properties', 'basket'], event_time_path: ['timestamp'], event_name_path: ['event'], device_path: ['properties', 'device'], excluded_path: ['properties', 'drop'], release_id_path: ['properties', 'release'], device_map: [{source_value: 'Phone', cohort: 'mobile'}, {source_value: 'Computer', cohort: 'desktop'}], precision_policy: 'lossless_utc_microseconds'});
});

test('finite arrays reject unsafe, empty, non-string, expression and excessive addresses before any write', () => {
  for (const value of ['[]', '[""]', '[" "]', '["properties","__proto__"]', '["constructor"]', '["prototype"]', '["a",0]', '{"a":"b"}', 'properties.basket', '$.properties.basket', '["a",["b"]]', JSON.stringify(Array(9).fill('a')), JSON.stringify(['x'.repeat(129)])]) assert.throws(() => parseAddress(value, 'array'), /JSON array|finite JSON path/);
  assert.deepEqual(parseAddress(JSON.stringify(Array(8).fill('a'.repeat(128))), 'array'), Array(8).fill('a'.repeat(128)));
  const escaped = Array(8).fill('\u0000'.repeat(128)), escapedText = JSON.stringify(escaped);
  assert.ok(escapedText.length > 1200); assert.deepEqual(parseAddress(escapedText, 'array'), escaped);
  const form = analyticsForm(); form.set('excluded_path', '["properties","prototype"]'); form.set('excluded_path_format', 'array');
  assert.throws(() => mappingFromForm('analytics', 'fields', form), /excluded_path:.*safe string components/);
});

test('nested support and release wire mappings keep optional unknown times and publication limits', () => {
  const support = new FormData(); support.set('record_id_path', '["ticket","id"]'); support.set('record_id_path_format', 'array'); support.set('text_path', '["ticket","message"]'); support.set('text_path_format', 'array');
  assert.deepEqual(mappingFromForm('support', 'fields', support), {kind: 'support', record_id_path: ['ticket', 'id'], text_path: ['ticket', 'message']});
  const release = new FormData(); release.set('record_id_path', '["release","id"]'); release.set('record_id_path_format', 'array'); release.set('description_path', '["release","notes"]'); release.set('description_path_format', 'array'); release.set('published_at_path', '["release","published"]'); release.set('published_at_path_format', 'array'); release.set('commit_path', '["release","reported_ref"]'); release.set('commit_path_format', 'array');
  assert.deepEqual(mappingFromForm('release', 'fields', release), {kind: 'release', record_id_path: ['release', 'id'], description_path: ['release', 'notes'], published_at_path: ['release', 'published'], commit_path: ['release', 'reported_ref']});
  release.set('commit_path', '["release","constructor"]'); assert.throws(() => mappingFromForm('release', 'fields', release), /commit_path:.*safe string components/);
});

test('saved arrays round trip exactly and switching format retains unsaved text with unresolved review', () => {
  const saved = ['properties', 'drop'] as const, initial = addressDraft(saved);
  assert.deepEqual(parseAddress(initial.text, initial.format), saved);
  const switched = changeAddressFormat(initial, 'literal');
  assert.equal(switched.text, initial.text); assert.equal(switched.needsReview, true);
  const form = analyticsForm(); form.set('excluded_path', switched.text); form.set('excluded_path_format', switched.format); form.set('excluded_path_format_reviewed', 'pending');
  assert.throws(() => mappingFromForm('analytics', 'fields', form), /Address format changed/);
  const deliberateLiteral = confirmAddressFormat(switched); assert.equal(deliberateLiteral.needsReview, false); assert.equal(parseAddress(deliberateLiteral.text, deliberateLiteral.format), '["properties","drop"]');
  const unsaved = changeAddressText(addressDraft('Initial header'), 'My.unsaved[header]'), array = changeAddressFormat(unsaved, 'array');
  assert.equal(array.text, 'My.unsaved[header]'); assert.throws(() => confirmAddressFormat(array), /JSON array/);
  assert.equal(changeAddressFormat(array, 'literal').text, unsaved.text);
  const edited = changeAddressText(array, '["payload","My.unsaved[header]"]'); assert.equal(edited.needsReview, false); assert.deepEqual(parseAddress(edited.text, edited.format), ['payload', 'My.unsaved[header]']);
});

test('finite mapping transport retains the reviewed revision and command identity across a manually retried lost response', async () => {
  const original = globalThis.fetch, reference: {current: CommandIdentity} = {current: null}, observed: RequestInit[] = [], path = '/api/v1/workspaces/unit/cases/unit/imports/unit/mappings';
  globalThis.fetch = async (_input, options) => {observed.push(options!); if (observed.length === 1) throw new TypeError('Unit fixture lost mapping reply after commit.'); return Response.json({data: {id: 'recorded-map'}, meta: {request_id: 'unit-wire'}});};
  const submit = () => {const body = mappingFromForm('analytics', 'fields', analyticsForm()); return resource(path, {method: 'POST', csrf: 'unit-session', revision: 7, body, idempotencyKey: commandKey(reference, {path, method: 'POST', revision: 7, body})});};
  try {await assert.rejects(submit(), (cause: unknown) => cause instanceof ApiError && cause.status === 0); assert.equal(observed.length, 1); await submit(); const first = observed[0].headers as Record<string, string>, second = observed[1].headers as Record<string, string>; assert.equal(first['X-Faultline-Revision'], '7'); assert.equal(first['X-CSRF-Token'], 'unit-session'); assert.equal(first['Idempotency-Key'], second['Idempotency-Key']); assert.equal(JSON.parse(String(observed[1].body)).precision_policy, 'lossless_utc_microseconds');} finally {globalThis.fetch = original;}
});
