import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceGeneral, workspaceRename } from './WorkspaceGeneral';
import { BudgetView, RetentionImpactView, readPolicyPatch, reviewedPolicyBody, type RetentionPreview } from './Policies';
import { BudgetExtensions, pinBudgetExtension, type ModelCallAllowance } from './BudgetExtensions';
import { type Investigation } from '../../api';
import { reviewedScope, type DeletionPreview } from './Deletion';
describe("Workspace edits", () => {
    test("workspace rename requires a bounded actual edit and owner controls", () => {
        {
            assert.equal(workspaceRename('  café 🧭  ', 'Original'), 'café 🧭');
            for (const value of ['   ', 'Original', 'x'.repeat(201)])
                assert.throws(() => workspaceRename(value, 'Original'));
        }
        {
            const common = { id: 'workspace-id', name: 'Original', created_at: '2026-10-13T12:00:00Z', revision: 4 };
            for (const role of ['analyst', 'viewer'] as const) {
                const html = renderToStaticMarkup(<WorkspaceGeneral workspace={{ ...common, role }} csrf="" onChanged={async () => { }}/>);
                assert.match(html, /Only an owner can rename/);
                assert.doesNotMatch(html, /Review change|New name/);
            }
            const owner = renderToStaticMarkup(<WorkspaceGeneral workspace={{ ...common, role: 'owner' }} csrf="" onChanged={async () => { }}/>);
            assert.match(owner, /Review change/);
            assert.match(owner, /Version 4/);
        }
    });
});
describe("Policy and retention review", () => {
    const now = Date.parse('2026-10-11T12:00:00.000Z');
    const values = { max_automatic_model_calls: 4, max_input_tokens: 40000, max_output_tokens: 8000, max_records_per_snapshot: 100000, raw_upload_retention_days: 30, canonical_event_retention_days: 90, attachment_retention_days: 90, report_retention_days: 365, audit_retention_days: 365 };
    const record = { value: values, revision: 3, installation_ceilings: values };
    function form(changed: Partial<Record<string, string>> = {}) { const result = new FormData(); for (const [key, value] of Object.entries(values))
        result.set(key, changed[key] ?? String(value)); return result; }
    function preview(): RetentionPreview { return { policy_revision: 3, previous_policy_hash: 'a'.repeat(64), policy_hash: 'b'.repeat(64), patch: { canonical_event_retention_days: 1 }, as_of: '2026-10-11T12:00:00.000Z', effective_at: '2026-10-18T12:00:00.000Z', grace_days: 7, impact_hash: 'c'.repeat(64), review_token: 'private-review-unit-fixture', review_expires_at: '2026-10-11T12:05:00.000Z', backup_notice: 'Private bytes remain pending separate review.', impact: { resources: [{ resource_kind: 'snapshot', resource_id: 'reviewed-snapshot', case_id: 'case-id', content_hash: 'd'.repeat(64), captured_at: '2026-10-01T12:00:00.000Z', age_days: 10, revision_id: 'frozen-input-id', resource_revision: null, object_keys: ['private-object-hash'], previous_expires_at: '2026-12-30T12:00:00.000Z', expires_at: '2026-10-18T12:00:00.000Z', shortened: true, shared_reference_count: 2, binding: { source_id: 'reviewed-source' }, caused_by: [], cited_reports: [{ resource_kind: 'report', resource_id: 'cited-report-id', content_hash: 'e'.repeat(64), revision_id: 'frozen-input-id' }], report_downloads: [{ resource_kind: 'report_export', resource_id: 'dependent-download-id', content_hash: 'f'.repeat(64), revision_id: 'frozen-input-id' }] }], counts: { total: 1, snapshot: 1, shared_objects: 1 }, affected_citations: 0, physical_cleanup: 'pending_separate_review' } }; }
    test("policy changes are finite and respect zero, workspace and installation ceilings", () => {
        {
            assert.deepEqual(readPolicyPatch(form({ canonical_event_retention_days: '1', max_automatic_model_calls: '0' }), record), { max_automatic_model_calls: 0, canonical_event_retention_days: 1 });
            for (const changed of [{ canonical_event_retention_days: '0' }, { max_records_per_snapshot: '100001' }, { max_input_tokens: '1.5' }, { max_automatic_model_calls: '' }])
                assert.throws(() => readPolicyPatch(form(changed), record));
            assert.throws(() => readPolicyPatch(form(), record), /actual policy change/);
            assert.throws(() => readPolicyPatch(form({ max_automatic_model_calls: '1' }), { ...record, installation_ceilings: { max_automatic_model_calls: 0 } }), /integer from 0 to 0/);
        }
        {
            const ceilings = { ...values, max_automatic_model_calls: 24, max_input_tokens: 500000, max_output_tokens: 64000 }, current = { ...record, installation_ceilings: ceilings };
            assert.deepEqual(readPolicyPatch(form({ max_automatic_model_calls: '24', max_input_tokens: '500000', max_output_tokens: '64000' }), current), { max_automatic_model_calls: 24, max_input_tokens: 500000, max_output_tokens: 64000 });
            assert.deepEqual(readPolicyPatch(form({ max_automatic_model_calls: '0', max_input_tokens: '0', max_output_tokens: '0' }), current), { max_automatic_model_calls: 0, max_input_tokens: 0, max_output_tokens: 0 });
            assert.deepEqual(readPolicyPatch(form({ max_automatic_model_calls: '2', max_input_tokens: '10000', max_output_tokens: '2000' }), current), { max_automatic_model_calls: 2, max_input_tokens: 10000, max_output_tokens: 2000 });
            for (const patch of [{ max_automatic_model_calls: '25' }, { max_input_tokens: '500001' }, { max_output_tokens: '64001' }])
                assert.throws(() => readPolicyPatch(form(patch), current), /must be an integer/);
            assert.throws(() => readPolicyPatch(form({ max_automatic_model_calls: '5' }), record), /integer from 0 to 4/);
            assert.throws(() => readPolicyPatch(form({ max_automatic_model_calls: '24' }), { ...record, installation_ceilings: undefined }), /no recorded installation ceiling/);
        }
    });
    test("retention review binds exact impact, dependencies, revision and private review token", () => {
        {
            const patch = { canonical_event_retention_days: 1, max_automatic_model_calls: 0 }, value = preview();
            assert.throws(() => reviewedPolicyBody(patch, value, 3, false, now), /Review the exact affected/);
            assert.deepEqual(reviewedPolicyBody(patch, value, 3, true, now), { ...patch, retention_review_token: value.review_token });
            assert.throws(() => reviewedPolicyBody({ ...patch, canonical_event_retention_days: 2 }, value, 3, true, now), /exact changed fields/);
            assert.throws(() => reviewedPolicyBody(patch, value, 4, true, now), /policy revision/);
            assert.throws(() => reviewedPolicyBody(patch, value, 3, true, now + 5 * 60000), /expired/);
        }
        {
            const html = renderToStaticMarkup(<RetentionImpactView impact={preview().impact}/>);
            for (const text of ['reviewed-snapshot', 'd'.repeat(64), '2026-10-01T12:00:00.000Z', '10.000000 days', '2 shared references', 'cited-report-id', 'dependent-download-id', 'pending separate review'])
                assert.ok(html.includes(text), text);
            assert.doesNotMatch(html, /Cleanup complete|>passed</);
        }
    });
    test('shortened grace, incomplete inventory and unknown capture ages never authorize retention', () => {
        const patch = { canonical_event_retention_days: 1 };
        for (const change of [(p: RetentionPreview) => { p.effective_at = '2026-10-17T12:00:00.000Z'; }, (p: RetentionPreview) => { p.grace_days = 0; }, (p: RetentionPreview) => { p.impact.counts.total = 2; }, (p: RetentionPreview) => { p.impact.resources[0].age_days = Number.NaN; }]) {
            const p = preview();
            change(p);
            assert.throws(() => reviewedPolicyBody(patch, p, 3, true, now));
        }
    });
    test('missing versus empty model usage remains unknown versus unrecorded; real call/token counts remain separate from work units', () => {
        const common = { work_units: [], model_calls: 'Separate call accounting.', installation_expensive_jobs: 2, workspace_expensive_jobs: 1 };
        assert.match(renderToStaticMarkup(<BudgetView budgets={common}/>), /consumption remain unknown/);
        assert.match(renderToStaticMarkup(<BudgetView budgets={{ ...common, model_usage: [] }}/>), /No model usage rows have been recorded/);
        const html = renderToStaticMarkup(<BudgetView budgets={{ ...common, model_usage: [{ case_id: 'case', revision_id: 'revision', calls_reserved: 1, calls_spent: 2, input_reserved: 30, input_spent: 40, output_reserved: 5, output_spent: 6 }] }}/>);
        for (const label of ['Calls reserved', 'Calls spent', 'Input tokens reserved', 'Input tokens spent', 'Output tokens reserved', 'Output tokens spent'])
            assert.ok(html.includes(label));
    });
});
describe("Revision call allowances", () => {
    const item: Investigation = { id: 'case', workspace_id: 'workspace', title: 'Synthetic', question: 'Question', affected_flow: 'checkout', active_revision_id: 'current-input', lifecycle: 'open', archived: false, revision: 9, created_at: '2026-10-13T12:00:00Z', updated_at: '2026-10-13T12:00:00Z' };
    const allowance: ModelCallAllowance = { automatic_calls: 4, owner_granted_calls: 2, total_calls: 6, maximum_owner_granted_calls: 4, token_allowance_increased: false };
    const facts = () => ({ case_id: 'case', revision_id: 'current-input', limits: { model: { ...allowance } } });
    test("call extensions require current coherent exact-revision allowance without raising token limits", () => {
        {
            const review = pinBudgetExtension(item, facts(), 2, '  Investigate a competing explanation.  ');
            assert.equal(review.additional_calls, 2);
            assert.equal(review.case_revision, 9);
            assert.equal(review.revision_id, 'current-input');
            assert.equal(review.reason, 'Investigate a competing explanation.');
            assert.equal(review.allowance.token_allowance_increased, false);
            assert.equal(review.allowance.total_calls, 6);
            for (const calls of [0, 3, 4, 5, 1.5, NaN])
                assert.throws(() => pinBudgetExtension(item, facts(), calls, 'Reason'));
            for (const reason of ['   ', 'x'.repeat(2001)])
                assert.throws(() => pinBudgetExtension(item, facts(), 1, reason));
        }
        {
            for (const current of [{ ...item, archived: true }, { ...item, lifecycle: 'closed' }, { ...item, active_revision_id: 'changed-input' }, { ...item, revision: 0 }])
                assert.throws(() => pinBudgetExtension(current, facts(), 1, 'Reason'));
            for (const model of [{ ...allowance, total_calls: 7 }, { ...allowance, owner_granted_calls: 5 }, { ...allowance, maximum_owner_granted_calls: 5 }, { ...allowance, automatic_calls: NaN }])
                assert.throws(() => pinBudgetExtension(item, { ...facts(), limits: { model } }, 1, 'Reason'));
            assert.throws(() => pinBudgetExtension(item, { ...facts(), case_id: 'other-case' }, 1, 'Reason'));
        }
    });
    test('analyst allowances are read-only and viewer receives no grant/inventory controls', () => {
        const workspace = { id: 'workspace', name: 'Synthetic', created_at: '2026-10-13T12:00:00Z', revision: 1 };
        const analyst = renderToStaticMarkup(<BudgetExtensions workspace={{ ...workspace, role: 'analyst' }} csrf=""/>);
        assert.match(analyst, /Only an owner can add calls/);
        assert.match(analyst, /Previous changes/);
        assert.doesNotMatch(analyst, /Reason|Review extra calls/);
        const viewer = renderToStaticMarkup(<BudgetExtensions workspace={{ ...workspace, role: 'viewer' }} csrf=""/>);
        assert.match(viewer, /Owner or analyst access required/);
        assert.doesNotMatch(viewer, /Investigation|Previous changes|Add calls/);
    });
});
describe("Deletion resource binding", () => {
    test('deletion review is bound to the exact resource and accepts the server null workspace case scope', () => {
        const preview: DeletionPreview = { resource: 'workspace', scope: { workspace_id: 'workspace-1', case_id: null }, revision: 3, counts: { cases: 1 }, object_count: 0, object_bytes: 0, active_jobs: [], scope_hash: 'a'.repeat(64), review_token: 'unit-signed-token', expires_at: '2026-10-11T10:00:00.000Z', backup_notice: 'Unit scope review; no deletion executed.' };
        assert.equal(reviewedScope(preview, 'workspace-1'), 'workspace-1');
        assert.throws(() => reviewedScope(preview, 'workspace-2'), /exact deletion scope/);
        assert.throws(() => reviewedScope(preview, 'workspace-1', 'case-1'), /exact deletion scope/);
        assert.throws(() => reviewedScope({ ...preview, review_token: '' }, 'workspace-1'), /exact deletion scope/);
        const casePreview: DeletionPreview = { ...preview, resource: 'case', scope: { workspace_id: 'workspace-1', case_id: 'case-1' } };
        assert.equal(reviewedScope(casePreview, 'workspace-1', 'case-1'), 'case-1');
        assert.throws(() => reviewedScope(casePreview, 'workspace-1', 'case-2'), /exact deletion scope/);
    });
});
