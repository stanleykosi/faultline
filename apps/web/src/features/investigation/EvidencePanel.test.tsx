import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {EvidenceInspection} from './EvidencePanel';
import type {Evidence} from './types';

const evidence: Evidence = {id: 'unit-evidence', workspace_id: 'unit-workspace', case_id: 'unit-case', revision_id: 'unit-input-revision', snapshot_id: 'unit-snapshot', source_kind: 'support', source_ref: '<a href="https://untrusted.invalid">Imported reference</a>', content_hash: 'a'.repeat(64), captured_at: '2026-10-11T20:00:00.123456Z', event_time: {kind: 'unknown', raw_description: 'Occurrence was not supplied'}, text: '<script>globalThis.untrusted = true</script>', redaction_status: 'sanitized', evidence_status: 'reported', supersedes_id: null, resource_revision: 4};

test('read-only evidence inspection escapes imported text and preserves occurrence, capture, identity and unknown freshness', () => {
  const html = renderToStaticMarkup(<EvidenceInspection item={evidence} />);
  assert.doesNotMatch(html, /<script>|<a href=/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;a href=/);
  assert.match(html, /Unknown — Occurrence was not supplied/);
  assert.match(html, /2026-10-11T20:00:00\.123456Z/);
  for (const value of ['unit-evidence', 'unit-input-revision', 'unit-snapshot', 'a'.repeat(64)]) assert.ok(html.includes(value));
  assert.match(html, /Unknown — freshness was not supplied/);
  assert.match(html, /Neither proves the cause/);
});

test('withdrawn or unavailable evidence cannot show withdrawn content or infer passing freshness', () => {
  const html = renderToStaticMarkup(<EvidenceInspection item={{...evidence, text: 'SECRET_WITHDRAWN_UNIT_TEXT', redaction_status: 'withdrawn', freshness: 'stale'}} />);
  assert.ok(!html.includes('SECRET_WITHDRAWN_UNIT_TEXT')); assert.match(html, /text is unavailable/); assert.match(html, /Recorded freshness<\/dt><dd>stale/);
  const missing = renderToStaticMarkup(<EvidenceInspection item={undefined} />);
  assert.match(missing, /role="alert"/); assert.match(missing, /unavailable in the current authorized record list/);
});
