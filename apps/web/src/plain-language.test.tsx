import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {displayLabel, evidenceSummary, plainSummary} from './plain-language';
import {Status, ErrorNotice} from './ui';

test('friendly labels preserve distinct untested, failed, blocked, stale and unknown states',()=>{
 const states=['not_established','untested','not_reproduced','failed','blocked','stale','unknown','not_run'];
 for(const state of states)assert.doesNotMatch(displayLabel(state),/^(?:passed|validated|reproduced)$/i);
 assert.equal(displayLabel('association_only'),'Observed link only');assert.equal(displayLabel('specified_snapshot_and_test_environment'),'Selected data and test environment');
 assert.equal(displayLabel('untested'),'Not tested');assert.equal(displayLabel('not_reproduced'),'Not reproduced');assert.equal(displayLabel('failed'),'failed');
 assert.equal(displayLabel('sanitized'),'Filtered');assert.equal(displayLabel('inconclusive'),'No conclusion');assert.equal(displayLabel('mechanism'),'Issue reproduction');
 assert.equal(displayLabel('complete_attested'),'Complete (reported)');assert.equal(displayLabel('provisional'),'May change');assert.equal(displayLabel('incomplete'),'Incomplete');
});

test('only generated analytics summaries receive display wording; original evidence and unsafe text stay inert',()=>{
 const original={source_kind:'analytics',source_ref:'comparison:record',text:'Baseline cohorts: complete_attested. Aggregate causal effect remains unestablished. <script>throw 1</script>'};
 const before=JSON.stringify(original),shown=evidenceSummary(original);assert.match(shown,/earlier period groups: Complete \(reported\)/);assert.match(shown,/the overall cause remains unestablished/);assert.equal(JSON.stringify(original),before);
 for(const item of [{...original,source_kind:'human_note'},{...original,source_ref:'import:raw'}])assert.equal(evidenceSummary(item),item.text);
 const markup=renderToStaticMarkup(<><p>{shown}</p><Status>{'<img src=x onerror=alert(1)>'}</Status></>);assert.doesNotMatch(markup,/<script>|<img/);assert.match(markup,/&lt;script&gt;/);
 assert.equal(plainSummary('not_established'),'Not proven');
 for(const value of ['constructor','__proto__','toString'])assert.equal(typeof displayLabel(value),'string');
 const generated = {...original,text:'Comparison conversion rate at baseline cohort weights: 0.34 (complete). Baseline-mix standardization is a descriptive accounting identity, not a causal contribution. Descriptive association; aggregate causal effect not established.'};
 const beforeGenerated=JSON.stringify(generated);assert.equal(evidenceSummary(generated),'Later rate using earlier group sizes: 34% (complete). Using the earlier group sizes does not prove the cause. This is an observed link, not proof of the cause.');assert.equal(JSON.stringify(generated),beforeGenerated);
 assert.equal(plainSummary('stratum strata stratified rates within-stratum change baseline weights'),'group groups rates by group change within groups earlier group sizes');
 assert.match(plainSummary('Check cohort_change failed: observed_cohort_direction_contradicts_prediction.'),/Change within groups failed: The group changed differently/);
});

test('glossary preserves exact paths, URLs and quoted data while simplifying surrounding agent error prose',()=>{
 const references=['/hypotheses','/api/v1/cases/cohorts?kind=hypotheses&model=AI','https://example.test/baseline/strata?kind=hypotheses','contracts/hypotheses.schema.json','{"kind":"hypotheses","model":"AI"}','`aggregate/strata`','“AI baseline cohort_change”','‘AI baseline cohort_change’'];
 const input='AI request for '+references.join(' ; ')+' failed. Generate hypotheses for aggregate conversion.';
 const shown=plainSummary(input);
 assert.equal(plainSummary('Check for “AI baseline cohort_change” failed.'),'Check for “AI baseline cohort_change” failed.');
 for(const reference of references)assert.ok(shown.includes(reference),reference);
 assert.match(shown,/^agent request for/);assert.match(shown,/Suggest possible reasons for overall conversion/);
 const markup=renderToStaticMarkup(<ErrorNotice error={new Error('partial /hypotheses failed: AI request unavailable.')} />);
 assert.match(markup,/partial \/hypotheses failed: agent request unavailable/);assert.doesNotMatch(markup,/\/possible reasons/);
});
