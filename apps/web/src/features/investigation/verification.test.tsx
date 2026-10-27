import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { privateArtifactUrl } from './artifact-url';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, casePath, type Investigation, type Workspace } from '../../api';
import { readReportDownload, ReportFinding } from './ReportsPanel';
import { readPreparedReport } from '../providers/DiagnosisModelDraft';
import { type Evidence, type AnalysisContext, type FollowUp } from './types';
import { ExternalApprovalRevocation, ExternalPlanReview, ExternalResultInspection, ExternalRunButton, ExternalRunHistory, ExternalVerificationPanel, defaultExternalActions, externalPlanInput, externalResultDetail, externalRunInput, localDateTimeInputToIso, localDateTimeInputValue, parseExternalActions, revokeExternalApproval } from './ExternalVerificationPanel';
import { FollowUpsPanel, FollowUpResultView, followUpDefaults } from './FollowUpsPanel';
describe("Private artifact scope", () => {
    test('artifact links remain same-origin and scoped to the current authenticated case', () => {
        const base = '/api/v1/workspaces/unit/cases/unit', origin = 'http://localhost:3210';
        assert.equal(privateArtifactUrl(base, `${base}/verification-artifacts/unit`, origin), `${base}/verification-artifacts/unit`);
        for (const value of ['https://external.invalid/private.png', '//external.invalid/private.png', 'javascript:alert(1)', 'http://user:password@localhost:3210/api/v1/workspaces/unit/cases/unit/artifact', '/api/v1/workspaces/other/cases/private/artifact'])
            assert.equal(privateArtifactUrl(base, value, origin), null);
    });
});
describe("Report truth and downloads", () => {
    const id = '05caa198-42db-44c6-abeb-df58ec2bb42e';
    const headers = { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="investigation-${id}.zip"` };
    test('created draft review reads authoritative freshness and revision from the exact report GET', async () => {
        const original = globalThis.fetch, calls: {
            path: string;
            options?: RequestInit;
        }[] = [];
        const created = { id, revision: 1 }; // The creation receipt has no freshness projection.
        globalThis.fetch = async (path, options) => { calls.push({ path: String(path), options }); return Response.json({ data: { ...created, revision: 2, freshness: 'fresh' } }); };
        try {
            const record = await readPreparedReport('/api/v1/workspaces/w/cases/c', created.id);
            assert.equal(record.freshness, 'fresh');
            assert.equal(record.revision, 2);
            assert.equal(calls.length, 1);
            assert.equal(calls[0]?.path, `/api/v1/workspaces/w/cases/c/reports/${id}`);
            assert.equal(calls[0]?.options?.method ?? 'GET', 'GET');
            assert.equal(calls[0]?.options?.body, undefined);
            globalThis.fetch = async () => Response.json({ data: { ...created, id: 'another-report', freshness: 'fresh' } });
            await assert.rejects(readPreparedReport('/api/v1/workspaces/w/cases/c', id), /exact created draft/);
            globalThis.fetch = async () => Response.json({ data: { ...created, freshness: 'stale' } });
            assert.equal((await readPreparedReport('/api/v1/workspaces/w/cases/c', id)).freshness, 'stale', 'A stale read is preserved for the sentence-review gate rather than promoted to fresh.');
            globalThis.fetch = async () => Response.json({ error: { code: 'FORBIDDEN', message: 'Current report access unavailable.' } }, { status: 403 });
            await assert.rejects(readPreparedReport('/api/v1/workspaces/w/cases/c', id), error => error instanceof ApiError && error.code === 'FORBIDDEN');
            await assert.rejects(readPreparedReport('/api/v1/workspaces/w/cases/c', '../other'), /valid report identity/);
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test("report downloads preserve exact artifacts and reject absent, truncated, mismatched or inaccessible bytes", async () => {
        {
            // A response-validation unit fixture, not evidence of browser download or ZIP verification.
            const bytes = new Uint8Array([80, 75, 3, 4, 10]);
            const result = await readReportDownload(new Response(bytes, { headers: { ...headers, 'content-length': '5' } }), id, 'zip');
            assert.equal(result.filename, `investigation-${id}.zip`);
            assert.equal(result.blob.type, 'application/zip');
            assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
        }
        {
            await assert.rejects(readReportDownload(new Response(null, { status: 204 }), id, 'zip'), error => error instanceof ApiError && error.code === 'ARTIFACT_BYTES_UNAVAILABLE' && /No download was requested/.test(error.message));
            for (const response of [new Response(null, { headers }), new Response('x', { headers: { ...headers, 'content-length': '5' } })])
                await assert.rejects(readReportDownload(response, id, 'zip'), /empty or incomplete/);
        }
        {
            await assert.rejects(readReportDownload(new Response('x', { headers: { ...headers, 'content-type': 'text/plain' } }), id, 'zip'), /expected report filename and media type/);
            await assert.rejects(readReportDownload(new Response('x', { headers }), 'another-export', 'zip'), /expected report filename and media type/);
            await assert.rejects(readReportDownload(new Response('x', { headers }), id, 'json'), /expected report filename and media type/);
            await assert.rejects(readReportDownload(new Response(JSON.stringify({ error: { code: 'REPORT_INPUTS_STALE', message: 'Report inputs changed.' }, meta: { request_id: 'safe-request-id' } }), { status: 409, headers: { 'content-type': 'application/json' } }), id, 'zip'), error => error instanceof ApiError && error.status === 409 && error.code === 'REPORT_INPUTS_STALE' && error.requestId === 'safe-request-id');
        }
    });
    test('report findings keep exact check citations and make failed, stale or unavailable outcomes explicit', () => {
        const finding = { text: 'A failed check does not confirm the suspected cause.', evidence_ids: [], test_result_ids: ['failed-check', 'not-loaded'] };
        const result = { id: 'failed-check', value: { kind: 'data_quality' as const, outcome: 'failed' as const, freshness: 'stale' as const, reasons: [], limitations: [], details: {}, revision_id: 'revision' } };
        const html = renderToStaticMarkup(<ReportFinding finding={finding} evidence={[]} analyticResult={result}/>);
        assert.match(html, /failed-check/);
        assert.match(html, />failed<\/span>/);
        assert.match(html, />stale<\/span>/);
        assert.match(html, /not-loaded/);
        assert.match(html, /Outcome not loaded/);
        assert.doesNotMatch(html, />passed<|>PASS</);
        assert.deepEqual(finding.test_result_ids, ['failed-check', 'not-loaded']);
    });
});
describe("External verification approval", () => {
    const owner: Workspace = { id: 'workspace', name: 'Private unit scope', role: 'owner', revision: 1, created_at: '2026-10-17T00:00:00.000Z' };
    const investigation: Investigation = { id: 'case', workspace_id: owner.id, title: 'External regression', question: 'What changed?', affected_flow: 'checkout', active_revision_id: 'revision', lifecycle: 'open', archived: false, revision: 3, created_at: owner.created_at, updated_at: owner.created_at };
    const evidence: Evidence = { id: 'evidence-one', workspace_id: owner.id, case_id: investigation.id, revision_id: investigation.active_revision_id, snapshot_id: null, source_kind: 'human_note', source_ref: 'unit', content_hash: 'a'.repeat(64), captured_at: owner.created_at, event_time: { kind: 'unknown', raw_description: 'not supplied' }, text: 'Observed checkout failure', redaction_status: 'sanitized', evidence_status: 'user_attested', supersedes_id: null };
    test('finite action parser accepts the declared DSL and rejects executable, cross-origin and unbounded inputs', () => {
        assert.deepEqual(parseExternalActions(JSON.stringify(defaultExternalActions)), defaultExternalActions);
        assert.deepEqual(parseExternalActions(JSON.stringify([{ op: 'navigate', path: '/checkout' }, { op: 'fill', locator: { kind: 'label', value: 'Email' }, value_ref: 'synthetic_email' }, { op: 'wait_for', locator: { kind: 'role', role: 'button', value: 'Pay' }, timeout_ms: 5000 }])), [{ op: 'navigate', path: '/checkout' }, { op: 'fill', locator: { kind: 'label', value: 'Email' }, value_ref: 'synthetic_email' }, { op: 'wait_for', locator: { kind: 'role', role: 'button', value: 'Pay' }, timeout_ms: 5000 }]);
        for (const invalid of [[{ op: 'click', locator: { kind: 'test_id', value: 'pay' } }], [{ op: 'navigate', path: 'https://outside.example' }], [{ op: 'navigate', path: '/' }, { op: 'evaluate', script: 'steal()' }], Array.from({ length: 31 }, (_, index) => ({ op: 'navigate', path: `/${index}` })), [{ op: 'navigate', path: '/' }, { op: 'fill', locator: { kind: 'label', value: 'Email' }, value_ref: '__proto__' }]])
            assert.throws(() => parseExternalActions(JSON.stringify(invalid)));
    });
    test('plan input is finite, citation-scoped and requires a candidate for correction', () => {
        const form = new FormData();
        for (const [name, value] of Object.entries({ hypothesis_id: 'hypothesis-one', objective: 'mechanism', runner_id: 'runner-one', environment_id: 'environment-one', fixture_profile_id: 'fixture-one', observation_profile_id: 'observation-one', grant_id: 'grant-one', known_good_build_id: 'build-good', incident_build_id: 'build-incident', actions: JSON.stringify(defaultExternalActions) }))
            form.set(name, value);
        form.append('external_evidence', evidence.id);
        const input = externalPlanInput(form, [evidence]);
        assert.equal(input.objective, 'mechanism');
        assert.deepEqual(input.evidence_ids, [evidence.id]);
        assert.equal(input.build_ids.candidate, undefined);
        form.set('objective', 'correction');
        assert.throws(() => externalPlanInput(form, [evidence]), /candidate/);
        form.set('candidate_build_id', 'build-candidate');
        assert.equal(externalPlanInput(form, [evidence]).build_ids.candidate, 'build-candidate');
        form.set('external_evidence', 'restricted');
        assert.throws(() => externalPlanInput(form, [{ ...evidence, id: 'restricted', redaction_status: 'restricted' }]), /sanitized/);
    });
    test('datetime-local preserves the intended instant in a UTC+1 browser zone', () => {
        const previous = process.env.TZ;
        try {
            process.env.TZ = 'Etc/GMT-1';
            const instant = new Date('2030-01-02T09:04:05.000Z');
            assert.equal(localDateTimeInputValue(instant), '2030-01-02T10:04:05');
            assert.equal(localDateTimeInputToIso('2030-01-02T10:04:05'), instant.toISOString());
            assert.throws(() => localDateTimeInputToIso('2030-02-30T10:04:05'), /valid local date/);
        }
        finally {
            if (previous === undefined)
                delete process.env.TZ;
            else
                process.env.TZ = previous;
        }
    });
    test('external approval revocation sends the exact bounded review and renders its acknowledgment', async () => {
        const plan = { id: 'plan:one', plan_hash: 'b'.repeat(64), oracle_hash: 'c'.repeat(64), revision_id: investigation.active_revision_id };
        const approval = { id: 'approval-one', plan_id: plan.id, plan_hash: plan.plan_hash, grant_id: 'grant-one', expires_at: '2099-01-02T09:04:05.000Z', revision: 7, revoked: false };
        let observed: {
            path: string;
            body: unknown;
            method?: string;
            revision?: number;
        } | undefined;
        const send = async <T,>(path: string, body: unknown, method?: string, revision?: number) => { observed = { path, body, method, revision }; return { id: approval.id, value: { revoked: true } } as T; };
        await revokeExternalApproval(send, '/api/v1/workspaces/w/cases/c', plan, approval, '  Synthetic run no longer authorized.  ');
        assert.deepEqual(observed, { path: '/api/v1/workspaces/w/cases/c/browser-plans/plan%3Aone/approval-revocations', body: { approval_id: approval.id, reason: 'Synthetic run no longer authorized.' }, method: 'POST', revision: 7 });
        const markup = renderToStaticMarkup(<ExternalApprovalRevocation approval={approval} current reviewing reason="Synthetic run no longer authorized." acknowledged={false} pending="" onBegin={() => { }} onCancel={() => { }} onReason={() => { }} onAcknowledged={() => { }} onSubmit={() => { }}/>);
        assert.match(markup, /Revoke approval/);
        assert.match(markup, /Reason/);
        assert.match(markup, /maxLength="2000"/i);
        assert.match(markup, /intend to withdraw its authority/);
        assert.match(markup, /Revoke approval/);
        assert.throws(() => externalRunInput(plan, { ...approval, revoked: true }), /does not bind/);
        assert.throws(() => externalRunInput(plan, { ...approval, expires_at: '2020-01-01T00:00:00.000Z' }), /expired/);
    });
    test("recorded or exploratory results preserve every safe attempt outcome without a passing claim", () => {
        {
            const markup = renderToStaticMarkup(<ExternalRunHistory base="/api/v1/workspaces/w/cases/c" runs={[{ id: 'run-one', plan_id: 'plan-one', approval_id: 'approval-one', job_id: 'job-one', status: 'completed' }]} results={[{ id: 'result-one', run_id: 'run-one', plan_id: 'plan-one', status: 'completed', outcome: 'passed', mode: 'exploratory', verification_limit_reason: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED' }]}/>);
            assert.match(markup, /Exploratory evidence only/);
            assert.match(markup, /INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED/);
            assert.match(markup, /does not prove the cause/);
            assert.doesNotMatch(markup, /status good/);
            assert.match(markup, /View results/);
            assert.match(markup, /aria-expanded="false"/);
        }
        {
            const digest = 'a'.repeat(64), observedAt = '2026-10-17T12:00:00.000Z';
            const observations = Array.from({ length: 12 }, (_, index) => ({
                arm: index < 6 ? 'known_good' : 'incident', cohort: index % 6 < 3 ? 'mobile' : 'desktop', repeat: index % 3 + 1, status: index === 7 ? 'blocked' : 'observed',
                plan_hash: digest, oracle_hash: digest, build_digest: digest, build_digest_after: digest, deployment_evidence_hash: digest, fixture_hash: digest, environment_hash: digest, runner_id: 'runner-one',
                actual: index === 7 ? null : { checkout_completed: index < 6, order_created_count: index < 6 ? 1 : 0, error_code: index < 6 ? null : 'PAY_BUTTON_HANDLER_MISSING' },
            }));
            const attempts = observations.map((item, index) => ({ attempt_id: `attempt-${String(index + 1).padStart(8, '0')}`, arm: item.arm, cohort: item.cohort, repeat: item.repeat, status: item.status, started_at: observedAt, finished_at: '2026-10-17T12:00:01.000Z', observation_hash: digest, ui_completed: item.actual?.checkout_completed ?? null, receipt_completed: item.actual?.checkout_completed ?? null, network_request_count: 4, denied_requests: index === 7 ? [{ code: 'PATH_DENIED', origin: null, path: null }] : [], errors: index === 7 ? ['NETWORK_SCOPE_VIOLATION'] : [], deployment: { arm: item.arm, deployment_id: `deployment-${item.arm}`, attester_id: 'attester-one', origin: `https://${item.arm}.example.test`, build_digest: digest, deployment_evidence_hash: digest } }));
            const detail = externalResultDetail({ id: 'result-one', run_id: 'run-one', plan_id: 'plan-one', outcome: 'inconclusive', mode: 'exploratory', freshness: 'fresh', verification_limit_reason: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', production_claim_eligible: false, observed_runs: 12, result_hash: digest, created_at: observedAt, observations, attempts, artifacts: [] }, 'result-one');
            const markup = renderToStaticMarkup(<ExternalResultInspection result={detail}/>);
            assert.match(markup, /Test results/);
            assert.match(markup, /Run details/);
            assert.match(markup, /attempt-00000012/);
            assert.match(markup, /PATH_DENIED/);
            assert.match(markup, /PATH_DENIED/);
            assert.match(markup, /NETWORK_SCOPE_VIOLATION/);
            assert.match(markup, /Exploratory only/);
            assert.match(markup, /Aggregate|exploratory/i);
            assert.doesNotMatch(markup, /status good/);
            assert.throws(() => externalResultDetail({ ...detail, production_claim_eligible: true }, detail.id), /incomplete/);
            assert.throws(() => externalResultDetail({ ...detail, artifacts: [{ id: 'unexpected' }] }, detail.id), /incomplete or unbounded/);
            assert.throws(() => externalResultDetail({ ...detail, attempts: detail.attempts.map((item, index) => index === 0 ? { ...item, denied_requests: [{ code: 'PATH_DENIED', origin: 'https://secret.example', path: '/secret' }] } : item) }, detail.id), /denied-request/);
        }
    });
    test('configured immutable records render exact hashes while an unavailable runner disables run', () => {
        const hash = 'b'.repeat(64), plan = { id: 'plan-one', plan_hash: hash, oracle_hash: 'c'.repeat(64), revision_id: investigation.active_revision_id, objective: 'mechanism' as const, runner_id: 'runner-one' };
        const review = renderToStaticMarkup(<ExternalPlanReview plan={plan}/>);
        assert.match(review, /Plan details/);
        assert.match(review, new RegExp(hash));
        assert.match(review, /runner-one/);
        let called = false;
        const blocked = renderToStaticMarkup(<ExternalRunButton disabled pending="" onRun={() => { called = true; }}/>);
        assert.match(blocked, /disabled=""/);
        assert.match(blocked, /Run approved browser test/);
        assert.equal(called, false);
    });
    test('viewer surface is read-only and unknown initial state does not expose mutation controls', () => {
        const markup = renderToStaticMarkup(<ExternalVerificationPanel base={casePath(owner.id, investigation.id)} workspace={{ ...owner, role: 'viewer' }} csrf="csrf" investigation={investigation} hypotheses={[]} evidence={[]} refreshToken={0} onChanged={async () => { }}/>);
        assert.match(markup, /Read only/);
        assert.match(markup, /cannot create, approve, or run/);
        assert.doesNotMatch(markup, /Save test plan|Approve this plan|Run approved browser test/);
    });
});
describe("Manual follow-up", () => {
    test('a persisted waiting-for-data receipt without metric values remains visible and cannot crash or invent counts', () => {
        for (const result of [null, { mode: 'observational' as const, causal_effect: 'not_established' as const, reason: 'new_snapshot_required', missing_data_notified_at: null }]) {
            const html = renderToStaticMarkup(<FollowUpResultView state="waiting_for_data" result={result}/>);
            assert.match(html, /Follow-up comparison unavailable/);
            assert.match(html, /Waiting for fresh data/);
            assert.match(html, /remain unknown/);
            assert.doesNotMatch(html, /Actual observed comparison|<table|>passed<|0 \/ 0/);
            if (result)
                assert.match(html, /new snapshot required/);
        }
    });
    test('an incomplete comparison keeps null metric values unknown and retains its recorded diagnostic quality', () => {
        const html = renderToStaticMarkup(<FollowUpResultView state="waiting_for_data" result={{ mode: 'observational', causal_effect: 'not_established', reason: 'coverage_tail_missing', value: { metric_hash: 'a'.repeat(64), quality: 'incomplete', basis: 'none', baseline: null, comparison: null, delta_pp: null, relative_change: null } }}/>);
        assert.match(html, /Incomplete follow-up diagnostic comparison/);
        assert.match(html, /coverage tail missing/);
        assert.match(html, /Unknown/);
        assert.match(html, /not established/);
        assert.doesNotMatch(html, /0 \/ 0|>passed</);
    });
    test("follow-up review preserves frozen observation duration and requires explicit consent", () => {
        {
            const context = { metric: { windows: { comparison: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' } } } } as AnalysisContext;
            assert.deepEqual(followUpDefaults(context), { start: '2026-10-08T00:00:00', end: '2026-10-15T00:00:00', note: 'Compare the next observation window using the same frozen metric and source. Treat any change as observational.' });
            for (const end of ['bad-date', '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z'])
                assert.deepEqual(followUpDefaults({ ...context, metric: { ...context.metric, windows: { ...context.metric.windows, comparison: { ...context.metric.windows.comparison, end } } } }), { start: '', end: '', note: '' });
        }
        {
            const context = { binding: { revision_id: 'revision-one', metric_hash: 'metric-one' }, metric: { source_id: 'source-one', windows: { comparison: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' } } } } as AnalysisContext;
            const investigation = { revision: 2, active_revision_id: 'revision-one' } as Investigation;
            const saved = { id: 'followup-one', revision_id: 'revision-one', revision: 1, freshness: 'fresh', state: 'scheduled', result: null, value: { source_ids: ['source-one'], note: 'Observe checkout', comparison_start: '2026-10-08T00:00:00Z', comparison_end: '2026-10-15T00:00:00Z', trigger_mode: 'manual', original_snapshot_id: 'original', metric_hash: 'metric-one' } } as unknown as FollowUp;
            const render = (followups: FollowUp[], canMutate = true) => renderToStaticMarkup(<FollowUpsPanel base="/case" csrf="token" investigation={investigation} context={context} followups={followups} snapshots={[]} evidence={[]} canMutate={canMutate} onChanged={async () => { }}/>);
            const empty = render([]), existing = render([saved]);
            assert.match(empty, /<details class="panel" open=""><summary>Create follow-up<\/summary>/);
            assert.match(existing, /<details class="panel"><summary>Create follow-up<\/summary>/);
            for (const html of [empty, existing]) {
                assert.match(html, /<input(?=[^>]*name="start")(?=[^>]*required="")[^>]*>/);
                assert.match(html, /<input(?=[^>]*name="end")(?=[^>]*required="")[^>]*>/);
                assert.match(html, /type="checkbox" required=""/);
                assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
                assert.match(html, /<option value="manual" selected="">/);
            }
            assert.doesNotMatch(render([saved], false), /<summary>Create follow-up|type="checkbox"|>Run follow-up<|>Cancel follow-up</);
        }
    });
});
