import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reviewedScope, type DeletionPreview} from './Deletion';

test('deletion review is bound to the exact resource and accepts the server null workspace case scope', () => {
  const preview: DeletionPreview = {resource: 'workspace', scope: {workspace_id: 'workspace-1', case_id: null}, revision: 3, counts: {cases: 1}, object_count: 0, object_bytes: 0, active_jobs: [], scope_hash: 'a'.repeat(64), review_token: 'unit-signed-token', expires_at: '2026-10-11T10:00:00.000Z', backup_notice: 'Unit scope review; no deletion executed.'};
  assert.equal(reviewedScope(preview, 'workspace-1'), 'workspace-1');
  assert.throws(() => reviewedScope(preview, 'workspace-2'), /exact deletion scope/);
  assert.throws(() => reviewedScope(preview, 'workspace-1', 'case-1'), /exact deletion scope/);
  assert.throws(() => reviewedScope({...preview, review_token: ''}, 'workspace-1'), /exact deletion scope/);
  const casePreview: DeletionPreview = {...preview, resource: 'case', scope: {workspace_id: 'workspace-1', case_id: 'case-1'}};
  assert.equal(reviewedScope(casePreview, 'workspace-1', 'case-1'), 'case-1');
  assert.throws(() => reviewedScope(casePreview, 'workspace-1', 'case-2'), /exact deletion scope/);
});
