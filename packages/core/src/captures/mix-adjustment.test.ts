import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {baselineAdjustment,requireCurrentMixBinding} from './mix-adjustment.js';
import {computeComparison} from '../metrics/comparison.js';
import {normalizeAnalytics} from '../imports/parser.js';
const read=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
const near=(actual:number|null,expected:number)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-10);
for(const fixture of ['mix-shift','regression'])test(fixture+' baseline accounting preserves independently authored fixture expectations',()=>{
 const events=normalizeAnalytics(fs.readFileSync(`fixtures/${fixture}/events.csv`),'csv','synthetic-analytics').events;
 const comparison=computeComparison(events,read(`fixtures/${fixture}/metric.json`),read(`fixtures/${fixture}/coverage.json`)),expected=read(`fixtures/${fixture}/expected.json`),before=JSON.stringify(comparison),mix=baselineAdjustment(comparison,{standard_population:'baseline'});
 assert.equal(JSON.stringify(comparison),before);assert.equal(mix.status,'complete');near(comparison.baseline!.rate,fixture==='mix-shift'?0.34:0.2);near(comparison.comparison!.rate,fixture==='mix-shift'?0.16:0.11);near(mix.standardized_rate,expected.standardized_rate);near(mix.within_component_pp,expected.within_component_pp);near(mix.composition_component_pp,expected.composition_component_pp);
 for(const cohort of ['mobile','desktop']){near(comparison.baseline!.strata[cohort]!.rate,expected[cohort+'_before']);near(comparison.comparison!.strata[cohort]!.rate,expected[cohort+'_after']);}
 assert.match(mix.limitations[0]!,/not a causal contribution/);
});
test('forged populations and additional fields are rejected before calculation',()=>{
 for(const input of [{standard_population:'comparison'},{standard_population:'baseline',weights:{mobile:1}},{}])assert.throws(()=>baselineAdjustment({},input as never),error=>error instanceof Error&&'code'in error&&error.code==='INVALID_POPULATION');
});
test('incomplete comparison preserves unknown standardization rather than a passing status',()=>{
 const events=normalizeAnalytics(fs.readFileSync('fixtures/mix-shift/events.csv'),'csv','synthetic-analytics').events,result=computeComparison(events,read('fixtures/mix-shift/metric.json'),{...read('fixtures/mix-shift/coverage.json'),basis:'none'}),mix=baselineAdjustment(result,{standard_population:'baseline'});
 assert.equal(mix.status,'inconclusive');assert.equal(mix.reason,'incomplete_comparison');assert.equal(mix.standardized_rate,null);assert.equal(mix.within_component_pp,null);assert.equal(mix.composition_component_pp,null);
});
test('stale revision, hash changes and nonsucceeded source jobs cannot authorize standardization',()=>{
 const bound={comparison_revision_id:'r',current_revision_id:'r',comparison_metric_hash:'m',current_metric_hash:'m',comparison_snapshot_hash:'s',current_snapshot_hash:'s',source_job_status:'succeeded'};assert.doesNotThrow(()=>requireCurrentMixBinding(bound));
 for(const patch of [{current_revision_id:'old'},{current_metric_hash:'other'},{current_snapshot_hash:'other'},...['running','failed','cancelled','waiting_for_input'].map(source_job_status=>({source_job_status}))])assert.throws(()=>requireCurrentMixBinding({...bound,...patch}),error=>error instanceof Error&&'code'in error&&error.code==='STALE_INPUTS');
});
