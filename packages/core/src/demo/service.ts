import {transaction, type Tx} from '../../../database/src/client.js';
import {newId, hash} from '../canonical.js';
import {demand} from '../errors.js';
import {access, audit, command, expected} from '../workspaces/service.js';
import {getCaseTx} from '../cases/service.js';
import {enqueue} from '../jobs/service.js';
import {demoCaseCopy, requireDemoReset, requireKnownDemoFixture, requireTrustedDemoRuntime, type DemoFixture} from './domain.js';

export type DemoRuntime = {production: boolean; runnerMode: string};

async function insertDemoCase(tx: Tx, workspaceId: string, actorId: string, fixture: DemoFixture, generation: number) {
  const caseId = newId(), revisionId = newId(), value = demoCaseCopy(fixture, generation);
  const row = (await tx.query('INSERT INTO faultline.cases(id,workspace_id,title,question,affected_flow,active_revision_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,workspace_id,title,question,affected_flow,active_revision_id,lifecycle,archived,revision,created_at,updated_at', [caseId, workspaceId, value.title, value.question, value.affected_flow, revisionId])).rows[0];
  await tx.query('INSERT INTO faultline.case_revisions(id,workspace_id,case_id,value,content_hash) VALUES($1,$2,$3,$4,$5)', [revisionId, workspaceId, caseId, value, hash(value)]);
  await tx.query('INSERT INTO faultline.demo_cases(workspace_id,case_id,fixture,fixture_version,generation,created_by) VALUES($1,$2,$3,1,$4,$5)', [workspaceId, caseId, fixture, generation, actorId]);
  return row;
}

export async function createDemoCase(workspaceId: string, actorId: string, key: string, fixture: DemoFixture, runtime: DemoRuntime) {
  requireTrustedDemoRuntime(runtime); requireKnownDemoFixture(fixture);
  return command(workspaceId, actorId, 'demo.create', key, {fixture}, async tx => {
    await access(tx, workspaceId, actorId, ['owner', 'analyst']);
    const created = await insertDemoCase(tx, workspaceId, actorId, fixture, 1);
    const job = await enqueue(tx, workspaceId, created.id, created.active_revision_id, 'demo_seed', {actor_id: actorId, fixture, fixture_version: 1, generation: 1});
    await audit(tx, workspaceId, actorId, 'demo.seed.accepted', {case_id: created.id, fixture, fixture_version: 1, job_id: job.job_id, synthetic: true});
    return {case_id: created.id, fixture, fixture_version: 1, generation: 1, synthetic: true, ...job};
  }, ['owner', 'analyst']);
}

export async function resetDemoCase(workspaceId: string, actorId: string, key: string, caseId: string, input: {fixture: DemoFixture; confirmation: string}, match: string, runtime: DemoRuntime) {
  requireTrustedDemoRuntime(runtime); requireKnownDemoFixture(input.fixture);
  return command(workspaceId, actorId, 'demo.reset', key, {caseId, ...input, match}, async tx => {
    const old = await getCaseTx(tx, workspaceId, actorId, caseId, true);
    // The demo marker is immutable to runtime roles; the enclosing command
    // locks the workspace and getCaseTx locks the case row for this reset.
    const marker = (await tx.query('SELECT fixture,fixture_version,generation FROM faultline.demo_cases WHERE workspace_id=$1 AND case_id=$2', [workspaceId, caseId])).rows[0];
    const active = await tx.query("SELECT id FROM faultline.jobs WHERE workspace_id=$1 AND case_id=$2 AND status IN('queued','running','waiting_for_input','cancel_requested') LIMIT 1", [workspaceId, caseId]);
    requireDemoReset({fixture: input.fixture, storedFixture: marker?.fixture, confirmation: input.confirmation, expectedRevision: match, currentRevision: old.revision, activeJobs: active.rowCount ?? 0});
    const generation = Number(marker.generation) + 1;
    await tx.query('UPDATE faultline.cases SET archived=true,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId, caseId]);
    const created = await insertDemoCase(tx, workspaceId, actorId, input.fixture, generation);
    const job = await enqueue(tx, workspaceId, created.id, created.active_revision_id, 'demo_seed', {actor_id: actorId, fixture: input.fixture, fixture_version: Number(marker.fixture_version), generation});
    await audit(tx, workspaceId, actorId, 'demo.reset.archived', {case_id: caseId, fixture: input.fixture, generation: Number(marker.generation), archived: true, physical_deletion: false});
    await audit(tx, workspaceId, actorId, 'demo.reset.seed.accepted', {case_id: created.id, archived_case_id: caseId, fixture: input.fixture, generation, job_id: job.job_id, synthetic: true});
    return {case_id: created.id, archived_case_id: caseId, fixture: input.fixture, fixture_version: Number(marker.fixture_version), generation, synthetic: true, ...job};
  }, ['owner', 'analyst']);
}

export async function getDemoCaseBinding(workspaceId: string, actorId: string, caseId: string) {
  return transaction(workspaceId, async tx => {
    await getCaseTx(tx, workspaceId, actorId, caseId);
    const row = (await tx.query('SELECT fixture,fixture_version,generation FROM faultline.demo_cases WHERE workspace_id=$1 AND case_id=$2', [workspaceId, caseId])).rows[0];
    demand(row, 'NOT_FOUND', 'Investigation unavailable.', 404);
    return row as {fixture: DemoFixture; fixture_version: number; generation: number};
  });
}
