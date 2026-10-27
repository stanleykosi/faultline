import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {proposalReadinessKey, proposalRequestState, readProposalRequestReadiness, type ProposalReadinessBinding, type ProposalRequestReadiness} from './request-readiness';

const base = '/api/v1/workspaces/readiness-workspace/cases/readiness-case';
const binding: ProposalReadinessBinding = {base, revisionId: 'frozen-revision', profileId: 'profile-one', kind: 'diagnosis_draft', refreshKey: 'first-read'};
const fits: ProposalRequestReadiness = {revision_id: binding.revisionId, profile_id: binding.profileId, kind: binding.kind, remaining_calls: 2, remaining_input: 5000, remaining_output: 1000, input_required: 4000, can_request: true, reason_code: null};
const snapshot = (value = fits) => ({key: proposalReadinessKey(binding), status: 'available' as const, value});

test('request fit uses the exact request size even when remaining input and calls are positive', () => {
  assert.equal(proposalRequestState(snapshot(), binding).canRequest, true);
  const state = proposalRequestState(snapshot({...fits, remaining_input: 3999, can_request: false, reason_code: 'MODEL_BUDGET_EXHAUSTED'}), binding);
  assert.equal(state.canRequest, false); assert.equal(state.status, 'exhausted');
  assert.match(state.message!, /Saved drafts and tool results are preserved/);
  assert.match(state.message!, /owner.*refresh/);
  // Even a contradictory optimistic response cannot enable an oversized request.
  assert.equal(proposalRequestState(snapshot({...fits, remaining_input: 3999}), binding).canRequest, false);
  for (const change of [{remaining_calls: 0}, {remaining_output: 0}]) assert.equal(proposalRequestState(snapshot({...fits, ...change}), binding).canRequest, false);
});

test('unavailable, malformed and stale readiness fail closed before selection effects run', () => {
  for (const change of [{profileId: 'other-profile'}, {revisionId: 'new-revision'}, {kind: 'hypotheses' as const}, {base: '/another-case'}, {refreshKey: 'refresh'}]) {
    const state = proposalRequestState(snapshot(), {...binding, ...change});
    assert.equal(state.canRequest, false); assert.equal(state.status, 'loading');
  }
  for (const state of [null, {key: proposalReadinessKey(binding), status: 'loading' as const, value: null}, {key: proposalReadinessKey(binding), status: 'unavailable' as const, value: null}]) assert.equal(proposalRequestState(state, binding).canRequest, false);
  for (const change of [{revision_id: 'older-revision'}, {input_required: Number.NaN}, {remaining_input: -1}, {reason_code: 'unexpected'}, {can_request: 'true'}]) {
    const state = proposalRequestState(snapshot({...fits, ...change} as ProposalRequestReadiness), binding);
    assert.equal(state.canRequest, false); assert.equal(state.status, 'unavailable');
  }
});

test('the exact-bound allowance check is a single read with no model request or mutation', async () => {
  const original = globalThis.fetch, requests: {path: string; method?: string}[] = [];
  globalThis.fetch = async (path, options) => {requests.push({path: String(path), method: options?.method}); return Response.json({data: fits});};
  try {
    assert.deepEqual(await readProposalRequestReadiness(binding), fits);
    assert.deepEqual(requests, [{path: `${base}/model-proposal-readiness?profile_id=profile-one&kind=diagnosis_draft`, method: 'GET'}]);
    globalThis.fetch = async () => Response.json({data: {...fits, profile_id: 'another-profile'}});
    await assert.rejects(readProposalRequestReadiness(binding), /did not match/);
    globalThis.fetch = async () => Response.json({error: {code: 'UNAVAILABLE', message: 'Unavailable'}}, {status: 503});
    await assert.rejects(readProposalRequestReadiness(binding), /Unavailable/);
  } finally {globalThis.fetch = original;}
});

const digest = 'a'.repeat(64);
const context = {binding: {workspace_id: 'readiness-workspace', case_id: 'readiness-case', revision_id: binding.revisionId, metric_hash: digest, snapshot_hash: digest}, comparison: {}, metric: {}, capabilities: {}};
const savedProposal = {id: 'saved-proposal', profile_id: 'profile-one', profile_hash: digest, input_hash: digest, evidence_hashes: {}, revision_id: binding.revisionId, draft_only: true, freshness: 'fresh', created_at: '2026-10-26T00:00:00Z', value: {schema_version: 1, kind: 'diagnosis_draft', revision_id: binding.revisionId, input_hash: digest, hypotheses: [], draft_sentences: [{qualification: 'limitation', text: 'Aggregate causal effect is not established.', evidence_ids: []}], limitations: [], questions: []}};
const savedReport = {id: 'saved-report', revision: 7, freshness: 'fresh', value: {id: 'saved-report', revision_id: binding.revisionId, status: 'draft', title: 'Saved report', metric_hash: digest, snapshot_hash: digest, claim: {freshness: 'fresh'}}};

test('browser: exact allowance blocks new generation while saved report and hypothesis review remain usable', {timeout: 60000}, async () => {
  const bundled = await build({stdin: {contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {DiagnosisModelDraft} from './apps/web/src/features/providers/DiagnosisModelDraft'; import {ModelProposals} from './apps/web/src/features/providers/ModelProposals';
    const common = {base: ${JSON.stringify(base)}, csrf: 'unit-csrf', context: ${JSON.stringify(context)}, evidence: [], canMutate: true, onChanged: async () => {}};
    createRoot(document.getElementById('root')).render(location.pathname === '/hypotheses' ? <ModelProposals {...common} workspace={{id:'readiness-workspace',role:'owner'}} investigation={{id:'readiness-case',active_revision_id:'frozen-revision',revision:1}} refreshToken={0} /> : <DiagnosisModelDraft {...common} role="owner" initialProposalId="saved-proposal" preferredModelProfileId="profile-one" selectedReport={${JSON.stringify(savedReport)}} refreshToken="first" />);`, resolveDir: process.cwd(), loader: 'tsx'}, bundle: true, write: false, format: 'iife', platform: 'browser', tsconfig: 'apps/web/tsconfig.json', logLevel: 'silent'});
  const browser = await chromium.launch({headless: true, chromiumSandbox: true, ...(process.platform === 'win32' ? {channel: 'msedge'} : {})});
  const page = await browser.newPage();
  let mode: 'diagnosis_draft' | 'hypotheses' = 'diagnosis_draft', allow = false, secondRequested = false, releaseSecond: (() => void) | null = null;
  const mutations: {path: string; body: unknown}[] = [];
  const hypothesisProposal = {...savedProposal, value: {...savedProposal.value, kind: 'hypotheses', draft_sentences: [], hypotheses: [{title: 'Saved hypothesis', statement: 'Review this saved possibility.', falsifier: 'An independent control differs.', supporting_evidence_ids: [], contradicting_evidence_ids: [], missing_evidence: [], proposed_test_kinds: ['data_validation']}]}};
  try {
    await page.route('http://readiness.localhost/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) {await route.fulfill({contentType: 'text/html', body: `<div id="root"></div><script>${bundled.outputFiles[0]!.text}</script>`}); return;}
      const fulfill = (data: unknown) => route.fulfill({json: {data}});
      if (request.method() !== 'GET') {
        mutations.push({path: url.pathname, body: request.postDataJSON()});
        if (request.method() === 'PATCH' && url.pathname.endsWith('/diagnoses/saved-report')) {await fulfill({...savedReport, revision: 8}); return;}
        if (url.pathname.endsWith('/hypothesis-proposals/saved-proposal/accept')) {await fulfill([{id: 'accepted-saved-hypothesis'}]); return;}
        await route.fulfill({status: 409, json: {error: {code: 'UNEXPECTED_MUTATION', message: 'A model request was not expected.'}}}); return;
      }
      if (url.pathname.endsWith('/model-profiles')) {await fulfill(['profile-one', 'profile-two'].map(id => ({id, name: id, model_name: 'configured', provider: 'openai_compatible', status: 'available', capabilities: {status: 'available'}, profile_hash: digest, base_url: 'https://provider.invalid', credential: null}))); return;}
      if (url.pathname.endsWith('/model-proposals')) {await fulfill([mode === 'hypotheses' ? hypothesisProposal : savedProposal]); return;}
      if (url.pathname.endsWith('/model-proposals/saved-proposal')) {await fulfill(mode === 'hypotheses' ? hypothesisProposal : savedProposal); return;}
      if (url.pathname.endsWith('/model-proposal-readiness')) {
        const id = url.searchParams.get('profile_id');
        if (id === 'profile-two') {secondRequested = true; await new Promise<void>(resolve => {releaseSecond = resolve;}); await route.fulfill({status: 503, json: {error: {code: 'UNAVAILABLE', message: 'Readiness unavailable.'}}}); return;}
        await fulfill({...fits, kind: mode, remaining_input: allow ? 5000 : 3999, can_request: allow, reason_code: allow ? null : 'MODEL_BUDGET_EXHAUSTED'}); return;
      }
      await route.fulfill({status: 404, json: {error: {message: 'Unknown test read.'}}});
    });
    await page.goto('http://readiness.localhost/report');
    await page.getByText('This agent request exceeds the remaining allowance.', {exact: false}).waitFor({state: 'attached'});
    const generate = page.getByRole('button', {name: 'Generate report draft', exact: true, includeHidden: true});
    assert.equal(await generate.isDisabled(), true);
    assert.equal(await page.getByRole('button', {name: 'Review sentences', exact: true}).isEnabled(), true);
    await page.getByRole('button', {name: 'Review sentences', exact: true}).click();
    await page.getByRole('checkbox', {name: /Select sentence 1/}).check();
    await page.getByRole('checkbox', {name: /I reviewed each selected model qualification/}).check();
    await page.getByRole('button', {name: 'Add selected sentences', exact: true}).click();
    await page.getByText('Appended 1 explicitly reviewed model sentence', {exact: false}).waitFor();
    assert.deepEqual(mutations, [{path: `${base}/diagnoses/saved-report`, body: {model_proposal_id: 'saved-proposal', proposal_sentence_indexes: [0]}}]);

    allow = true;
    await page.getByRole('button', {name: 'Refresh', exact: true}).click();
    await page.waitForFunction(() => {const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Generate report draft'); return button && !button.disabled;});
    await page.getByText('Generate draft', {exact: true}).click();
    await page.getByLabel('Agent model').selectOption('profile-two');
    assert.equal(await generate.isDisabled(), true, 'A previously allowed profile never authorizes a newly selected profile.');
    await page.waitForFunction(() => document.body.textContent?.includes('Checking this agent request’s allowance.'));
    assert.equal(secondRequested, true);
    assert.ok(releaseSecond); (releaseSecond as () => void)();
    await page.getByText('Could not check this agent request’s allowance.', {exact: false}).waitFor();
    assert.equal(await generate.isDisabled(), true);
    assert.equal(await page.getByRole('button', {name: 'Review sentences', exact: true}).isEnabled(), true, 'Unavailable allowance cannot disable saved sentence review.');

    mode = 'hypotheses'; allow = false;
    await page.goto('http://readiness.localhost/hypotheses?model_proposal=saved-proposal');
    await page.locator('summary').filter({hasText: /^Suggest possible reasons$/}).click();
    await page.getByLabel('Agent model').selectOption('profile-one');
    await page.getByText('This agent request exceeds the remaining allowance.', {exact: false}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Suggest possible reasons', exact: true}).isDisabled(), true);
    await page.getByRole('button', {name: 'Review and add possible reasons', exact: true}).click();
    await page.getByRole('checkbox', {name: 'Saved possible reason', exact: true}).check();
    await page.getByRole('checkbox', {name: /I reviewed each selected statement/}).check();
    await page.getByRole('button', {name: 'Add selected possible reasons', exact: true}).click();
    await page.getByText('Possible reasons added. They still need testing.').waitFor();
    assert.equal(mutations.length, 2);
    assert.deepEqual(mutations[1], {path: `${base}/hypothesis-proposals/saved-proposal/accept`, body: {proposal_item_indexes: [0]}});
  } finally {if (releaseSecond) (releaseSecond as () => void)(); await browser.close();}
});
