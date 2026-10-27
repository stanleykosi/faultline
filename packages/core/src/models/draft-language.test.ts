import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDraftStatusLanguage} from './draft-language.js';

test('explicit model prose cannot promote check outcomes into explanation verdicts',()=>{
 for(const text of ['The hypothesis passed.','The explanation has failed.','The hypotheses were confirmed.','The explanation status is validated.','The explanation is proven.','The explanation is con\u200bfirmed.','The explanation status changed to passed.'])assert.throws(()=>assertDraftStatusLanguage(text),{code:'INVALID_MODEL_PROPOSAL'});
 for(const text of ['The check passed; the explanation remains proposed.','The check did not support the prediction; the explanation remains proposed.','The check is blocked, so its prediction remains untested.','This check is inconclusive.','The cancelled check has no result.','The check was not run.'])assert.doesNotThrow(()=>assertDraftStatusLanguage(text));
});

test('the recorded mix-shift status promotion is rejected without rewriting it or changing legitimate check narration',()=>{
 const recorded='The mix-shift hypothesis moved from proposed to passed, backed by the saved conversion evidence.';
 assert.throws(()=>assertDraftStatusLanguage(recorded),{code:'INVALID_MODEL_PROPOSAL'});
 assert.equal(recorded,'The mix-shift hypothesis moved from proposed to passed, backed by the saved conversion evidence.');
 for(const transition of ['changed from proposed to passed','went from proposed to passed','has moved from proposed to passed','was changed from proposed to failed','transitioned from needs_evidence to validated','advanced to confirmed','shifted from accepted to proven'])assert.throws(()=>assertDraftStatusLanguage('The explanation '+transition+'.'),{code:'INVALID_MODEL_PROPOSAL'});
 for(const text of ['The hypothesis remains proposed; the check passed.','The explanation remains proposed; the check failed.','The hypothesis moved from proposed to accepted after human review.','The hypothesis changed from accepted to rejected after review.'])assert.doesNotThrow(()=>assertDraftStatusLanguage(text));
});
