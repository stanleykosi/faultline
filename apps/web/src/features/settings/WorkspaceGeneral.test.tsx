import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {WorkspaceGeneral, workspaceRename} from './WorkspaceGeneral';

test('workspace rename requires an actual bounded edit and preserves authored Unicode', () => {
  assert.equal(workspaceRename('  café 🧭  ','Original'), 'café 🧭');
  for (const value of ['   ', 'Original', 'x'.repeat(201)]) assert.throws(() => workspaceRename(value,'Original'));
});
test('analyst and viewer workspace details provide no rename action', () => {
  const common = {id:'workspace-id',name:'Original',created_at:'2026-10-13T12:00:00Z',revision:4};
  for (const role of ['analyst','viewer'] as const) {
    const html = renderToStaticMarkup(<WorkspaceGeneral workspace={{...common,role}} csrf="" onChanged={async()=>{}}/>);
    assert.match(html,/Only an owner can rename/); assert.doesNotMatch(html,/Review change|New name/);
  }
  const owner = renderToStaticMarkup(<WorkspaceGeneral workspace={{...common,role:'owner'}} csrf="" onChanged={async()=>{}}/>);
  assert.match(owner,/Review change/); assert.match(owner,/Version 4/);
});
