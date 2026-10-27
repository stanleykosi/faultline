import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError, type Investigation, type Workspace} from '../../api';
import {CaseList, CaseListResults, CreateCase} from './Cases';
import {clearCaseDraft, saveCaseDraft} from './case-drafts';

const workspace: Workspace = {id: '11111111-1111-4111-8111-111111111111', name: 'Test workspace', created_at: '2026-10-01T00:00:00.000Z', role: 'owner', revision: 1};
const row: Investigation = {id: '22222222-2222-4222-8222-222222222222', workspace_id: workspace.id, title: 'Recorded investigation', question: 'Which explanation is supported?', affected_flow: 'Checkout', active_revision_id: '33333333-3333-4333-8333-333333333333', lifecycle: 'open', archived: false, revision: 2, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z'};
const defaults = {workspace, items: [] as Investigation[], known: true, loading: false, error: null as Error | null, search: '', archived: false, navigate: (_path: string) => {}, onCreate: () => {}};
const html = (change: Partial<typeof defaults> = {}) => renderToStaticMarkup(<CaseListResults {...defaults} {...change} />);
const emptyHeadings = /No investigations yet|No matches|No archived investigations|Start an investigation/;

test('failed first-page reads never assert an empty workspace, matching result or archived history', () => {
  const error = new ApiError(503, 'DATABASE_UNAVAILABLE', 'The scoped investigation read failed.', 'unit-failed-list');
  for (const filters of [{search: '', archived: false}, {search: 'checkout', archived: false}, {search: '', archived: true}]) {
    const rendered = html({...filters, known: false, error});
    assert.match(rendered, /role="alert"/); assert.match(rendered, /The scoped investigation read failed/); assert.match(rendered, /Investigations unavailable/);
    assert.match(rendered, /Try refreshing/); assert.doesNotMatch(rendered, emptyHeadings); assert.doesNotMatch(rendered, /class="case-row"|class="empty"|status good|>PASS<|0%/);
    // An error takes precedence even if an earlier successful read was empty.
    assert.doesNotMatch(html({...filters, known: true, error}), emptyHeadings);
  }
});

test('unconfirmed and loading lists stay distinct from a successfully empty result', () => {
  assert.match(html({known: false}), /Investigations unavailable/); assert.doesNotMatch(html({known: false}), emptyHeadings);
  const loading = html({known: false, loading: true}); assert.match(loading, /class="loading" role="status"/); assert.match(loading, /Loading investigations…/); assert.doesNotMatch(loading, emptyHeadings); assert.doesNotMatch(loading, /Investigations unavailable/);
});

test('successful empty responses retain create, search, archive and viewer semantics', () => {
  const empty = html(); assert.match(empty, /No investigations yet/); assert.match(empty, /Start an investigation/); assert.doesNotMatch(empty, /Investigations unavailable/);
  const search = html({search: 'no matching title'}); assert.match(search, /No matches/); assert.match(search, /Try another search/); assert.doesNotMatch(search, /Start an investigation|Investigations unavailable/);
  const archived = html({archived: true}); assert.match(archived, /No archived investigations/); assert.match(archived, /will appear here/); assert.doesNotMatch(archived, /Start an investigation/);
  const viewer = html({workspace: {...workspace, role: 'viewer'}}); assert.match(viewer, /Ask an owner or analyst/); assert.doesNotMatch(viewer, /<button/);
});

test('pagination failure retains the recorded rows and error without inventing empty state or executing row text', () => {
  const rendered = html({items: [{...row, title: '<script>fabricatePass()</script>', question: '<img src=x onerror=run()>'}], error: new Error('Next page unavailable.')});
  assert.match(rendered, /Next page unavailable/); assert.match(rendered, /class="case-row"/); assert.match(rendered, new RegExp(`/w/${workspace.id}/cases/${row.id}/agent`)); assert.match(rendered, /Updated/);
  assert.match(rendered, /&lt;script&gt;/); assert.match(rendered, /&lt;img/); assert.doesNotMatch(rendered, /<script>|<img|Investigations unavailable/); assert.doesNotMatch(rendered, emptyHeadings);
});

test('the existing list refresh remains enabled while the initial list is unknown', () => {
  const rendered = renderToStaticMarkup(<CaseList workspace={workspace} csrf="unit-csrf-not-live" navigate={() => {}} />);
  assert.match(rendered, /<button class="text-button">Refresh<\/button>/); assert.doesNotMatch(rendered, /<button[^>]*disabled[^>]*>Refresh<\/button>/); assert.match(rendered, /Loading investigations…/); assert.doesNotMatch(rendered, /Start an investigation/);
});

test('the product list exposes persisted investigations without the retired sample launcher', () => {
  const list = html({items: [row]});
  const page = renderToStaticMarkup(<CaseList workspace={workspace} csrf="unit-csrf-not-live" navigate={() => {}} />);
  assert.doesNotMatch(list + page, /Try Faultline|Mobile checkout regression|Traffic mix shift|Create fresh/i);
  assert.match(list, /Recorded investigation/);
});

test('a reopened creation form restores all raw draft fields and uses a consistent question label', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key)};
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: storage});
  const actor = 'form-user', fields = {title: '  Retained title <draft>  ', question: ' Why did checkout drop?\nA second line. ', affected_flow: ' Cart → checkout  '};
  const form = (user = actor) => renderToStaticMarkup(<CreateCase workspace={workspace} csrf="must-not-be-stored" currentUserId={user} onClose={() => {}} onCreated={() => {}} />);
  try {
    assert.equal(saveCaseDraft(actor, workspace.id, fields, null), 'available');
    const reopened = form();
    assert.match(reopened, /name="title"[^>]*value="  Retained title &lt;draft&gt;  "/);
    assert.match(reopened, /<textarea[^>]*name="question"[^>]*> Why did checkout drop\?\nA second line\. <\/textarea>/);
    assert.match(reopened, /name="affected_flow"[^>]*value=" Cart → checkout  "/);
    assert.match(reopened, />Your question<\/label>/);
    assert.doesNotMatch(reopened, /What changed\?|Draft recovery is unavailable/);
    assert.doesNotMatch(form('other-user'), /Retained title|A second line|Cart → checkout  /);
    assert.doesNotMatch([...values.values()].join(''), /must-not-be-stored/);
    clearCaseDraft(actor, workspace.id);
    assert.doesNotMatch(form(), /Retained title|A second line/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('creation warns when draft recovery fails while the creation action stays enabled', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, get: () => {throw new Error('Storage unavailable');}});
  try {
    const rendered = renderToStaticMarkup(<CreateCase workspace={workspace} csrf="unit-csrf" currentUserId="form-user" onClose={() => {}} onCreated={() => {}} />);
    assert.match(rendered, /Draft recovery is unavailable in this tab/);
    assert.match(rendered, /<button class="primary" type="submit">Create investigation<\/button>/);
    const isolated = renderToStaticMarkup(<CreateCase workspace={workspace} csrf="unit-csrf" onClose={() => {}} onCreated={() => {}} />);
    assert.doesNotMatch(isolated, /Draft recovery is unavailable/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
