import assert from 'node:assert/strict';
import {test} from 'node:test';
import {coverageFromForm, postHogMappingFromForm} from './CaptureForms';
import {eventNames} from './ExportDeclarations';
import {sourceReady, type Source} from './types';

test('PostHog capture mapping keeps pinned event/session identities and rejects executable or ambiguous property scopes', () => {
  const form = new FormData(); form.set('device_property', '$device_type'); form.append('device_source', 'Mobile'); form.append('device_cohort', 'mobile'); form.set('exclusion_default', 'reviewed');
  assert.deepEqual(postHogMappingFromForm(form), {kind: 'analytics', event_id_path: 'uuid', session_id_path: 'properties.$session_id', event_time_path: 'timestamp', event_name_path: 'event', device_path: 'properties.$device_type', device_map: [{source_value: 'Mobile', cohort: 'mobile'}], precision_policy: 'lossless_utc_microseconds'});
  form.delete('exclusion_default'); assert.throws(() => postHogMappingFromForm(form), /excluded=false/); form.set('exclusion_default', 'reviewed');
  for (const value of ['__proto__', 'nested.device']) {form.set('device_property', value); assert.throws(() => postHogMappingFromForm(form), /safe exact/);}
  form.set('device_property', '$device_type'); form.append('device_source', 'Mobile'); form.append('device_cohort', 'desktop'); assert.throws(() => postHogMappingFromForm(form), /unique/);
});
test('coverage remains unknown without attributed bounds; assumptions retain provisional input rather than prove completeness', () => {
  const form = new FormData(); form.set('basis', 'none'); form.set('statement', 'No upstream completeness evidence is available.');
  assert.deepEqual(coverageFromForm(form), {basis: 'none', event_time_intervals: [], declared_event_watermark: null, statement: 'No upstream completeness evidence is available.', reference_evidence_ids: [], late_arrival_hours: 0});
  form.set('basis', 'lateness_assumption'); form.set('coverage_start', '2026-10-01T00:00'); form.set('coverage_end', '2026-10-02T00:30'); form.set('watermark', '2026-10-02T00:30'); form.set('late_arrival_hours', '2');
  assert.equal(coverageFromForm(form).basis, 'lateness_assumption'); assert.equal(coverageFromForm(form).late_arrival_hours, 2); form.set('coverage_end', '2026-09-30T00:30'); assert.throws(() => coverageFromForm(form), /increasing/);
});
test('owner export filters preserve exact event names and capability readiness does not follow from a saved credential', () => {
  assert.deepEqual(eventNames(' checkout_started \ncheckout_completed'), [' checkout_started ', 'checkout_completed']); assert.throws(() => eventNames('entry\nentry'), /unique/);
  const source = {kind: 'posthog_existing_file_export', config: {kind: 'posthog_existing_file_export', app_host: 'https://us.posthog.com', project_id: '1'}, disconnected: false, credential: {revoked: false}, status: 'unconfigured', capabilities: null} as Source; assert.equal(sourceReady(source), false);
  const current = {...source, status: 'available', capabilities: {status: 'available'}} as Source; assert.equal(sourceReady(current), true); assert.equal(sourceReady({...current, disconnected: true}), false); assert.equal(sourceReady({...current, credential: null}), false); assert.equal(sourceReady({...current, credential: {...current.credential!, revoked: true}}), false);
});
