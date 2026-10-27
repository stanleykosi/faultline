import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, type Investigation, type Workspace } from '../../api';
import { CaseList, CaseListResults, CreateCase } from './Cases';
import { clearCaseDraft, saveCaseDraft, clearCaseDraftsForUser, prepareCaseDraftSubmission, readCaseDraft, type CaseDraftFields } from './case-drafts';
import { type CommandIdentity } from '../../command-key';
import { OperationLimits, OperationAssessmentResult, operationPreflightPath, readOperationAssessment, type OperationSelection, type Preflight, type PreflightLimits } from './Controls';
import { type OperationAssessment } from '../../../../../packages/core/src/preflight/assessment';
describe("Investigation list and draft form", () => {
    const workspace: Workspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Test workspace', created_at: '2026-10-01T00:00:00.000Z', role: 'owner', revision: 1 };
    const row: Investigation = { id: '22222222-2222-4222-8222-222222222222', workspace_id: workspace.id, title: 'Recorded investigation', question: 'Which explanation is supported?', affected_flow: 'Checkout', active_revision_id: '33333333-3333-4333-8333-333333333333', lifecycle: 'open', archived: false, revision: 2, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' };
    const defaults = { workspace, items: [] as Investigation[], known: true, loading: false, error: null as Error | null, search: '', archived: false, navigate: (_path: string) => { }, onCreate: () => { } };
    const html = (change: Partial<typeof defaults> = {}) => renderToStaticMarkup(<CaseListResults {...defaults} {...change}/>);
    const emptyHeadings = /No investigations yet|No matches|No archived investigations|Start an investigation/;
    test("failed, unknown, loading and confirmed empty lists retain distinct recovery and access states", () => {
        {
            const error = new ApiError(503, 'DATABASE_UNAVAILABLE', 'The scoped investigation read failed.', 'unit-failed-list');
            for (const filters of [{ search: '', archived: false }, { search: 'checkout', archived: false }, { search: '', archived: true }]) {
                const rendered = html({ ...filters, known: false, error });
                assert.match(rendered, /role="alert"/);
                assert.match(rendered, /The scoped investigation read failed/);
                assert.match(rendered, /Investigations unavailable/);
                assert.match(rendered, /Try refreshing/);
                assert.doesNotMatch(rendered, emptyHeadings);
                assert.doesNotMatch(rendered, /class="case-row"|class="empty"|status good|>PASS<|0%/);
                // An error takes precedence even if an earlier successful read was empty.
                assert.doesNotMatch(html({ ...filters, known: true, error }), emptyHeadings);
            }
        }
        {
            assert.match(html({ known: false }), /Investigations unavailable/);
            assert.doesNotMatch(html({ known: false }), emptyHeadings);
            const loading = html({ known: false, loading: true });
            assert.match(loading, /class="loading" role="status"/);
            assert.match(loading, /Loading investigations…/);
            assert.doesNotMatch(loading, emptyHeadings);
            assert.doesNotMatch(loading, /Investigations unavailable/);
        }
        {
            const empty = html();
            assert.match(empty, /No investigations yet/);
            assert.match(empty, /Start an investigation/);
            assert.doesNotMatch(empty, /Investigations unavailable/);
            const search = html({ search: 'no matching title' });
            assert.match(search, /No matches/);
            assert.match(search, /Try another search/);
            assert.doesNotMatch(search, /Start an investigation|Investigations unavailable/);
            const archived = html({ archived: true });
            assert.match(archived, /No archived investigations/);
            assert.match(archived, /will appear here/);
            assert.doesNotMatch(archived, /Start an investigation/);
            const viewer = html({ workspace: { ...workspace, role: 'viewer' } });
            assert.match(viewer, /Ask an owner or analyst/);
            assert.doesNotMatch(viewer, /<button/);
        }
        {
            const rendered = renderToStaticMarkup(<CaseList workspace={workspace} csrf="unit-csrf-not-live" navigate={() => { }}/>);
            assert.match(rendered, /<button class="text-button">Refresh<\/button>/);
            assert.doesNotMatch(rendered, /<button[^>]*disabled[^>]*>Refresh<\/button>/);
            assert.match(rendered, /Loading investigations…/);
            assert.doesNotMatch(rendered, /Start an investigation/);
        }
    });
    test('pagination failure retains the recorded rows and error without inventing empty state or executing row text', () => {
        const rendered = html({ items: [{ ...row, title: '<script>fabricatePass()</script>', question: '<img src=x onerror=run()>' }], error: new Error('Next page unavailable.') });
        assert.match(rendered, /Next page unavailable/);
        assert.match(rendered, /class="case-row"/);
        assert.match(rendered, new RegExp(`/w/${workspace.id}/cases/${row.id}/agent`));
        assert.match(rendered, /Updated/);
        assert.match(rendered, /&lt;script&gt;/);
        assert.match(rendered, /&lt;img/);
        assert.doesNotMatch(rendered, /<script>|<img|Investigations unavailable/);
        assert.doesNotMatch(rendered, emptyHeadings);
    });
    test('a reopened creation form restores all raw draft fields and uses a consistent question label', () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
        const values = new Map<string, string>();
        const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
        const actor = 'form-user', fields = { title: '  Retained title <draft>  ', question: ' Why did checkout drop?\nA second line. ', affected_flow: ' Cart → checkout  ' };
        const form = (user = actor) => renderToStaticMarkup(<CreateCase workspace={workspace} csrf="must-not-be-stored" currentUserId={user} onClose={() => { }} onCreated={() => { }}/>);
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
        }
        finally {
            if (previous)
                Object.defineProperty(globalThis, 'sessionStorage', previous);
            else
                Reflect.deleteProperty(globalThis, 'sessionStorage');
        }
    });
    test('creation warns when draft recovery fails while the creation action stays enabled', () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('Storage unavailable'); } });
        try {
            const rendered = renderToStaticMarkup(<CreateCase workspace={workspace} csrf="unit-csrf" currentUserId="form-user" onClose={() => { }} onCreated={() => { }}/>);
            assert.match(rendered, /Draft recovery is unavailable in this tab/);
            assert.match(rendered, /<button class="primary" type="submit">Create investigation<\/button>/);
            const isolated = renderToStaticMarkup(<CreateCase workspace={workspace} csrf="unit-csrf" onClose={() => { }} onCreated={() => { }}/>);
            assert.doesNotMatch(isolated, /Draft recovery is unavailable/);
        }
        finally {
            if (previous)
                Object.defineProperty(globalThis, 'sessionStorage', previous);
            else
                Reflect.deleteProperty(globalThis, 'sessionStorage');
        }
    });
});
describe("Draft persistence", () => {
    class TabStorage implements Storage {
        private values = new Map<string, string>();
        get length() { return this.values.size; }
        key(index: number) { return [...this.values.keys()][index] ?? null; }
        getItem(key: string) { return this.values.get(key) ?? null; }
        setItem(key: string, value: string) { this.values.set(key, value); }
        removeItem(key: string) { this.values.delete(key); }
        clear() { throw new Error("Drafts must never clear all tab storage."); }
    }
    function withStorage(target: Storage | (() => Storage), run: () => void) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
        Object.defineProperty(globalThis, "sessionStorage", {
            configurable: true,
            ...(typeof target === "function" ? { get: target } : { value: target }),
        });
        try {
            run();
        }
        finally {
            if (previous)
                Object.defineProperty(globalThis, "sessionStorage", previous);
            else
                Reflect.deleteProperty(globalThis, "sessionStorage");
        }
    }
    const actor = "user-one", workspace = "workspace-one";
    const fields: CaseDraftFields = {
        title: "  Mobile checkout <draft>  ",
        question: " Why did checkout drop?\nKeep the original spacing. ",
        affected_flow: " Cart → checkout → completed order  ",
    };
    const empty = { title: "", question: "", affected_flow: "", command: null };
    const commandRef = (): {
        current: CommandIdentity;
    } => ({ current: null });
    test("draft storage is isolated by actor, workspace and tab, including discard and logout", () => {
        {
            const tab = new TabStorage();
            withStorage(tab, () => {
                assert.equal(saveCaseDraft(actor, workspace, fields, null), "available");
                assert.deepEqual(readCaseDraft(actor, workspace), { draft: { ...fields, command: null }, status: "available" });
                assert.deepEqual(readCaseDraft("other-user", workspace).draft, empty);
                assert.deepEqual(readCaseDraft(actor, "other-workspace").draft, empty);
            });
            // A fresh consumer needs only the persisted tab storage, with no component state.
            withStorage(tab, () => assert.deepEqual(readCaseDraft(actor, workspace).draft, { ...fields, command: null }));
            withStorage(new TabStorage(), () => assert.deepEqual(readCaseDraft(actor, workspace).draft, empty));
        }
        {
            const tab = new TabStorage();
            withStorage(tab, () => {
                tab.setItem("unrelated-setting", "retained");
                for (const owner of [actor, `${actor}-other`, `${actor}:other`]) {
                    for (const scope of [workspace, "another-workspace"])
                        saveCaseDraft(owner, scope, fields, null);
                }
                assert.equal(clearCaseDraft(actor, workspace), "available");
                assert.deepEqual(readCaseDraft(actor, workspace).draft, empty);
                assert.deepEqual(readCaseDraft(actor, "another-workspace").draft, { ...fields, command: null });
                saveCaseDraft(actor, workspace, fields, null);
                assert.equal(clearCaseDraftsForUser(actor), "available");
                for (const scope of [workspace, "another-workspace"]) {
                    assert.deepEqual(readCaseDraft(actor, scope).draft, empty);
                    for (const other of [`${actor}-other`, `${actor}:other`]) {
                        assert.deepEqual(readCaseDraft(other, scope).draft, { ...fields, command: null });
                    }
                }
                assert.equal(tab.getItem("unrelated-setting"), "retained");
                assert.equal(tab.length, 5);
            });
        }
    });
    test("an uncertain create identity is persisted before POST, reused after reload and rotated for changed intent", () => {
        withStorage(new TabStorage(), () => {
            const initial = prepareCaseDraftSubmission(actor, workspace, fields, commandRef());
            assert.equal(initial.status, "available");
            assert.deepEqual(initial.body, {
                title: "Mobile checkout <draft>",
                question: "Why did checkout drop?\nKeep the original spacing.",
                affected_flow: "Cart → checkout → completed order",
            });
            const recovered = readCaseDraft(actor, workspace).draft;
            assert.equal(recovered.command?.key, initial.idempotencyKey);
            assert.deepEqual(JSON.parse(recovered.command!.bodyCanonical), { path: initial.path, method: "POST", body: initial.body });
            const reference = { current: recovered.command };
            const retry = prepareCaseDraftSubmission(actor, workspace, recovered, reference);
            assert.equal(retry.idempotencyKey, initial.idempotencyKey);
            assert.equal(prepareCaseDraftSubmission(actor, workspace, { ...recovered, title: initial.body.title }, reference).idempotencyKey, initial.idempotencyKey);
            const edited = { ...fields, question: "Which change affected checkout?" };
            // Input capture retains the uncertain identity until the reviewed intent is submitted.
            saveCaseDraft(actor, workspace, edited, reference.current);
            const editedRecovery = readCaseDraft(actor, workspace).draft;
            assert.equal(editedRecovery.command?.key, initial.idempotencyKey);
            const changed = prepareCaseDraftSubmission(actor, workspace, editedRecovery, { current: editedRecovery.command });
            assert.notEqual(changed.idempotencyKey, initial.idempotencyKey);
            assert.equal(readCaseDraft(actor, workspace).draft.command?.key, changed.idempotencyKey);
            assert.deepEqual(readCaseDraft(actor, workspace).draft.question, edited.question);
        });
    });
    test("stored drafts retain bounded fields and reject malformed or forged command identities", () => {
        {
            const tab = new TabStorage();
            withStorage(tab, () => {
                const extra = { ...fields, csrf: "secret-csrf", password: "secret-password", token: "secret-token" };
                assert.equal(saveCaseDraft(actor, workspace, extra, null), "available");
                const key = tab.key(0)!;
                assert.deepEqual(Object.keys(JSON.parse(tab.getItem(key)!)).sort(), ["affected_flow", "command", "question", "title", "version"]);
                assert.doesNotMatch(tab.getItem(key)!, /secret-|csrf|password|token/);
                // Even maximally escaped strings at the HTML limits fit the storage bounds.
                const bounded = { title: "\u0001".repeat(200), question: "\u0001".repeat(2000), affected_flow: "\u0001".repeat(2000) };
                const prepared = prepareCaseDraftSubmission(actor, workspace, bounded, commandRef());
                assert.equal(prepared.status, "available");
                const recovered = readCaseDraft(actor, workspace);
                assert.equal(recovered.status, "available");
                assert.equal(recovered.draft.title, bounded.title);
                assert.equal(recovered.draft.question, bounded.question);
                assert.equal(recovered.draft.affected_flow, bounded.affected_flow);
                assert.equal(recovered.draft.command?.key, prepared.idempotencyKey);
                assert.equal(saveCaseDraft(actor, workspace, { ...fields, title: "x".repeat(201) }, null), "unavailable");
                assert.deepEqual(readCaseDraft(actor, workspace).draft, empty);
            });
        }
        {
            const tab = new TabStorage();
            withStorage(tab, () => {
                prepareCaseDraftSubmission(actor, workspace, fields, commandRef());
                const key = tab.key(0)!, raw = tab.getItem(key)!;
                const baseline = JSON.parse(raw);
                const identityWithIntent = (intent: unknown) => ({ ...baseline.command, bodyCanonical: JSON.stringify(intent) });
                const intent = JSON.parse(baseline.command.bodyCanonical);
                const invalid = [
                    "{", "null", "[]", "x".repeat(64001),
                    JSON.stringify({ ...baseline, version: 2 }),
                    JSON.stringify({ ...baseline, csrf: "must-not-restore" }),
                    JSON.stringify({ ...baseline, title: "x".repeat(201) }),
                    JSON.stringify({ ...baseline, question: 42 }),
                    JSON.stringify({ ...baseline, command: { ...baseline.command, key: "untrusted-key" } }),
                    JSON.stringify({ ...baseline, command: { ...baseline.command, token: "must-not-restore" } }),
                    JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, path: "/api/v1/workspaces/other/cases" }) }),
                    JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, method: "DELETE" }) }),
                    JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, body: { ...intent.body, password: "must-not-restore" } }) }),
                    JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, csrf: "must-not-restore" }) }),
                ];
                for (const value of invalid) {
                    tab.setItem(key, value);
                    assert.deepEqual(readCaseDraft(actor, workspace), { draft: empty, status: "unavailable" });
                }
                assert.equal(saveCaseDraft(actor, workspace, fields, null), "available");
                assert.deepEqual(readCaseDraft(actor, workspace).draft, { ...fields, command: null });
                assert.equal(saveCaseDraft(actor, workspace, fields, { ...baseline.command, bodyCanonical: JSON.stringify({ ...intent, csrf: "must-not-save" }) }), "unavailable");
                assert.equal(tab.getItem(key), null);
            });
        }
    });
    test("unavailable storage or missing actor never blocks creation or invents recovery", () => {
        {
            withStorage(() => { throw new Error("Storage access denied"); }, () => {
                assert.deepEqual(readCaseDraft(actor, workspace), { draft: empty, status: "unavailable" });
                assert.equal(saveCaseDraft(actor, workspace, fields, null), "unavailable");
                assert.equal(clearCaseDraft(actor, workspace), "unavailable");
                assert.equal(clearCaseDraftsForUser(actor), "unavailable");
                const command = commandRef();
                const first = prepareCaseDraftSubmission(actor, workspace, fields, command);
                assert.equal(first.status, "unavailable");
                assert.ok(first.idempotencyKey);
                assert.equal(prepareCaseDraftSubmission(actor, workspace, fields, command).idempotencyKey, first.idempotencyKey);
            });
            const tab = new TabStorage();
            withStorage(tab, () => {
                saveCaseDraft(actor, workspace, fields, null);
                tab.setItem = () => { throw new Error("Quota exceeded"); };
                assert.equal(prepareCaseDraftSubmission(actor, workspace, { ...fields, title: "Changed intent" }, commandRef()).status, "unavailable");
                assert.deepEqual(readCaseDraft(actor, workspace).draft, empty);
                tab.getItem = () => { throw new Error("Read denied"); };
                tab.removeItem = () => { throw new Error("Delete denied"); };
                assert.equal(readCaseDraft(actor, workspace).status, "unavailable");
                assert.equal(clearCaseDraft(actor, workspace), "unavailable");
                assert.equal(saveCaseDraft(actor, workspace, fields, null), "unavailable");
            });
        }
        {
            let accesses = 0;
            withStorage(() => { accesses++; throw new Error("Must not access storage"); }, () => {
                assert.deepEqual(readCaseDraft(undefined, workspace), { draft: empty, status: "disabled" });
                assert.equal(saveCaseDraft(undefined, workspace, fields, null), "disabled");
                assert.equal(clearCaseDraft(undefined, workspace), "disabled");
                assert.equal(prepareCaseDraftSubmission(undefined, workspace, fields, commandRef()).status, "disabled");
                assert.equal(accesses, 0);
            });
        }
    });
});
describe("Finite operation assessment", () => {
    const limits: PreflightLimits = {
        source: { file_bytes: 52428800, expanded_bytes: 268435456, records: 4, files: 100, json_depth: 32, csv_field_bytes: 1048576 },
        metric: { cohorts: 8, period_days: 31, horizon_seconds: 1800 },
        storage: { ceiling_bytes: 1073741824, used_bytes: null, reserved_bytes: null, remaining_bytes: null },
        model: { automatic_calls: 0, input_tokens: 64, output_tokens: 32, call_timeout_seconds: 90 },
        jobs: { source_capture_deadline_seconds: 1800, workspace_concurrency: 1, installation_concurrency: 2, cancel_poll_seconds: 2 },
        browser: { enabled: false, task_timeout_seconds: 600, matrix_cells: 6, repeats_per_cell: 3, actions_per_cell: 30, artifact_bytes: 104857600 }
    };
    const prerequisite: Preflight = { case_id: 'case-unit', revision_id: 'revision-unit', manual: true, metric: 'Not frozen', snapshot: 'Absent', active_work: false, model: 'none', runner: 'disabled', quality: 'Inputs still require review.' };
    test("effective limits distinguish unknown capacity, explicit zero usage and installation constraints", () => {
        {
            const html = renderToStaticMarkup(<OperationLimits usage={{ work_units: null, model: null }} selectedInput={{ snapshot_id: null, records: null }}/>);
            assert.match(html, /Limits are unknown/);
            assert.match(html, /Record limit per capture<\/dt><dd>Unknown/);
            assert.match(html, /Selected snapshot records<\/span><strong>Unknown/);
            assert.match(html, /Storage remaining<\/dt><dd>Unknown/);
            assert.match(html, /Model calls spent<\/dt><dd>Unknown/);
            assert.match(html, /Runs remaining<\/dt><dd>Unknown/);
            assert.doesNotMatch(html, /<dd>0(?: |<)|status good|>PASS<|>Healthy</);
            assert.match(html, /Missing usage is unknown/);
        }
        {
            const html = renderToStaticMarkup(<OperationLimits limits={limits} selectedInput={{ snapshot_id: 'snapshot-unit', records: 3 }}/>);
            assert.match(html, /Record limit per capture<\/dt><dd>4/);
            assert.doesNotMatch(html, /Record limit per capture<\/dt><dd>100,000/);
            assert.match(html, /Total model wire attempts per revision<\/dt><dd>0/);
            assert.match(html, /Model input-token ceiling<\/dt><dd>64/);
            assert.match(html, /52,428,800 bytes \(50 MiB\)/);
            assert.match(html, /Days per metric period<\/dt><dd>31 days/);
            assert.match(html, /Conversion observation horizon<\/dt><dd>1,800 seconds/);
            assert.match(html, /Selected snapshot records<\/span><strong>3/);
            assert.match(html, /Browser tests<\/dt><dd>Disabled/);
            assert.doesNotMatch(html, /<button|>PASS<|status good/);
        }
        {
            const html = renderToStaticMarkup(<OperationLimits limits={limits} usage={{ work_units: { ceiling: 12, spent: 0, reserved: 2, remaining: 10 }, model: { calls_spent: 0, calls_reserved: 0, input_spent: 0, input_reserved: 0, output_spent: 0, output_reserved: 0 } }}/>);
            assert.match(html, /Investigation storage limit<\/dt><dd>1,073,741,824 bytes \(1 GiB\)/);
            assert.match(html, /Storage used<\/dt><dd>Unknown/);
            assert.match(html, /Storage reserved<\/dt><dd>Unknown/);
            assert.match(html, /Storage remaining<\/dt><dd>Unknown/);
            assert.match(html, /Runs used<\/dt><dd>0/);
            assert.match(html, /Runs remaining<\/dt><dd>10/);
            assert.match(html, /Model calls spent<\/dt><dd>0/);
            assert.match(html, /neither is a currency estimate/);
            const invalid = renderToStaticMarkup(<OperationLimits limits={{ ...limits, source: { ...limits.source, records: Number.NaN }, storage: { ...limits.storage, used_bytes: -1 } }}/>);
            assert.match(invalid, /Record limit per capture<\/dt><dd>Unknown/);
            assert.match(invalid, /Storage used<\/dt><dd>Unknown/);
        }
    });
    const wid = '11111111-1111-4111-8111-111111111111', cid = '22222222-2222-4222-8222-222222222222', revision = '33333333-3333-4333-8333-333333333333', resourceId = '44444444-4444-4444-8444-444444444444';
    const base = `/api/v1/workspaces/${wid}/cases/${cid}`, bindingHash = 'b'.repeat(64);
    const input = { id: resourceId, hash: bindingHash, revision_id: revision, frozen: true, freshness: 'current' as const };
    const choice: OperationSelection = { operation: 'analytic', objective: '', hypothesis_id: '', analytic_plan_id: '', candidate_id: '', mechanism_result_id: '', plan_id: '', grant_id: '', approval_id: '' };
    const assessment: OperationAssessment = {
        operation: 'analytic', status: 'blocked', revision_id: revision,
        prerequisites: [{ code: 'METRIC_FROZEN', status: 'missing', detail: 'Select a frozen metric.' }, { code: 'SNAPSHOT_FROZEN', status: 'ready', detail: 'The frozen snapshot matches this revision.' }],
        selected_input: { metric: { id: null, hash: null, revision_id: null, frozen: null, freshness: 'unknown' }, snapshot: { ...input, records: 120 } },
        admission: { workspace_active: null, installation_active: 0, workspace_limit: 1, installation_limit: 2 },
        capabilities: { runner: { configured: false, status: 'unavailable', current_recorded_binding: null, readiness: 'blocked' }, model: { configured: false, status: 'unconfigured', current_recorded_binding: null, readiness: 'blocked' } },
        required_work_units: 1, optional_model_calls: 0, expected_observations: null, browser_limits: null, requested_storage_bytes: null, requested_duration_seconds: null, assessment_scope: 'prerequisites_only', admission_reserved: false
    };
    test("assessments preserve missing, provisional and stale prerequisites without granting execution", () => {
        {
            const html = renderToStaticMarkup(<OperationAssessmentResult assessment={assessment}/>);
            assert.match(html, /data-prerequisite-code="METRIC_FROZEN"/);
            assert.match(html, /missing<\/span>/);
            assert.match(html, /Select a frozen metric/);
            assert.match(html, /blocked<\/span>/);
            assert.match(html, /Workspace active work<\/dt><dd>Unknown/);
            assert.match(html, /Installation active work<\/dt><dd>0/);
            assert.match(html, /Requested storage estimate<\/dt><dd>Unknown/);
            assert.match(html, /Requested duration estimate<\/dt><dd>Unknown/);
            assert.match(html, /Ready does not mean the test passed/);
            assert.match(html, /nothing runs from this check/);
            assert.doesNotMatch(html, /status good|>PASS<|<button/);
        }
        {
            const value: OperationAssessment = { ...assessment, selected_input: { metric: input, snapshot: { ...input, records: null } }, prerequisites: [
                    { code: 'COVERAGE_TAIL', status: 'blocked', detail: 'The declared event watermark does not cover the conversion observation tail.', binding: { coverage_basis: 'lateness_assumption' } },
                    { code: 'DATA_QUALITY', status: 'unknown', detail: 'Provisional extraction cannot establish complete source coverage.' },
                    { code: 'WORKSPACE_CAPACITY', status: 'unknown', detail: 'Current workspace activity is not available.' }
                ] };
            const html = renderToStaticMarkup(<OperationAssessmentResult assessment={value}/>);
            assert.match(html, /conversion observation tail/);
            assert.match(html, /Provisional extraction/);
            assert.match(html, /lateness_assumption/);
            assert.match(html, /Recorded rows<\/dt><dd>Unknown/);
            assert.match(html, /Optional model capability/);
            assert.match(html, /Recorded availability<\/dt><dd>unconfigured/);
            assert.match(html, /Optional model calls required<\/dt><dd>0/);
            assert.match(html, /Configuration and recorded availability are separate/);
            assert.match(html, /Unknown capacity and estimates remain unknown/);
            assert.doesNotMatch(html, /status good|>PASS<|Complete coverage/);
        }
        {
            const ready: OperationAssessment = { ...assessment, operation: 'browser_plan', status: 'ready', required_work_units: 0, prerequisites: [{ code: 'BROWSER_OBJECTIVE', status: 'ready', detail: 'The protected mechanism objective requires twelve observations.' }, { code: 'HYPOTHESIS_CURRENT', status: 'ready', detail: 'Current reviewed hypothesis.' }], expected_observations: 12, browser_limits: { task_timeout_seconds: 600, artifact_bytes: 104857600 } };
            const planned = renderToStaticMarkup(<OperationAssessmentResult assessment={ready}/>);
            assert.match(planned, /Prepare browser test/);
            assert.match(planned, /Required work units<\/dt><dd>0/);
            assert.match(planned, /nothing runs from this check/);
            assert.match(planned, /Required protected observations<\/dt><dd>12/);
            assert.doesNotMatch(planned, /PLAN APPROVAL CURRENT|TARGET GRANT CURRENT|Approve|Execute|status good/);
            const running: OperationAssessment = { ...ready, operation: 'browser_run', status: 'blocked', required_work_units: 1, expected_observations: 18, prerequisites: [{ code: 'PLAN_APPROVAL_CURRENT', status: 'missing', detail: 'Explicit approval of the exact immutable plan is required.' }, { code: 'TARGET_GRANT_CURRENT', status: 'stale', detail: 'The target grant is expired.' }] };
            const run = renderToStaticMarkup(<OperationAssessmentResult assessment={running}/>);
            assert.match(run, /PLAN APPROVAL CURRENT/);
            assert.match(run, /missing<\/span>/);
            assert.match(run, /expired/);
            assert.match(run, /stale<\/span>/);
            assert.match(run, /Required protected observations<\/dt><dd>18/);
            assert.match(run, /Admission reserved<\/dt><dd>No/);
        }
        {
            const value: OperationAssessment = { ...assessment, prerequisites: [{ code: 'EVIDENCE_CURRENT', status: 'stale', detail: '<script>changeProtectedTruth()</script>', binding: { source_ref: '<img src=x onerror=run()>', approved: false, size_bytes: null } }], selected_input: { ...assessment.selected_input, metric: { ...input, id: '<a href="https://untrusted.invalid">metric</a>' } } };
            const html = renderToStaticMarkup(<OperationAssessmentResult assessment={value}/>);
            assert.match(html, /&lt;script&gt;/);
            assert.match(html, /&lt;img/);
            assert.match(html, /&lt;a href=/);
            assert.doesNotMatch(html, /<script>|<img|<a href=/);
            assert.match(html, /size bytes<\/dt><dd>Unknown/);
            assert.match(html, /approved<\/dt><dd>No/);
        }
    });
    test("assessment reads are finite, scoped and reject foreign or incomplete authority", async () => {
        {
            const extras = { ...choice, objective: 'correction', hypothesis_id: resourceId, analytic_plan_id: resourceId, candidate_id: resourceId, mechanism_result_id: resourceId, plan_id: resourceId, grant_id: resourceId, approval_id: resourceId, target_url: 'https://external.invalid' } as OperationSelection;
            assert.equal(operationPreflightPath(base, extras), base + '/preflight?operation=analytic&hypothesis_id=' + resourceId + '&analytic_plan_id=' + resourceId);
            const plan = new URL(operationPreflightPath(base, { ...extras, operation: 'browser_plan' }), 'http://localhost:3000');
            assert.deepEqual([...plan.searchParams.keys()], ['operation', 'objective', 'hypothesis_id', 'candidate_id', 'mechanism_result_id']);
            assert.equal(plan.searchParams.get('objective'), 'correction');
            const mechanism = new URL(operationPreflightPath(base, { ...extras, operation: 'browser_plan', objective: 'mechanism' }), 'http://localhost:3000');
            assert.deepEqual([...mechanism.searchParams.keys()], ['operation', 'objective', 'hypothesis_id']);
            const run = new URL(operationPreflightPath(base, { ...extras, operation: 'browser_run' }), 'http://localhost:3000');
            assert.deepEqual([...run.searchParams.keys()], ['operation', 'objective', 'hypothesis_id', 'candidate_id', 'mechanism_result_id', 'plan_id', 'grant_id', 'approval_id']);
            assert.throws(() => operationPreflightPath('https://external.invalid', choice), /finite operation/);
            assert.throws(() => operationPreflightPath(base, { ...choice, operation: 'browser_run', plan_id: 'https://external.invalid' }), /UUIDs, not URLs or expressions/);
            assert.throws(() => operationPreflightPath(base, { ...choice, operation: 'browser_plan', objective: 'execute(anything)' as 'mechanism' }), /finite mechanism or correction/);
        }
        {
            const originalFetch = globalThis.fetch, calls: {
                path: string;
                options: RequestInit | undefined;
            }[] = [];
            globalThis.fetch = async (path, options) => { calls.push({ path: String(path), options }); return new Response(JSON.stringify({ data: { ...prerequisite, case_id: cid, assessment }, meta: { request_id: 'unit-preflight' } }), { headers: { 'Content-Type': 'application/json' } }); };
            try {
                assert.deepEqual(await readOperationAssessment(base, cid, choice, new AbortController().signal, revision), assessment);
                assert.equal(calls.length, 1);
                assert.equal(calls[0].path, base + '/preflight?operation=analytic');
                assert.equal(calls[0].options?.method, 'GET');
                assert.equal(calls[0].options?.credentials, 'same-origin');
                assert.equal(calls[0].options?.body, undefined);
                const headers = new Headers(calls[0].options?.headers);
                assert.equal(headers.has('Idempotency-Key'), false);
                assert.equal(headers.has('X-CSRF-Token'), false);
                assert.equal(headers.has('X-Faultline-Revision'), false);
            }
            finally {
                globalThis.fetch = originalFetch;
            }
        }
        {
            const originalFetch = globalThis.fetch;
            try {
                for (const data of [{ ...prerequisite, case_id: wid, assessment }, { ...prerequisite, case_id: cid, assessment: { ...assessment, revision_id: resourceId } }, { ...prerequisite, case_id: cid, assessment: { ...assessment, admission_reserved: true } }, { ...prerequisite, case_id: cid }, { ...prerequisite, case_id: cid, assessment: { ...assessment, status: 'PASS' } }]) {
                    globalThis.fetch = async () => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
                    await assert.rejects(readOperationAssessment(base, cid, choice, new AbortController().signal, revision), /unavailable or incomplete|input revision changed/);
                }
            }
            finally {
                globalThis.fetch = originalFetch;
            }
        }
    });
});
