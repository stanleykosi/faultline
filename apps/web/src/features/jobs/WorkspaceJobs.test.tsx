import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {WorkspaceJobTable} from './WorkspaceJobs';

test('job inventory preserves failed and unknown execution states without deriving a domain pass',()=>{
  const common = {case_id:'case',revision_id:'input-revision',attempt:2,retry_of:'previous',created_at:'2026-10-13T12:00:00Z',updated_at:'2026-10-13T12:00:00Z'};
  const html = renderToStaticMarkup(<WorkspaceJobTable workspaceId="workspace" navigate={()=>{}} jobs={[{...common,id:'failed-job',kind:'analytic_compute',status:'failed',error_code:'INPUT_UNAVAILABLE'},{...common,id:'unknown-job',kind:'browser_execute',status:'',error_code:null}]}/>);
  for (const value of ['failed','Unknown','INPUT_UNAVAILABLE','Retry of previous','Revision input-revision','Open']) assert.ok(html.includes(value));
  assert.doesNotMatch(html,/>PASS<|validated|proven cause/);
});
