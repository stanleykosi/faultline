import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError, type Workspace} from '../../api';
import {Activity, ActivityFilterForm, ActivityResults, activityReadPath, emptyActivityFilters, readActivityPage, reviewActivityFilters, type ActivityItem} from './Activity';

const wid = '11111111-1111-4111-8111-111111111111', cid = '22222222-2222-4222-8222-222222222222', actor = 'Aa1_'.repeat(8), other = '44444444-bbbb-4444-8444-444444444444';
const workspace: Workspace = {id: wid, name: 'Unit workspace', created_at: '2026-10-01T00:00:00Z', role: 'owner', revision: 1};
const draft = () => ({case_id: cid, actor_id: actor, action: ' comment.create ', from: '2026-10-13T09:00:00.000001Z', to: '2026-10-13T09:00:00.000002Z'});
const row: ActivityItem = {id: other, operation: 'comment.create', actor_id: actor, created_at: '2026-10-13T09:00:00.000001Z', details: {case_id: cid, object_revision: 3, outcome: 'recorded'}};
const defaults = {workspace, audit: true, currentUserId: actor, items: [] as ActivityItem[], known: false, loading: false, pending: '', error: null as Error | null, navigate: (_path: string) => {}, onRead: (_item: ActivityItem) => {}};

test('applied filter review remains bound across draft edits, pagination and reset', () => {
  const edited = draft(), applied = reviewActivityFilters(edited, true);
  assert.equal(applied.actor_id, actor); assert.equal(applied.action, 'comment.create'); assert.ok(Object.isFrozen(applied));
  edited.actor_id = other; edited.case_id = other; edited.action = 'case.close';
  const first = new URL(activityReadPath(wid, true, applied), 'http://localhost'), next = new URL(activityReadPath(wid, true, applied, 'signed+cursor/token'), 'http://localhost');
  assert.equal(first.pathname, `/api/v1/workspaces/${wid}/audit`); assert.deepEqual([...first.searchParams], [['case_id', cid], ['actor_id', actor], ['action', 'comment.create'], ['from', '2026-10-13T09:00:00.000001Z'], ['to', '2026-10-13T09:00:00.000002Z']]);
  assert.equal(next.searchParams.get('cursor'), 'signed+cursor/token'); next.searchParams.delete('cursor'); assert.equal(next.search, first.search);
  assert.equal(new URL(activityReadPath(wid, true, reviewActivityFilters(edited, true)), 'http://localhost').searchParams.get('actor_id'), other);
  assert.equal(activityReadPath(wid, true, emptyActivityFilters), `/api/v1/workspaces/${wid}/audit`);
  const caseSensitive = actor.toUpperCase();
  assert.equal(reviewActivityFilters({...emptyActivityFilters, actor_id: caseSensitive}, true).actor_id, caseSensitive);
});

test('invalid actor/UTC intervals and personal actor selectors fail before transport', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => {calls++; throw new Error('No transport expected.');};
  try {
    for (const actor_id of ['not valid', actor + '!', "x' OR true", 'x'.repeat(129)]) await assert.rejects(readActivityPage(wid, true, {...emptyActivityFilters, actor_id}), /exact actor identity/);
    for (const from of ['2026-02-30T00:00:00Z', '2026-10-13T09:00:00', '2026-10-13T10:00:00+01:00', '2026-10-13T09:00:00.0000001Z']) assert.throws(() => reviewActivityFilters({...emptyActivityFilters, from}, true), /UTC/);
    assert.throws(() => reviewActivityFilters({...draft(), to: '2026-10-13T09:00:00.000001Z'}, true), /must precede/);
    await assert.rejects(readActivityPage(wid, false, {...emptyActivityFilters, actor_id: actor}), /your own notifications/);
    assert.equal(activityReadPath(wid, false, {...emptyActivityFilters, case_id: cid}), `/api/v1/workspaces/${wid}/activity?case_id=${cid}`);
    assert.equal(calls, 0);
  } finally {globalThis.fetch = originalFetch;}
});

test('audit page transport is scoped GET-only with all applied fields retained on additional pages', async () => {
  const originalFetch = globalThis.fetch, seen: {path: string; options?: RequestInit}[] = [], edited = draft(), applied = reviewActivityFilters(edited, true);
  globalThis.fetch = async (path, options) => {seen.push({path: String(path), options}); return new Response(JSON.stringify({data: [row], meta: {request_id: 'unit-audit'}, page: {next_cursor: seen.length === 1 ? 'signed-cursor' : null}}), {headers: {'Content-Type': 'application/json'}});};
  try {
    const first = await readActivityPage(wid, true, applied); edited.actor_id = other;
    assert.deepEqual((await readActivityPage(wid, true, applied, first.page?.next_cursor)).data, [row]);
    assert.equal(seen.length, 2);
    for (const call of seen) {const query = new URL(call.path, 'http://localhost').searchParams; assert.equal(query.get('actor_id'), actor); assert.equal(query.get('case_id'), cid); assert.equal(query.get('action'), 'comment.create'); assert.equal(query.get('from'), applied.from); assert.equal(query.get('to'), applied.to); assert.equal(call.options?.method, 'GET'); assert.equal(call.options?.body, undefined); const headers = new Headers(call.options?.headers); assert.equal(headers.has('X-CSRF-Token'), false); assert.equal(headers.has('Idempotency-Key'), false);}
    assert.equal(new URL(seen[1].path, 'http://localhost').searchParams.get('cursor'), 'signed-cursor');
  } finally {globalThis.fetch = originalFetch;}
});

test('owner form exposes review/apply/reset and UTC semantics without granting audit UI to another role', () => {
  const applied = reviewActivityFilters(draft(), true), rendered = renderToStaticMarkup(<ActivityFilterForm audit draft={{...applied, actor_id: other}} applied={applied} disabled={false} onDraft={() => {}} onApply={() => {}} onReset={() => {}} />);
  for (const label of ['Investigation ID', 'User ID', 'Action', 'From (UTC)', 'To (UTC)', 'Apply filters', 'Reset filters', 'Active filters']) assert.ok(rendered.includes(label));
  assert.match(rendered, new RegExp(`<dt>User ID</dt><dd>${actor}</dd>`)); assert.match(rendered, /value="44444444-bbbb/); assert.doesNotMatch(rendered, /Save|Approve|Execute/);
  const personal = renderToStaticMarkup(<ActivityFilterForm audit={false} draft={emptyActivityFilters} applied={emptyActivityFilters} disabled={false} onDraft={() => {}} onApply={() => {}} onReset={() => {}} />);
  assert.match(personal, /Investigation ID/); assert.doesNotMatch(personal, /audit-actor-filter|audit-action-filter|audit-from-filter|audit-to-filter/);
  const denied = renderToStaticMarkup(<Activity workspace={{...workspace, role: 'analyst'}} csrf="unit-not-live" currentUserId={actor} audit navigate={() => {}} />);
  assert.match(denied, /Owner access required/); assert.doesNotMatch(denied, /Apply filters|User ID/);
});

test('failed or malformed first-page reads remain unknown; pagination errors preserve attributable rows', async () => {
  const error = new ApiError(503, 'DATABASE_UNAVAILABLE', 'The scoped audit read failed.'), html = (change: Partial<typeof defaults> = {}) => renderToStaticMarkup(<ActivityResults {...defaults} {...change} />);
  assert.match(html({error}), /role="alert"/); assert.match(html({error}), /Status unknown/); assert.match(html({error}), /Activity log unavailable/); assert.doesNotMatch(html({error}), /No matching activity/);
  assert.doesNotMatch(html({known: true, error}), /No matching activity/); assert.match(html({known: true}), /No matching activity/);
  const recorded = html({items: [{...row, details: {...row.details, text: '<script>fabricatePass()</script>'}}], known: true, error: new Error('Next page unavailable.')});
  assert.match(recorded, /Next page unavailable/); assert.match(recorded, /User Aa1_/); assert.match(recorded, /Open investigation/); assert.match(recorded, /&lt;script&gt;/); assert.doesNotMatch(recorded, /<script>|Mark as read|No matching activity/);
  const originalFetch = globalThis.fetch;
  try {for (const value of [{data: null}, {}, {data: [], page: {next_cursor: 4}}]) {globalThis.fetch = async () => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}}); await assert.rejects(readActivityPage(wid, true, emptyActivityFilters), /History is unavailable/);}}
  finally {globalThis.fetch = originalFetch;}
});
