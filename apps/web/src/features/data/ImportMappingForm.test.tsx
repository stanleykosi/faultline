import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ImportMappingForm} from './ImportMappingForm';
import type {ImportMapping} from './mapping';

test('reopening an actual saved analytics array mapping renders exclusion review without string-method crash', () => {
  const savedValue: ImportMapping = {kind: 'analytics', event_id_path: ['properties', 'uid'], session_id_path: ['properties', 'basket'], event_time_path: ['timestamp'], event_name_path: ['event'], device_path: ['properties', 'device'], excluded_path: ['properties', 'drop'], device_map: [{source_value: 'Phone', cohort: 'mobile'}], precision_policy: 'lossless_utc_microseconds'};
  const html = renderToStaticMarkup(<ImportMappingForm kind="analytics" savedValue={savedValue} savedId="unit-recorded-mapping" revision={9} pending={false} immutable={false} onDirty={() => {}} onApply={async () => true} onRefreshRevision={async () => {}} />);
  assert.match(html, /name="excluded_path"[^>]*value="\[&quot;properties&quot;,&quot;drop&quot;\]"/);
  assert.match(html, /name="excluded_path_format"[^>]*>[\s\S]*?<option value="array" selected="">Finite JSON path array<\/option>/);
  assert.doesNotMatch(html, /name="exclusion_default"/);
  assert.match(html, /six fractional digits in UTC/);
});

test('saved nested support and release addresses render exact JSON strings, retaining publication uncertainty', () => {
  for (const savedValue of [{kind: 'support', record_id_path: ['ticket', 'id'], text_path: ['ticket', 'message']} as const, {kind: 'release', record_id_path: ['release', 'id'], description_path: ['release', 'notes'], published_at_path: ['release', 'published'], commit_path: ['release', 'commit']} as const]) {
    const html = renderToStaticMarkup(<ImportMappingForm kind={savedValue.kind} savedValue={savedValue} savedId="unit-mapping" revision={9} pending={false} immutable={false} onDirty={() => {}} onApply={async () => true} onRefreshRevision={async () => {}} />);
    assert.match(html, /value="\[&quot;(ticket|release)&quot;,&quot;id&quot;\]"/);
    if (savedValue.kind === 'release') {assert.match(html, /does not establish deployment or exposure/); assert.match(html, /unverified imported metadata/); assert.match(html, /name="commit_path"[^>]*value="\[&quot;release&quot;,&quot;commit&quot;\]"/);}
  }
});
