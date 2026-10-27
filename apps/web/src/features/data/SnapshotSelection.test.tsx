import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError, casePath, type Investigation, type Role} from '../../api';
import {SnapshotSelection, SnapshotSelectionSummary, createSnapshotSelectionCommand, isSnapshotSelection, readSnapshotQuality, type SelectableSnapshot, type SnapshotSelectionReceipt} from './SnapshotSelection';
import type {Coverage} from './types';

const item: Investigation = {id: 'case-unit', workspace_id: 'workspace-unit', title: 'Independently authored review', question: 'Which immutable inputs?', affected_flow: 'checkout', active_revision_id: 'revision-before', lifecycle: 'open', archived: false, revision: 3, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z'};
const a: SelectableSnapshot = {id: 'snapshot-a', source_id: 'source-a', record_kind: 'analytics', content_hash: 'a'.repeat(64), record_count: 4};
const b: SelectableSnapshot = {id: 'snapshot-b', source_id: 'source-b', record_kind: 'support', content_hash: 'b'.repeat(64), record_count: 1};
const receipt: SnapshotSelectionReceipt = {revision_id: 'server-revision-after', parent_id: item.active_revision_id, revision: 4, selected_snapshots: [{id: a.id, source_id: a.source_id, content_hash: a.content_hash!}, {id: b.id, source_id: b.source_id, content_hash: b.content_hash!}], snapshot_bundle_hash: 'c'.repeat(64), selection_reason: 'Review both independent source captures.', metric_status: 'requires_freeze'};
const intent = () => ({base: casePath(item.workspace_id, item.id), csrf: 'unit-csrf', role: 'analyst' as Role, canMutate: true, metadataAvailable: true, investigation: item, snapshots: [a, b], snapshotIds: [b.id, a.id], reason: receipt.selection_reason, reviewed: true});
const response = (value: unknown) => new Response(JSON.stringify({data: value}), {status: 200, headers: {'Content-Type': 'application/json'}});

test('viewer and unknown-role metadata have no selection form; analyst review requires a reason and explicit acknowledgement', () => {
  const props = {base: intent().base, csrf: 'unit-csrf', investigation: {...item, snapshot_selection: receipt}, snapshots: [a, {...b, withdrawn: true}], canMutate: true, metadataAvailable: true, onSaved: () => {throw new Error('Static rendering must not submit.');}};
  for (const role of ['viewer', undefined] as const) {
    const html = renderToStaticMarkup(<SnapshotSelection {...props} role={role} />);
    assert.doesNotMatch(html, /<form|type="checkbox"|Save selected data|Reason for this selection/);
    assert.match(html, /Snapshot snapshot-a/); assert.match(html, /Withdrawn, expired/); assert.match(html, /Check coverage/);
  }
  const html = renderToStaticMarkup(<SnapshotSelection {...props} investigation={{...item, snapshot_selection: null}} role="analyst" />);
  assert.match(html, /No data selected yet/); assert.match(html, /Reason for this selection/);
  assert.match(html, /<textarea[^>]*required=""[^>]*maxLength="2000"/); assert.match(html, /I reviewed this data/);
  assert.match(html, /disabled=""[^>]*>Save selected data/); assert.match(html, /<details open=""><summary>Select data<\/summary>/);
  assert.doesNotMatch(html, /status good|PASS/);
});

test('finite reviewed identities, current role/revision and retained hashes are required before any mutation', async () => {
  const original = globalThis.fetch; let calls = 0; globalThis.fetch = async () => {calls++; return response(receipt);};
  try {
    const invalid = [
      {...intent(), role: 'viewer' as Role}, {...intent(), role: undefined}, {...intent(), canMutate: false}, {...intent(), metadataAvailable: false},
      {...intent(), investigation: {...item, lifecycle: 'closed'}}, {...intent(), investigation: {...item, revision: NaN}},
      {...intent(), base: casePath(item.workspace_id, 'other-case')}, {...intent(), reviewed: false}, {...intent(), reason: '   '}, {...intent(), reason: 'x'.repeat(2001)},
      {...intent(), snapshotIds: [a.id, a.id]}, {...intent(), snapshotIds: Array.from({length: 101}, (_, n) => `snapshot-${n}`)},
      {...intent(), snapshots: [a, {...b, withdrawn: true}]}, {...intent(), snapshots: [a, {...b, retention_expired: true}]},
      {...intent(), snapshots: [a, {...b, content_hash: undefined}]}, {...intent(), snapshots: [a, a, b]}, {...intent(), snapshotIds: ['not-in-current-metadata']}
    ];
    for (const input of invalid) await assert.rejects(createSnapshotSelectionCommand().submit(input));
    assert.equal(calls, 0);
    globalThis.fetch = async (_path, options) => {calls++; assert.deepEqual(JSON.parse(String(options?.body)), {snapshot_ids: [], reason: 'Explicitly clear this saved bundle.'}); return response({...receipt, selected_snapshots: [], selection_reason: 'Explicitly clear this saved bundle.'});};
    const cleared = await createSnapshotSelectionCommand().submit({...intent(), snapshotIds: [], reason: 'Explicitly clear this saved bundle.'});
    assert.equal(cleared.metric_status, 'requires_freeze'); assert.deepEqual(cleared.selected_snapshots, []); assert.equal(calls, 1);
  } finally {globalThis.fetch = original;}
});

test('the actual UI transport sends only reviewed sorted IDs/reason and X-Faultline-Revision; uncertain network/stale errors retain the same command identity', async () => {
  const original = globalThis.fetch, seen: {path: string; headers: Headers; body: string; method: string | undefined}[] = [], command = createSnapshotSelectionCommand();
  globalThis.fetch = async (input, options) => {
    seen.push({path: String(input), headers: new Headers(options?.headers), body: String(options?.body), method: options?.method});
    if (seen.length === 1) throw new TypeError('Explicit component transport fixture: response lost.');
    if (seen.length === 2) return new Response(JSON.stringify({error: {code: 'STALE_INPUTS', message: 'Current revision changed.'}}), {status: 409});
    return response(receipt);
  };
  try {
    await assert.rejects(command.submit(intent()), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
    await assert.rejects(command.submit(intent()), (error: unknown) => error instanceof ApiError && error.code === 'STALE_INPUTS');
    assert.deepEqual(await command.submit(intent()), receipt);
    const key = seen[0].headers.get('Idempotency-Key'); assert.ok(key);
    for (const call of seen) {
      assert.equal(call.path, `${intent().base}/snapshot-selections`); assert.equal(call.method, 'POST');
      assert.equal(call.headers.get('Idempotency-Key'), key); assert.equal(call.headers.get('X-Faultline-Revision'), '3'); assert.equal(call.headers.get('X-CSRF-Token'), 'unit-csrf');
      assert.deepEqual(JSON.parse(call.body), {snapshot_ids: [a.id, b.id], reason: receipt.selection_reason});
    }
    await command.submit(intent()); assert.notEqual(seen[3].headers.get('Idempotency-Key'), key, 'validated success releases the command identity');
  } finally {globalThis.fetch = original;}
});

test('the synchronous pending fence blocks double click; changed intent gets a new key and mismatched server bindings never become a saved receipt', async () => {
  const original = globalThis.fetch, seen: Headers[] = []; let release: ((value: Response) => void) | undefined;
  globalThis.fetch = async (_input, options) => {seen.push(new Headers(options?.headers)); return new Promise<Response>(resolve => {release = resolve;});};
  const command = createSnapshotSelectionCommand();
  try {
    const pending = command.submit(intent()); assert.equal(command.pending, true);
    await assert.rejects(command.submit(intent()), /already being saved/); assert.equal(seen.length, 1);
    assert.ok(release); release(response({...receipt, selected_snapshots: [{...receipt.selected_snapshots[0], content_hash: 'd'.repeat(64)}, receipt.selected_snapshots[1]]}));
    await assert.rejects(pending, /did not return the reviewed snapshot selection/); assert.equal(command.pending, false);
    const originalKey = seen[0].get('Idempotency-Key');
    globalThis.fetch = async (_input, options) => {seen.push(new Headers(options?.headers)); return response({...receipt, parent_id: 'wrong-parent'});};
    await assert.rejects(command.submit({...intent(), reason: 'A newly reviewed reason.'}), /did not return the reviewed/);
    assert.notEqual(seen[1].get('Idempotency-Key'), originalKey);
    for (const changed of [{...receipt, revision: 99}, {...receipt, metric_status: 'fresh'}, {...receipt, revision_id: receipt.parent_id}, {...receipt, selected_snapshots: [...receipt.selected_snapshots].reverse()}]) {
      globalThis.fetch = async () => response(changed); await assert.rejects(command.submit(intent()), /did not return the reviewed/);
    }
  } finally {globalThis.fetch = original;}
});

test('persisted server IDs/hash remain visible on reload; exact coverage is a bounded scoped read and unknown is never promoted to PASS', async () => {
  assert.equal(isSnapshotSelection(receipt, receipt.revision_id), true); assert.equal(isSnapshotSelection(receipt, item.active_revision_id), false);
  const summary = renderToStaticMarkup(<SnapshotSelectionSummary value={receipt} receipt />);
  for (const expected of [receipt.revision_id, receipt.snapshot_bundle_hash, a.id, a.content_hash!, b.id, b.content_hash!]) assert.ok(summary.includes(expected));
  assert.match(summary, /Lock the metric again before running a new comparison/); assert.match(summary, /does not create a result/); assert.doesNotMatch(summary, /PASS|status good/);
  const reloaded = renderToStaticMarkup(<SnapshotSelection base={intent().base} csrf="" role="viewer" investigation={{...item, active_revision_id: receipt.revision_id, snapshot_selection: receipt}} snapshots={[a, b]} canMutate={false} metadataAvailable onSaved={() => {}} />);
  assert.match(reloaded, /Saved data selection/); assert.ok(reloaded.includes(receipt.snapshot_bundle_hash)); assert.doesNotMatch(reloaded, /<form/);
  const unknown: Coverage = {extraction_status: 'unknown', basis: 'none', covered_start: null, covered_end: null, event_watermark: null, attestation: '', event_time_intervals: [], assumptions: ['No event-time completeness is established.']};
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (path, options) => {calls++; assert.equal(String(path), `${intent().base}/snapshots/snapshot-a/quality`); assert.equal(options?.method, 'GET'); assert.equal(new Headers(options?.headers).get('Idempotency-Key'), null); return response(unknown);};
  try {
    assert.deepEqual(await readSnapshotQuality(intent().base, a), unknown);
    await assert.rejects(readSnapshotQuality(intent().base, {...a, withdrawn: true})); await assert.rejects(readSnapshotQuality('https://external.invalid/cases/unit', a)); assert.equal(calls, 1);
    globalThis.fetch = async () => response({extraction_status: 'PASS'}); await assert.rejects(readSnapshotQuality(intent().base, a), /quality remains unknown/);
  } finally {globalThis.fetch = original;}
});

test('a confirmed new empty investigation has one upload instruction, while existing selection and unavailable reads retain their separate review paths',()=>{
 const props={base:intent().base,csrf:'',role:'analyst' as const,canMutate:true,onSaved:()=>{throw new Error('Render cannot save.');}};
 const empty=renderToStaticMarkup(<SnapshotSelection {...props} investigation={{...item,snapshot_selection:null}} snapshots={[]} metadataAvailable/>);
 assert.equal((empty.match(/Upload a file first\./g)??[]).length,1);assert.doesNotMatch(empty,/<form|>Ready<|removes the selected data|Reason for this selection|metric.*locked again/);
 const existing=renderToStaticMarkup(<SnapshotSelection {...props} investigation={{...item,active_revision_id:receipt.revision_id,snapshot_selection:receipt}} snapshots={[]} metadataAvailable/>);
 assert.match(existing,/<form/);assert.match(existing,/Change selected data/);assert.match(existing,/This removes the selected data\. Lock the metric again before testing/);assert.match(existing,/I reviewed this data/);assert.match(existing,/disabled=""[^>]*>Save selected data/);
 const unavailable=renderToStaticMarkup(<SnapshotSelection {...props} investigation={{...item,snapshot_selection:null}} snapshots={[]} metadataAvailable={false}/>);
 assert.match(unavailable,/>Unavailable</);assert.match(unavailable,/Could not load your saved data/);assert.doesNotMatch(unavailable,/Upload a file first|>Ready</);assert.match(unavailable,/disabled=""[^>]*>Save selected data/);
});
