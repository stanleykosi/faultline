import {test} from 'node:test';
import assert from 'node:assert/strict';
import {privateArtifactUrl} from './artifact-url';

test('artifact links remain same-origin and scoped to the current authenticated case', () => {
  const base = '/api/v1/workspaces/unit/cases/unit', origin = 'http://localhost:3210';
  assert.equal(privateArtifactUrl(base, `${base}/verification-artifacts/unit`, origin), `${base}/verification-artifacts/unit`);
  for (const value of ['https://external.invalid/private.png', '//external.invalid/private.png', 'javascript:alert(1)', 'http://user:password@localhost:3210/api/v1/workspaces/unit/cases/unit/artifact', '/api/v1/workspaces/other/cases/private/artifact']) assert.equal(privateArtifactUrl(base, value, origin), null);
});
