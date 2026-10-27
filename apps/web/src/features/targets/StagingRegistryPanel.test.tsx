import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, casePath, type Investigation, type Workspace } from '../../api';
import { type Evidence } from '../investigation/types';
import { StagingInventories, StagingRegistryPanel, networkChoices, readStagingRegistry, reviewBuildAttestation, reviewedFixtureProfile, reviewedObservationProfile, reviewedTargetGrant, stagingReadPaths, unknownStagingRegistry, type RunnerProfile } from './StagingRegistryPanel';
describe("Staging authority", () => {
    const workspace: Workspace = { id: 'unit-workspace', name: 'Private unit scope', role: 'owner', revision: 1, created_at: '2026-10-01T00:00:00.000Z' };
    const investigation: Investigation = { id: 'unit-case', workspace_id: workspace.id, title: 'Unit investigation', question: 'Inspect bounded staging authority', affected_flow: 'checkout', active_revision_id: 'current-revision', lifecycle: 'open', archived: false, revision: 2, created_at: workspace.created_at, updated_at: workspace.created_at };
    const base = casePath(workspace.id, investigation.id), now = Date.parse('2026-10-13T00:00:00.000Z');
    const runner: RunnerProfile = { id: 'runner-one', profile_hash: 'a'.repeat(64), network_profile_id: 'network-one', allowed_origins: ['https://staging.example.org', 'https://controls.example.org'], status: 'unconfigured', reason_code: 'HARDENED_RUNNER_PROBE_REQUIRED', capabilities: null };
    const evidence: Evidence = { id: 'incident-evidence', workspace_id: workspace.id, case_id: investigation.id, revision_id: investigation.active_revision_id, snapshot_id: null, source_kind: 'human_note', source_ref: 'unit-authored', content_hash: 'b'.repeat(64), captured_at: workspace.created_at, event_time: { kind: 'unknown', raw_description: 'Not supplied' }, text: 'Independently authored incident symptom', redaction_status: 'sanitized', evidence_status: 'user_attested', supersedes_id: null };
    function form(values: Record<string, string | string[]>): FormData { const result = new FormData(); for (const [key, value] of Object.entries(values))
        for (const item of Array.isArray(value) ? value : [value])
            result.append(key, item); return result; }
    const reviewedForm = (extra: Record<string, string | string[]> = {}) => form({ reviewed: 'on', ...extra });
    const observation = () => reviewedForm({ name: 'Checkout receipt', locator_kind: 'test_id', locator_value: 'checkout-complete', receipt_path_template: '/sandbox/receipts/{attempt_id}', completed_pointer: '/completed', order_count_pointer: '/order_count', error_code_pointer: '/error_code', incident_error_code: 'HANDLER_MISSING', credential_ref: '', symptom_evidence: evidence.id });
    const signedMetadata = { schema_version: 1 as const, attester_key_id: 'existing-public-attester', body: { workspace_id: workspace.id, case_id: investigation.id, deployment_id: 'reviewed-deployment', build_digest: 'c'.repeat(64), commit_sha: 'd'.repeat(40), origin: 'https://staging.example.org', observed_at: '2026-10-13T00:00:00.000Z', expires_at: '2026-10-14T00:00:00.000Z', provenance_evidence_hash: 'e'.repeat(64) }, signature: 'A'.repeat(88) };
    test("staging reads are scoped and unknown inventory never claims execution or isolation", () => {
        {
            const owner = stagingReadPaths(base, workspace, investigation), viewer = stagingReadPaths(base, { ...workspace, role: 'viewer' }, investigation);
            assert.equal(owner.length, 6);
            assert.equal(viewer.length, 4);
            assert.ok(owner.some(row => row.path.endsWith('/target-grants')));
            assert.ok(owner.some(row => row.path.endsWith('/runner-profiles')));
            assert.ok(viewer.every(row => !row.path.endsWith('/target-grants') && !row.path.endsWith('/runner-profiles')));
            assert.ok(viewer.some(row => row.path.endsWith('/environment-profiles')));
            assert.throws(() => stagingReadPaths('https://arbitrary.example.org', workspace, investigation), /selected workspace/);
            assert.throws(() => stagingReadPaths(base, workspace, { ...investigation, workspace_id: 'another-workspace' }), /selected workspace/);
            assert.throws(() => stagingReadPaths(base, { ...workspace, role: 'unknown' as Workspace['role'] }, investigation), /access is unknown/);
            const foreign = renderToStaticMarkup(<StagingRegistryPanel base="https://arbitrary.example.org" workspace={workspace} investigation={investigation} csrf="unit-csrf" evidence={[]}/>);
            assert.match(foreign, /Staging access unavailable/);
            assert.doesNotMatch(foreign, /Save reviewed|Import reviewed|Add literal variable/);
        }
        {
            const state = unknownStagingRegistry();
            state.grants.error = new ApiError(403, 'FORBIDDEN', 'Current owner review unavailable.');
            const unavailable = renderToStaticMarkup(<StagingInventories state={state} role="owner" investigation={investigation}/>);
            assert.match(unavailable, /Recorded metadata remains unknown/);
            assert.match(unavailable, /Current owner review unavailable/);
            assert.doesNotMatch(unavailable, /No target grants are recorded|status good|>PASS</);
            state.grants = { items: [], error: null };
            state.runners = { items: [runner], error: null };
            state.environments = { items: [{ id: 'environment-one', profile_hash: 'f'.repeat(64), revoked: false, runner_id: runner.id, engine: 'chromium', engine_version: 'declared-version', viewports: { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } }, timezone: 'UTC', locale: 'en-US', feature_flags: [], execution_verification: 'not_run' }], error: null };
            const known = renderToStaticMarkup(<StagingInventories state={state} role="owner" investigation={investigation}/>);
            assert.match(known, /No approved targets are recorded in the returned inventory/);
            assert.match(known, /unconfigured/);
            assert.match(known, /HARDENED_RUNNER_PROBE_REQUIRED/);
            assert.match(known, /Unknown \/ not returned/);
            assert.match(known, /Isolation and external execution remain unverified/);
            assert.match(known, /Execution not run/);
            assert.doesNotMatch(known, /status good|>PASS</);
        }
    });
    test('grant review cannot expand operator origins, merge inconsistent authority or silently accept expired and ambiguous times', () => {
        const valid = reviewedForm({ network_profile_id: 'network-one', origin: 'https://staging.example.org', expires_at: '2026-10-14T00:00:00.000Z' });
        assert.deepEqual(reviewedTargetGrant(valid, [runner], now), { origins: ['https://staging.example.org'], expires_at: '2026-10-14T00:00:00.000Z', staging_sandbox_attestation: true, network_profile_id: 'network-one' });
        assert.deepEqual(networkChoices([runner, { ...runner, id: 'runner-two', allowed_origins: ['https://controls.example.org'] }]), [{ id: 'network-one', origins: ['https://controls.example.org'] }]);
        const negativeCases: Record<string, string | string[]>[] = [{ reviewed: '' }, { network_profile_id: 'invented-network' }, { origin: 'https://outside.example.org' }, { origin: ['https://staging.example.org', 'https://staging.example.org'] }, { expires_at: '2026-10-12T00:00:00.000Z' }, { expires_at: '2026-02-30T00:00:00.000Z' }, { expires_at: '2026-10-14T01:00:00.000+01:00' }];
        for (const changes of negativeCases) {
            const altered = reviewedForm({ network_profile_id: 'network-one', origin: 'https://staging.example.org', expires_at: '2026-10-14T00:00:00.000Z', ...changes });
            assert.throws(() => reviewedTargetGrant(altered, [runner], now));
        }
        assert.throws(() => reviewedTargetGrant(reviewedForm({ network_profile_id: 'network-one', origin: 'https://staging.example.org/path', expires_at: '2026-10-14T00:00:00.000Z' }), [{ ...runner, allowed_origins: ['https://staging.example.org/path'] }], now), /exact HTTPS/);
    });
    test('fixture bodies contain reviewed finite literals and credential references, never trust keys or secret values', () => {
        const input = [{ name: 'sandbox_cart', value: '<script>literal imported data</script>' }], saved = structuredClone(input);
        assert.deepEqual(reviewedFixtureProfile(reviewedForm({ name: 'Isolated checkout', credential_ref: '' }), input), { name: 'Isolated checkout', variables: input, credential_ref: null, sandbox_only: true });
        assert.deepEqual(input, saved);
        for (const variables of [[{ name: 'constructor', value: 'x' }], [{ name: 'cart', value: 'x' }, { name: 'cart', value: 'y' }], Array.from({ length: 21 }, (_, i) => ({ name: 'cart' + i, value: 'x' })), [{ name: 'execute()', value: 'x' }]])
            assert.throws(() => reviewedFixtureProfile(reviewedForm({ name: 'Reject' }), variables));
        assert.throws(() => reviewedFixtureProfile(reviewedForm({ name: 'Reject', credential_ref: 'Bearer not-a-secret-id' }), []), /never a credential value/);
        assert.throws(() => reviewedFixtureProfile(form({ name: 'No review' }), []), /acknowledge/);
    });
    test('observation review is finite same-origin GET with distinct safe pointers and accessible sanitized symptoms', () => {
        const body = reviewedObservationProfile(observation(), [evidence]);
        assert.deepEqual(body, { name: 'Checkout receipt', success_locator: { kind: 'test_id', value: 'checkout-complete' }, receipt_path_template: '/sandbox/receipts/{attempt_id}', credential_ref: null, completed_pointer: '/completed', order_count_pointer: '/order_count', error_code_pointer: '/error_code', incident_error_code: 'HANDLER_MISSING', symptom_evidence_ids: [evidence.id], sandbox_only: true });
        for (const [field, value] of [['locator_kind', 'css'], ['receipt_path_template', 'https://outside.example.org/{attempt_id}'], ['receipt_path_template', '/../{attempt_id}'], ['receipt_path_template', '/api/{attempt_id}/{attempt_id}'], ['receipt_path_template', '/api/{other}'], ['completed_pointer', '/__proto__/value'], ['completed_pointer', '/' + Array.from({ length: 9 }, () => 'field').join('/')], ['completed_pointer', '/~2unsupported'], ['order_count_pointer', '/completed']]) {
            const changed = observation();
            changed.set(field, value);
            assert.throws(() => reviewedObservationProfile(changed, [evidence]));
        }
        assert.throws(() => reviewedObservationProfile(observation(), [{ ...evidence, redaction_status: 'restricted' }]), /accessible sanitized/);
        const duplicated = observation();
        duplicated.append('symptom_evidence', evidence.id);
        assert.throws(() => reviewedObservationProfile(duplicated, [evidence]), /one to twenty/);
        const byRole = observation();
        byRole.set('locator_kind', 'role');
        byRole.set('locator_role', 'button');
        assert.deepEqual(reviewedObservationProfile(byRole, [evidence]).success_locator, { kind: 'role', value: 'checkout-complete', role: 'button' });
        byRole.set('locator_role', 'arbitrary_role');
        assert.throws(() => reviewedObservationProfile(byRole, [evidence]), /finite accessible role/);
    });
    test('build review preserves existing signed metadata without validating its signature or inventing trust material', () => {
        const parsed = reviewBuildAttestation(JSON.stringify(signedMetadata), workspace.id, investigation.id);
        assert.deepEqual(parsed, signedMetadata);
        assert.equal(parsed.signature, signedMetadata.signature);
        assert.throws(() => reviewBuildAttestation(JSON.stringify({ ...signedMetadata, private_key: 'never import' }), workspace.id, investigation.id), /exact signed/);
        assert.throws(() => reviewBuildAttestation(JSON.stringify(signedMetadata), workspace.id, 'another-case'), /another workspace or investigation/);
        for (const body of [{ ...signedMetadata.body, origin: 'https://staging.example.org/path' }, { ...signedMetadata.body, commit_sha: 'reported-reference' }, { ...signedMetadata.body, observed_at: '2026-10-13T00:00:00Z' }])
            assert.throws(() => reviewBuildAttestation(JSON.stringify({ ...signedMetadata, body }), workspace.id, investigation.id));
        assert.throws(() => reviewBuildAttestation('x'.repeat(16385), workspace.id, investigation.id), /bounded existing/);
        assert.throws(() => reviewBuildAttestation('{', workspace.id, investigation.id), /valid JSON/);
    });
    test('viewer and analyst cannot render mutation controls or private fixture values, even if a response contains owner detail', () => {
        const state = unknownStagingRegistry();
        state.fixtures = { items: [{ id: 'fixture-one', name: '<img src=x onerror=run()>', content_hash: '1'.repeat(64), revision_id: 'historical-revision', freshness: 'current', verification_status: 'not_run', variables: [{ name: 'cart', value: 'OWNER_PRIVATE_LITERAL' }], credential_configured: true }], error: null };
        state.observations = { items: [{ id: 'observation-one', name: 'Finite receipt', profile_hash: '2'.repeat(64), revision_id: investigation.active_revision_id, freshness: 'current', verification_status: 'not_run', value: { schema_version: 1, id: 'observation-one', workspace_id: workspace.id, case_id: investigation.id, revision_id: investigation.active_revision_id, template: 'checkout_receipt_v1', receipt: { path_template: '/OWNER_PRIVATE_PATH/{attempt_id}', method: 'GET', credential_ref: 'OWNER_PRIVATE_CREDENTIAL_REFERENCE', completed_pointer: '/completed', order_count_pointer: '/order_count', error_code_pointer: null, max_response_bytes: 65536 }, success_locator: { kind: 'test_id', value: 'OWNER_PRIVATE_LOCATOR' }, incident_error_code: null, symptom_evidence_ids: [evidence.id], sandbox_only: true, created_at: workspace.created_at, reviewed_by: 'unit-owner', profile_hash: '2'.repeat(64) } }], error: null };
        for (const role of ['viewer', 'analyst'] as const) {
            const html = renderToStaticMarkup(<StagingInventories state={state} role={role} investigation={investigation} onRevoke={() => { throw Error('Never invoked'); }}/>);
            assert.doesNotMatch(html, /OWNER_PRIVATE_|Revoke target access|<img /);
            assert.match(html, /&lt;img/);
            assert.match(html, /Stale input revision/);
        }
        const owner = renderToStaticMarkup(<StagingInventories state={state} role="owner" investigation={investigation}/>);
        assert.match(owner, /OWNER_PRIVATE_LITERAL/);
        assert.doesNotMatch(owner, /OWNER_PRIVATE_CREDENTIAL_REFERENCE/);
        for (const role of ['viewer', 'analyst'] as const) {
            const html = renderToStaticMarkup(<StagingRegistryPanel base={base} workspace={{ ...workspace, role }} investigation={investigation} csrf="unit-csrf" evidence={[evidence]}/>);
            assert.doesNotMatch(html, /Save reviewed|Approve targets|Import reviewed|Review signed attestation|Add literal variable/);
            assert.match(html, /read access only/);
        }
        const closed = renderToStaticMarkup(<StagingRegistryPanel base={base} workspace={workspace} investigation={{ ...investigation, lifecycle: 'closed' }} csrf="unit-csrf" evidence={[]}/>);
        assert.match(closed, /Reopen it before adding immutable/);
        assert.doesNotMatch(closed, /Save reviewed fixture profile|Save reviewed observation profile|Review signed attestation/);
    });
    test('actual client inventory GET failures and malformed success data stay unknown while independent reads retain their result', async () => {
        const original = globalThis.fetch, requests: {
            path: string;
            method: string;
        }[] = [];
        globalThis.fetch = async (input, options) => {
            const url = String(input);
            requests.push({ path: url, method: options?.method ?? 'GET' });
            if (url.endsWith('/target-grants'))
                return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Role changed' } }), { status: 403 });
            if (url.endsWith('/runner-profiles'))
                return new Response(JSON.stringify({ data: [{ id: 'malformed-profile', status: 'available' }] }), { status: 200 });
            return new Response(JSON.stringify({ data: [], meta: { request_id: 'unit-read' } }), { status: 200 });
        };
        try {
            const state = await readStagingRegistry(base, workspace, investigation, new AbortController().signal);
            assert.equal(requests.length, 6);
            assert.ok(requests.every(row => row.method === 'GET' && row.path.startsWith('/api/v1/workspaces/unit-workspace/')));
            assert.equal(state.grants.items, null);
            assert.ok(state.grants.error instanceof ApiError);
            assert.equal(state.runners.items, null);
            assert.match(state.runners.error!.message, /capability state is unknown/i);
            assert.deepEqual(state.fixtures.items, []);
            assert.deepEqual(state.environments.items, []);
            const html = renderToStaticMarkup(<StagingInventories state={state} role="owner" investigation={investigation}/>);
            assert.match(html, /Recorded metadata remains unknown/);
            assert.doesNotMatch(html, /No target grants are recorded|No runner profiles are recorded|status good/);
        }
        finally {
            globalThis.fetch = original;
        }
    });
});
