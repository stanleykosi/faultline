import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {suppliedPatchView} from './fixture-patch.js';
test('supplied patch lookup preserves authored before/after bytes and explicit fixture scope',async()=>{
 const before=await fs.readFile('fixtures/checkout-site/incident.js'),after=await fs.readFile('fixtures/checkout-site/candidate.js'),patch=await fs.readFile('fixtures/checkout-site/candidate.patch');
 const result=suppliedPatchView(before,after,patch);assert.equal(result.production_claim_eligible,false);assert.equal(result.scope,'supplied_fixture_only');assert.equal(result.before.bytes_utf8,before.toString());assert.equal(result.after.bytes_utf8,after.toString());assert.match(result.diff.bytes_utf8,/--- a\/checkout\/behavior.js/);assert.notEqual(result.before.sha256,result.after.sha256);
 for(const args of [[after,after,patch],[before,before,patch],[before,after,Buffer.from('untrusted diff')]])assert.throws(()=>suppliedPatchView(...args as [Buffer,Buffer,Buffer]),{code:'FIXTURE_PATCH_CHANGED'});
});
