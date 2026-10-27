import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseZetarisApprovedViews, zetarisSourceConfigFromForm } from './Sources';
import { coverageFromForm, postHogMappingFromForm } from './CaptureForms';
import { eventNames } from './ExportDeclarations';
import { sourceReady, type Source, type ModelProposal } from './types';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplacementActivationReview, replacementCanActivate, type Replacement } from './CredentialReplacement';
import { ModelProfileRemovalReview } from './ModelProfiles';
import { ApiError, resource } from '../../api';
import { commandKey, type CommandIdentity } from '../../command-key';
import { type AnalysisContext, type Evidence, type ReportRecord } from '../investigation/types';
import { DiagnosisSentences } from './DiagnosisModelDraft';
import { diagnosisDraftIssue, reviewedDiagnosisCommand } from './diagnosis-review';
import { proposalReadinessKey, proposalRequestState, readProposalRequestReadiness, type ProposalReadinessBinding, type ProposalRequestReadiness } from './request-readiness';
describe("Read-only source declarations", () => {
    const views = [
        { id: 'sessions_public', role: 'sessions', identifier: 'faultline.sessions_public', columns: { record_id: 'record_id', occurred_at: 'occurred_at', release_id: 'release_id', session_id: 'session_id', cohort: 'cohort', case_key: 'case_key', flow_key: 'flow_key', conversion_status: 'conversion_status' } },
        { id: 'releases_public', role: 'releases', identifier: 'faultline.releases_public', columns: { record_id: 'record_id', release_id: 'release_id', case_key: 'case_key' } },
    ];
    function form(overrides: Record<string, string> = {}) {
        const value = new FormData(), fields = { adapter_id: 'reviewed_contract_v1', approved_origin: 'https://zetaris.example.test', contract_hash: 'a'.repeat(64), approved_account_scope: 'faultline_reader', approved_views: JSON.stringify(views), ...overrides };
        for (const [name, item] of Object.entries(fields))
            value.set(name, item);
        return value;
    }
    test('Zetaris connection emits the exact versioned contract and derived approved view IDs', () => {
        const config = zetarisSourceConfigFromForm(form());
        assert.deepEqual(config, { kind: 'zetaris_federated_evidence', schema_version: 1, protocol: 'faultline-zetaris-v1', adapter_id: 'reviewed_contract_v1', approved_origin: 'https://zetaris.example.test', contract_hash: 'a'.repeat(64), approved_account_scope: 'faultline_reader', approved_views: views, approved_view_ids: ['sessions_public', 'releases_public'] });
        assert.equal(Object.hasOwn(config, 'endpoint'), false);
        assert.equal(Object.hasOwn(config, 'workspace_id'), false);
        assert.equal(Object.hasOwn(config, 'source_id'), false);
    });
    test("source declarations reject unsupported views, unsafe scopes and changed contract digests", () => {
        {
            assert.throws(() => parseZetarisApprovedViews('{'), /valid JSON/);
            assert.throws(() => parseZetarisApprovedViews(JSON.stringify([{ ...views[0], sql: 'select *' }])), /unsupported fields/);
            assert.throws(() => parseZetarisApprovedViews(JSON.stringify([views[0], { ...views[0], id: 'other_sessions' }])), /unique sessions/);
            assert.throws(() => parseZetarisApprovedViews(JSON.stringify([{ ...views[0], identifier: 'sessions; DROP VIEW' }])), /finite provider relation identifier/);
            assert.throws(() => parseZetarisApprovedViews(JSON.stringify(Array.from({ length: 33 }, (_, index) => ({ ...views[0], id: `view_${index}`, role: index % 2 ? 'support' : 'sessions' })))), /1–32/);
        }
        {
            assert.throws(() => zetarisSourceConfigFromForm(form({ approved_origin: 'http://zetaris.example.test' })), /exact HTTPS origin/);
            assert.throws(() => zetarisSourceConfigFromForm(form({ approved_origin: 'https://zetaris.example.test/path' })), /exact HTTPS origin/);
            assert.throws(() => zetarisSourceConfigFromForm(form({ contract_hash: 'A'.repeat(64) })), /64 lowercase/);
            assert.throws(() => zetarisSourceConfigFromForm(form({ adapter_id: '../adapter' })), /installed adapter ID/);
        }
    });
});
describe("Capture provenance", () => {
    test("capture mapping pins event identities and keeps coverage and capability readiness independent of credentials", () => {
        {
            const form = new FormData();
            form.set('device_property', '$device_type');
            form.append('device_source', 'Mobile');
            form.append('device_cohort', 'mobile');
            form.set('exclusion_default', 'reviewed');
            assert.deepEqual(postHogMappingFromForm(form), { kind: 'analytics', event_id_path: 'uuid', session_id_path: 'properties.$session_id', event_time_path: 'timestamp', event_name_path: 'event', device_path: 'properties.$device_type', device_map: [{ source_value: 'Mobile', cohort: 'mobile' }], precision_policy: 'lossless_utc_microseconds' });
            form.delete('exclusion_default');
            assert.throws(() => postHogMappingFromForm(form), /excluded=false/);
            form.set('exclusion_default', 'reviewed');
            for (const value of ['__proto__', 'nested.device']) {
                form.set('device_property', value);
                assert.throws(() => postHogMappingFromForm(form), /safe exact/);
            }
            form.set('device_property', '$device_type');
            form.append('device_source', 'Mobile');
            form.append('device_cohort', 'desktop');
            assert.throws(() => postHogMappingFromForm(form), /unique/);
        }
        {
            const form = new FormData();
            form.set('basis', 'none');
            form.set('statement', 'No upstream completeness evidence is available.');
            assert.deepEqual(coverageFromForm(form), { basis: 'none', event_time_intervals: [], declared_event_watermark: null, statement: 'No upstream completeness evidence is available.', reference_evidence_ids: [], late_arrival_hours: 0 });
            form.set('basis', 'lateness_assumption');
            form.set('coverage_start', '2026-10-01T00:00');
            form.set('coverage_end', '2026-10-02T00:30');
            form.set('watermark', '2026-10-02T00:30');
            form.set('late_arrival_hours', '2');
            assert.equal(coverageFromForm(form).basis, 'lateness_assumption');
            assert.equal(coverageFromForm(form).late_arrival_hours, 2);
            form.set('coverage_end', '2026-09-30T00:30');
            assert.throws(() => coverageFromForm(form), /increasing/);
        }
        {
            assert.deepEqual(eventNames(' checkout_started \ncheckout_completed'), [' checkout_started ', 'checkout_completed']);
            assert.throws(() => eventNames('entry\nentry'), /unique/);
            const source = { kind: 'posthog_existing_file_export', config: { kind: 'posthog_existing_file_export', app_host: 'https://us.posthog.com', project_id: '1' }, disconnected: false, credential: { revoked: false }, status: 'unconfigured', capabilities: null } as Source;
            assert.equal(sourceReady(source), false);
            const current = { ...source, status: 'available', capabilities: { status: 'available' } } as Source;
            assert.equal(sourceReady(current), true);
            assert.equal(sourceReady({ ...current, disconnected: true }), false);
            assert.equal(sourceReady({ ...current, credential: null }), false);
            assert.equal(sourceReady({ ...current, credential: { ...current.credential!, revoked: true } }), false);
        }
    });
});
describe("Credential activation", () => {
    const credential = { secret_id: 'secret-id', active_version: 1, revision: 3, hint: 'masked', revoked: false }, clock = Date.parse('2026-10-14T12:00:00.000Z');
    const replacement: Replacement = { id: 'replacement-id', secret_id: 'secret-id', version: 2, base_secret_revision: 3, revision: 3, status: 'probed', resource_kind: 'source', resource_id: 'source-id', resource_revision: 4, resource_binding: { config: { repo: '<script>untrusted</script>' }, declaration: { id: 'declaration-id', hash: 'b'.repeat(64) } }, resource_binding_hash: 'a'.repeat(64), probe_binding_hash: 'c'.repeat(64), probe_expires_at: '2026-10-14T12:10:00.000Z', capabilities: { status: 'available' }, active_version: 1, secret_revision: 3, revoked: false };
    test("activation requires the exact live probe and immutable candidate review without revealing secrets", () => {
        {
            assert.equal(replacementCanActivate(replacement, credential, clock), true);
            for (const change of [{ status: 'staged' as const }, { status: 'failed' as const }, { capabilities: { status: 'unauthorized' } }, { probe_binding_hash: null }, { probe_expires_at: '2026-10-14T11:59:00.000Z' }, { secret_revision: 4 }, { revoked: true }])
                assert.equal(replacementCanActivate({ ...replacement, ...change }, credential, clock), false);
            for (const change of [{ revision: undefined }, { revision: 4 }, { revoked: true }, { secret_id: 'different-secret' }])
                assert.equal(replacementCanActivate(replacement, { ...credential, ...change }, clock), false);
        }
        {
            const html = renderToStaticMarkup(<ReplacementActivationReview replacement={replacement}/>);
            for (const text of ['candidate version 2', 'source-id', 'replacement-id', 'resource revision 4', 'declaration-id', 'successful probe binding', 'previous version', 'evidence is retained'])
                assert.ok(html.toLowerCase().includes(text.toLowerCase()), text);
            assert.ok(html.includes('c'.repeat(64)));
            assert.ok(html.includes('&lt;script&gt;'));
            assert.doesNotMatch(html, /<script>|type="password"|name="value"/);
        }
    });
});
describe("Model profile removal", () => {
    test('profile removal review binds exact identity/revision and warns about dependency and separate credential scope', () => {
        const html = renderToStaticMarkup(<ModelProfileRemovalReview profile={{ id: 'profile-id', name: '<script>proposal</script>', provider: 'ollama', base_url: 'http://localhost:11434', model_name: 'supplied-model', revision: 7, profile_hash: 'a'.repeat(64), credential: { secret_id: 'secret-id', active_version: 2, hint: 'masked-only', revoked: false }, capabilities: null, status: 'unknown' }}/>);
        for (const value of ['profile-id', 'Resource revision', '>7<', 'http://localhost:11434', 'supplied-model', 'cancellation requests', 'separately stored credential'])
            assert.ok(html.includes(value), value);
        assert.ok(html.includes('&lt;script&gt;'));
        assert.doesNotMatch(html, /<script>|secret-id/);
    });
});
describe("Human model draft review", () => {
    const digest = 'a'.repeat(64), revisionId = 'unit-frozen-revision';
    const context: AnalysisContext = { binding: { workspace_id: 'unit-workspace', case_id: 'unit-case', revision_id: revisionId, metric_hash: digest, snapshot_hash: digest }, metric: { version: 1, template: 'session_conversion_v1', source_id: 'unit-source', unit: 'session', entry_event: 'entry', success_event: 'success', horizon_seconds: 1800, segment_property: 'device', cohorts: ['mobile'], windows: { baseline: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' }, comparison: { start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' } }, exclusion_rule: 'entry_excluded_false', timezone: 'UTC' }, comparison: null, capabilities: { model: 'unknown', external_runner: 'disabled' } };
    const evidence: Evidence[] = [{ id: 'unit-evidence', workspace_id: 'unit-workspace', case_id: 'unit-case', revision_id: revisionId, snapshot_id: null, source_kind: 'note', source_ref: 'unit-ui-only', content_hash: digest, captured_at: '2026-10-11T00:00:00.000Z', event_time: { kind: 'unknown', raw_description: 'Unit UI fixture' }, text: 'Independent unit rendering fixture.', redaction_status: 'sanitized', evidence_status: 'active', supersedes_id: null }];
    const proposal: ModelProposal = { id: '11111111-1111-4111-8111-111111111111', profile_id: 'unit-profile', profile_hash: digest, input_hash: digest, evidence_hashes: { 'unit-evidence': digest }, revision_id: revisionId, freshness: 'fresh', draft_only: true, created_at: '2026-10-11T00:00:00.000Z', value: { schema_version: 1, kind: 'diagnosis_draft', revision_id: revisionId, input_hash: digest, hypotheses: [], draft_sentences: [{ qualification: 'observed', text: '<img src=x onerror=alert(1)> Model statement requires review.', evidence_ids: ['unit-evidence'] }, { qualification: 'limitation', text: 'Aggregate causal effect is not established.', evidence_ids: [] }, { qualification: 'next_step', text: 'Review an independent negative control.', evidence_ids: [] }], questions: [], limitations: [] } };
    const record: ReportRecord = { id: 'unit-report', revision: 7, freshness: 'fresh', value: { id: 'unit-report', revision_id: revisionId, status: 'draft', title: 'Unit report draft', created_at: proposal.created_at, metric_hash: digest, snapshot_hash: digest, claim: { association: 'observed', mechanism: 'not_tested', correction: 'not_tested', freshness: 'fresh', coverage_quality: 'provisional', scope: 'association_only', warning: null, attribution: { scope: 'association_only', causal_effect: 'not_established' } }, findings: [], alternatives: [], limitations: ['No aggregate causal claim.'], recommended_actions: [], input_manifest_hash: digest } };
    test('review sends exact sentence indexes and captured draft revision without model verdict fields, retaining identity after a lost reply', async () => {
        const command = reviewedDiagnosisCommand(proposal, record, context, evidence, [0, 1, 2]);
        assert.deepEqual(command, { body: { model_proposal_id: proposal.id, proposal_sentence_indexes: [0, 1, 2] }, revision: 7 });
        const original = globalThis.fetch, identity: {
            current: CommandIdentity;
        } = { current: null }, observed: RequestInit[] = [];
        let loseReply = true;
        globalThis.fetch = async (_path, init) => {
            observed.push(init!);
            if (loseReply) {
                loseReply = false;
                throw new TypeError('Unit transport reply unavailable.');
            }
            return Response.json({ data: { ...record, revision: 8 }, meta: { request_id: 'unit-review' } });
        };
        const path = '/api/v1/workspaces/unit-workspace/cases/unit-case/diagnoses/unit-report';
        const submit = () => resource(path, { method: 'PATCH', csrf: 'unit-token', ...command, idempotencyKey: commandKey(identity, { path, method: 'PATCH', ...command }) });
        try {
            await assert.rejects(submit(), error => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
            assert.equal(observed.length, 1, 'No automatic model request or mutation retry occurs.');
            await submit();
            const first = observed[0]!.headers as Record<string, string>, second = observed[1]!.headers as Record<string, string>;
            assert.equal(first['X-Faultline-Revision'], '7');
            assert.equal(first['X-CSRF-Token'], 'unit-token');
            assert.equal(first['Idempotency-Key'], second['Idempotency-Key']);
            assert.deepEqual(JSON.parse(observed[0]!.body as string), { model_proposal_id: proposal.id, proposal_sentence_indexes: [0, 1, 2] });
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('stale, published, unknown and unbound drafts cannot become reviewed current report text', () => {
        assert.match(diagnosisDraftIssue({ ...proposal, freshness: 'stale' }, record, context)!, /stale/);
        assert.match(diagnosisDraftIssue(proposal, { ...record, value: { ...record.value!, status: 'published' } }, context)!, /unpublished/);
        assert.match(diagnosisDraftIssue(proposal, { ...record, freshness: undefined }, context)!, /unknown/);
        assert.match(diagnosisDraftIssue(proposal, { ...record, revision: undefined }, context)!, /resource revision/);
        assert.match(diagnosisDraftIssue({ ...proposal, profile_hash: '' }, record, context)!, /profile/);
        assert.match(diagnosisDraftIssue(proposal, record, { ...context, binding: { ...context.binding, revision_id: 'new-revision' } })!, /another input revision/);
        assert.throws(() => reviewedDiagnosisCommand({ ...proposal, freshness: 'stale' }, record, context, evidence, [0]), /stale/);
    });
    test("sentence selection admits only finite accessible citations and keeps generated claims qualified", () => {
        {
            for (const indexes of [[], [0, 0], [-1], [3], [0.5]])
                assert.throws(() => reviewedDiagnosisCommand(proposal, record, context, evidence, indexes), /existing draft sentence/);
            assert.throws(() => reviewedDiagnosisCommand(proposal, record, context, [{ ...evidence[0]!, redaction_status: 'withdrawn' }], [0]), /withdrawn/);
            assert.throws(() => reviewedDiagnosisCommand({ ...proposal, value: { ...proposal.value, draft_sentences: [{ ...proposal.value.draft_sentences[0]!, evidence_ids: [] }] } }, record, context, evidence, [0]), /citation/);
            assert.deepEqual(reviewedDiagnosisCommand(proposal, record, context, [], [1, 2]).body.proposal_sentence_indexes, [1, 2]);
        }
        {
            const html = renderToStaticMarkup(<DiagnosisSentences proposal={proposal} evidence={[]} selectable/>);
            assert.match(html, /Model qualification: observed/);
            assert.match(html, /Human-reviewed model finding/);
            assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
            assert.doesNotMatch(html, /<img/);
            const firstInput = html.match(/<input[^>]*name="diagnosis_sentence"[^>]*value="0"[^>]*>/)?.[0];
            assert.ok(firstInput);
            assert.match(firstInput, /disabled=""/);
            assert.match(html, /withdrawn or unavailable/);
            assert.match(html, /Report limitation/);
            assert.match(html, /Recommended action/);
            assert.doesNotMatch(html, />passed</);
        }
    });
});
describe("Exact request readiness", () => {
    const base = '/api/v1/workspaces/readiness-workspace/cases/readiness-case';
    const binding: ProposalReadinessBinding = { base, revisionId: 'frozen-revision', profileId: 'profile-one', kind: 'diagnosis_draft', refreshKey: 'first-read' };
    const fits: ProposalRequestReadiness = { revision_id: binding.revisionId, profile_id: binding.profileId, kind: binding.kind, remaining_calls: 2, remaining_input: 5000, remaining_output: 1000, input_required: 4000, can_request: true, reason_code: null };
    const snapshot = (value = fits) => ({ key: proposalReadinessKey(binding), status: 'available' as const, value });
    test("request admission requires current complete bindings and sufficient exact request capacity", () => {
        {
            assert.equal(proposalRequestState(snapshot(), binding).canRequest, true);
            const state = proposalRequestState(snapshot({ ...fits, remaining_input: 3999, can_request: false, reason_code: 'MODEL_BUDGET_EXHAUSTED' }), binding);
            assert.equal(state.canRequest, false);
            assert.equal(state.status, 'exhausted');
            assert.match(state.message!, /Saved drafts and tool results are preserved/);
            assert.match(state.message!, /owner.*refresh/);
            // Even a contradictory optimistic response cannot enable an oversized request.
            assert.equal(proposalRequestState(snapshot({ ...fits, remaining_input: 3999 }), binding).canRequest, false);
            for (const change of [{ remaining_calls: 0 }, { remaining_output: 0 }])
                assert.equal(proposalRequestState(snapshot({ ...fits, ...change }), binding).canRequest, false);
        }
        {
            for (const change of [{ profileId: 'other-profile' }, { revisionId: 'new-revision' }, { kind: 'hypotheses' as const }, { base: '/another-case' }, { refreshKey: 'refresh' }]) {
                const state = proposalRequestState(snapshot(), { ...binding, ...change });
                assert.equal(state.canRequest, false);
                assert.equal(state.status, 'loading');
            }
            for (const state of [null, { key: proposalReadinessKey(binding), status: 'loading' as const, value: null }, { key: proposalReadinessKey(binding), status: 'unavailable' as const, value: null }])
                assert.equal(proposalRequestState(state, binding).canRequest, false);
            for (const change of [{ revision_id: 'older-revision' }, { input_required: Number.NaN }, { remaining_input: -1 }, { reason_code: 'unexpected' }, { can_request: 'true' }]) {
                const state = proposalRequestState(snapshot({ ...fits, ...change } as ProposalRequestReadiness), binding);
                assert.equal(state.canRequest, false);
                assert.equal(state.status, 'unavailable');
            }
        }
    });
    test('the exact-bound allowance check is a single read with no model request or mutation', async () => {
        const original = globalThis.fetch, requests: {
            path: string;
            method?: string;
        }[] = [];
        globalThis.fetch = async (path, options) => { requests.push({ path: String(path), method: options?.method }); return Response.json({ data: fits }); };
        try {
            assert.deepEqual(await readProposalRequestReadiness(binding), fits);
            assert.deepEqual(requests, [{ path: `${base}/model-proposal-readiness?profile_id=profile-one&kind=diagnosis_draft`, method: 'GET' }]);
            globalThis.fetch = async () => Response.json({ data: { ...fits, profile_id: 'another-profile' } });
            await assert.rejects(readProposalRequestReadiness(binding), /did not match/);
            globalThis.fetch = async () => Response.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 });
            await assert.rejects(readProposalRequestReadiness(binding), /Unavailable/);
        }
        finally {
            globalThis.fetch = original;
        }
    });
});
