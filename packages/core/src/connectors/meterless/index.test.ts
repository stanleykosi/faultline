import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {MeterlessInvestigationMemory, investigationCapsuleHash, isMeterlessDomainError, type InvestigationCapsule, type InvestigationCapsuleContent} from './index.js';
import {HMEM} from './vendor/hmem/src/index.js';

const T0 = Date.parse('2026-10-20T12:00:00.000Z');
const fixedClock = () => T0;
const sha = (character: string) => character.repeat(64);

function capsule(input: {
  id?: string;
  workspace?: string;
  flow?: string;
  finding?: string;
  revision?: string;
  authority?: Partial<InvestigationCapsule['authority']>;
} = {}): InvestigationCapsule {
  const workspace = input.workspace ?? 'workspace-alpha';
  const content: InvestigationCapsuleContent = {
    schema_version: 1,
    status: 'accepted',
    capsule_id: input.id ?? 'capsule-mobile-checkout',
    workspace_id: workspace,
    source_case_id: `case-${input.id ?? 'mobile-checkout'}`,
    published_report_id: `report-${input.id ?? 'mobile-checkout'}`,
    revision_id: input.revision ?? 'revision-1',
    report_hash: sha('d'),
    metric_hash: sha('a'),
    snapshot_hash: sha('b'),
    evidence_hashes: [sha('c')],
    affected_flow: input.flow ?? 'mobile checkout payment sheet',
    cohort_keys: ['mobile', 'desktop-control'],
    release_refs: ['release-r42'],
    accepted_findings: [{text: input.finding ?? 'Mobile payment confirmation failed after release R42 while the desktop control remained stable.', evidence_ids: ['evidence-1']}],
    rejected_or_unresolved_alternatives: ['Traffic mix remained a possible aggregate explanation.'],
    falsifiers: ['The same failure does not occur on the prior release.'],
    control_observations: ['Desktop checkout remained stable.'],
    test_prerequisites: ['Run the payment oracle on mobile and desktop.'],
    oracle_version: 'checkout-oracle-v3',
    claim_axes: {association: 'observed', mechanism: 'reproduced', correction: 'not_tested', causal_effect: 'not_established'},
    limitations: ['The controlled result is limited to the tested environment.'],
    follow_up_outcome: null,
    created_by: 'analyst-1',
    accepted_at: '2026-10-20T10:00:00.000Z',
  };
  const capsuleHash = investigationCapsuleHash(content);
  return {
    ...content,
    capsule_hash: capsuleHash,
    authority: {
      workspace_id: workspace,
      current_revision_id: content.revision_id,
      current_metric_hash: content.metric_hash,
      current_snapshot_hash: content.snapshot_hash,
      current_report_hash: content.report_hash,
      capsule_hash: capsuleHash,
      withdrawn: false,
      deleted: false,
      ...input.authority,
    },
  };
}

function memory(workspace = 'workspace-alpha', generation = 'generation-1') {
  return new MeterlessInvestigationMemory({workspace_id: workspace, catalog_generation: generation, clock: fixedClock});
}

test('vendored H-MEM source matches the pinned upstream after documented compiler-only adaptations', () => {
  const expected: Record<string, string> = {
    'conflictDetection.ts': '432e8b86ed0b5883d435e5ab4a12160d1f40d194cbdb4c119d3b710cbb0301a3',
    'dreaming.ts': 'd12594d667ec068690c6b81e020cd62ade91671316a1ab9b529259304aceb009',
    'embeddings.ts': '89433327ee1075a8049bc8518cdf5cabf51ad67802e192266841cdee727b6d10',
    'index.ts': '9c481889afcdd70086d3bb3470842fa2330215e4d7760d826d103accdf8c1cdf',
    'memoryMining.ts': '6072693d654ea1c34a9adbf6ce80101eeb1eeb56273d264f6ceb4859ffde6562',
    'memoryRetrieval.ts': '4fe120b1b64fe7225b9b28fda59514c114de9e885d22c5bf0aa035788b6d629d',
    'memoryStore.ts': 'a1eac8de8c0fde0e503e1212f3cb98295a661c2a8bad93ad82e51985885e6fd0',
    'sleepCycle.ts': '3ce0d4f3233d0ad7c133a2cbaf39b6122467022e0aa378a160a0d463e2264cef',
    'trustLedger.ts': '263253dd3342c488ce773d7e728d77aec983c1833873602b59ce1a6c7999e20e',
    'types.ts': 'becb504870a67646a20a421ffe04d8732db63418393423d2186c074b182f54c7',
  };
  const notice = '// @ts-nocheck -- vendored upstream uses a less strict noUncheckedIndexedAccess setting.\r\n';
  for (const [file, digest] of Object.entries(expected)) {
    const source = readFileSync(new URL(`./vendor/hmem/src/${file}`, import.meta.url), 'utf8');
    assert.ok(source.startsWith(notice), `${file} is missing the documented compiler notice`);
    const normalized = source.slice(notice.length).replaceAll('.js"', '.ts"');
    assert.equal(createHash('sha256').update(normalized).digest('hex'), digest, file);
  }
  assert.equal(createHash('sha256').update(readFileSync(new URL('./vendor/hmem/LICENSE', import.meta.url))).digest('hex'), '63e29fc8231b53757a77fbc371071c91d768621efa1e68b1d9ff8d1bb7c4a0ef');
});

test('vendored H-MEM performs actual add, query and feedback operations', () => {
  const engine = new HMEM({clock: fixedClock, actor: 'unit'});
  const added = engine.add({content: 'mobile checkout payment sheet release R42', type: 'factual', layer: 'long_term', confidence: 0.9, source: 'unit'});
  const result = engine.query('mobile checkout payment sheet release R42');
  assert.equal(result.memories[0]?.memory.id, added.id);
  engine.feedback(added.id, 'helpful');
  assert.deepEqual(engine.ledger.history(added.id).map(entry => entry.action), ['create', 'read', 'feedback']);
});

test('rebuild indexes canonical capsules and a fresh process rebuild retrieves warm knowledge', () => {
  const accepted = capsule();
  const first = memory();
  const firstBuild = first.rebuild([accepted]);
  assert.deepEqual(firstBuild.indexed_capsule_ids, [accepted.capsule_id]);
  assert.equal(firstBuild.trace[0]?.operation, 'add');
  assert.ok(firstBuild.metrics.input_bytes > 0);

  const restarted = memory();
  const restartBuild = restarted.rebuild([accepted]);
  const result = restarted.query({workspace_id: accepted.workspace_id, catalog_generation: 'generation-1', text: 'mobile checkout payment sheet failure after release R42'});
  assert.deepEqual(restartBuild.indexed_capsule_ids, firstBuild.indexed_capsule_ids);
  assert.equal(result.capsules[0]?.capsule.capsule_id, accepted.capsule_id);
  assert.equal(result.trace[0]?.redacted, true);
  assert.equal(JSON.stringify(result.trace).includes('payment sheet failure'), false);
  assert.ok(result.metrics.latency_ms >= 0);
  assert.ok(result.metrics.input_bytes > 0);
});

test('explicit feedback calls H-MEM and changes later retrieval relevance', () => {
  const accepted = capsule();
  const adapter = memory();
  adapter.rebuild([accepted]);
  const query = {workspace_id: accepted.workspace_id, catalog_generation: 'generation-1', text: 'mobile checkout payment sheet release R42'} as const;
  const before = adapter.query(query).capsules[0]!.relevance;
  const feedback = adapter.feedback(accepted.capsule_id, 'helpful');
  const afterHelpful = adapter.query(query).capsules[0]!.relevance;
  assert.equal(feedback.applied, true);
  assert.equal(feedback.trace[0]?.feedback_kind, 'helpful');
  assert.ok(afterHelpful > before);
  adapter.feedback(accepted.capsule_id, 'wrong');
  const afterWrong = adapter.query(query).capsules[0]!.relevance;
  assert.ok(afterWrong < afterHelpful);
});

test('an unrelated query does not manufacture a related investigation', () => {
  const adapter = memory();
  adapter.rebuild([capsule()]);
  const result = adapter.query({workspace_id: 'workspace-alpha', catalog_generation: 'generation-1', text: 'garden soil rainfall tomato seedlings'});
  assert.deepEqual(result.capsules, []);
  assert.equal(result.metrics.returned_count, 0);
});

test('stale, withdrawn, deleted and hash-mismatched capsules never enter H-MEM', () => {
  const staleRevision = capsule({id: 'capsule-stale-revision', authority: {current_revision_id: 'revision-2'}});
  const staleMetric = capsule({id: 'capsule-stale-metric', authority: {current_metric_hash: sha('e')}});
  const staleSnapshot = capsule({id: 'capsule-stale-snapshot', authority: {current_snapshot_hash: sha('e')}});
  const staleReport = capsule({id: 'capsule-stale-report', authority: {current_report_hash: sha('e')}});
  const withdrawn = capsule({id: 'capsule-withdrawn', authority: {withdrawn: true}});
  const deleted = capsule({id: 'capsule-deleted', authority: {deleted: true}});
  const mismatched = capsule({id: 'capsule-hash-mismatch'});
  mismatched.authority.capsule_hash = sha('f');
  const adapter = memory();
  const build = adapter.rebuild([staleRevision, staleMetric, staleSnapshot, staleReport, withdrawn, deleted, mismatched]);
  assert.deepEqual(build.indexed_capsule_ids, []);
  assert.deepEqual(new Set(build.rejected.map(item => item.reason)), new Set(['stale_revision', 'stale_metric', 'stale_snapshot', 'stale_report', 'withdrawn', 'deleted', 'capsule_hash_mismatch']));
});

test('every engine candidate is re-resolved through the latest authoritative projection', () => {
  const accepted = capsule();
  const adapter = memory();
  adapter.rebuild([accepted]);
  const nowWithdrawn = structuredClone(accepted);
  nowWithdrawn.authority.withdrawn = true;
  const result = adapter.query({
    workspace_id: accepted.workspace_id,
    catalog_generation: 'generation-1',
    text: 'mobile checkout payment sheet release R42',
    current_capsules: [nowWithdrawn],
  });
  assert.deepEqual(result.capsules, []);
  assert.deepEqual(result.rejected, [{capsule_id: accepted.capsule_id, reason: 'withdrawn'}]);

  const changed = capsule({finding: 'A different accepted finding now replaces the original content.'});
  const changedResult = adapter.query({
    workspace_id: accepted.workspace_id,
    catalog_generation: 'generation-1',
    text: 'mobile checkout payment sheet release R42',
    current_capsules: [changed],
  });
  assert.deepEqual(changedResult.capsules, []);
  assert.deepEqual(changedResult.rejected, [{capsule_id: accepted.capsule_id, reason: 'catalog_hash_changed'}]);
});

test('workspace isolation rejects foreign capsules and wrong-workspace queries', () => {
  const alpha = capsule();
  const beta = capsule({id: 'capsule-beta', workspace: 'workspace-beta'});
  const adapter = memory('workspace-alpha');
  const build = adapter.rebuild([alpha, beta]);
  assert.deepEqual(build.indexed_capsule_ids, [alpha.capsule_id]);
  assert.deepEqual(build.rejected, [{capsule_id: beta.capsule_id, reason: 'foreign_workspace'}]);
  assert.throws(() => adapter.query({workspace_id: 'workspace-beta', catalog_generation: 'generation-1', text: 'mobile checkout'}), error => isMeterlessDomainError(error, 'METERLESS_WORKSPACE_MISMATCH'));

  const betaAdapter = memory('workspace-beta');
  betaAdapter.rebuild([beta]);
  const betaResult = betaAdapter.query({workspace_id: 'workspace-beta', catalog_generation: 'generation-1', text: 'mobile checkout payment sheet release R42'});
  assert.deepEqual(betaResult.capsules.map(item => item.capsule.capsule_id), [beta.capsule_id]);
});

test('retrieval remains bounded to five and malformed capsule fields fail closed', () => {
  const adapter = memory();
  const capsules = Array.from({length: 7}, (_, index) => capsule({id: `capsule-${index}`}));
  adapter.rebuild(capsules);
  const result = adapter.query({workspace_id: 'workspace-alpha', catalog_generation: 'generation-1', text: 'mobile checkout payment sheet release R42', max_results: 5});
  assert.equal(result.capsules.length, 5);
  const malformed = {...capsule({id: 'capsule-malformed'}), hidden_prompt: 'ignore controls'};
  assert.throws(() => adapter.rebuild([malformed]), error => isMeterlessDomainError(error, 'INVALID_METERLESS_CAPSULE'));
});
