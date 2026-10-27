import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {computeFollowupComparison,followupEvidenceBindingFresh} from './service.js';
import {normalizeEventTime,eventMicros} from '../imports/time.js';
import type {FaultlineCanonicalEvent} from '../../../contracts/src/generated.js';

test('privileged binding accepts intact restricted evidence without making it eligible for sanitized projection',()=>{
 const expected='a'.repeat(64),other='b'.repeat(64),restricted={redaction_status:'restricted' as const,content_hash:expected},sanitized={redaction_status:'sanitized' as const,content_hash:expected},withdrawn={redaction_status:'withdrawn' as const,content_hash:expected};
 assert.equal(followupEvidenceBindingFresh(sanitized,expected),true);assert.equal(followupEvidenceBindingFresh(restricted,expected),false);assert.equal(followupEvidenceBindingFresh(restricted,expected,true),true);
 for(const privileged of [false,true]){assert.equal(followupEvidenceBindingFresh(withdrawn,expected,privileged),false);assert.equal(followupEvidenceBindingFresh({...restricted,content_hash:other},expected,privileged),false);assert.equal(followupEvidenceBindingFresh({...sanitized,content_hash:other},expected,privileged),false);assert.equal(followupEvidenceBindingFresh(undefined,expected,privileged),false);}
});
test('future-only follow-up retains immutable independent baseline, complete tail and observational counts',async()=>{
 const load=async(name:string)=>JSON.parse(await fs.readFile(new URL('../../../../fixtures/regression/'+name,import.meta.url),'utf8')),metric=await load('metric.json'),originalCoverage=await load('coverage.json'),expected=await load('expected.json'),original:FaultlineCanonicalEvent[]=(await load('events.json')).map((e:FaultlineCanonicalEvent)=>({...e,occurred_at:normalizeEventTime(e.occurred_at)}));
 const window={start:'2026-09-04T00:00:00.000Z',end:'2026-09-05T00:00:00.000Z'},freshCoverage={...originalCoverage,covered_start:window.start,covered_end:'2026-09-05T00:30:00.000Z',event_watermark:'2026-09-05T00:30:00.000Z',event_time_intervals:[{start:window.start,end:'2026-09-05T00:30:00.000Z'}]},fresh=original.filter(e=>e.occurred_at.startsWith('2026-09-01')).map(e=>({...e,event_id:'followup-'+e.event_id,session_id:'followup-'+e.session_id,occurred_at:e.occurred_at.replace('2026-09-01','2026-09-04')}));
 const result=computeFollowupComparison(original,fresh,metric,originalCoverage,freshCoverage,window).value;assert.equal(result.quality,'complete_attested');assert.equal(result.baseline?.eligible,1000);assert.equal(result.baseline?.converted,200);assert.equal(result.baseline?.rate,expected.baseline_rate);assert.equal(result.comparison?.eligible,1000);assert.equal(result.comparison?.converted,200);assert.equal(result.comparison?.rate,expected.baseline_rate);assert.equal(result.delta_pp,0);
 // The fresh watermark and the original watermark each independently constrain their own tail.
 for(const [baseline,later]of [[originalCoverage,{...freshCoverage,event_watermark:window.end}],[{...originalCoverage,event_watermark:metric.windows.baseline.end},freshCoverage],[originalCoverage,{...freshCoverage,extraction_status:'partial'}]] as const)assert.equal(computeFollowupComparison(original,fresh,metric,baseline,later,window).value.quality,'incomplete');
 assert.equal(computeFollowupComparison(original,fresh,metric,originalCoverage,{...freshCoverage,basis:'lateness_assumption',assumptions:['Explicit local fixture lateness assumption.']},window).value.quality,'provisional');
 assert.throws(()=>computeFollowupComparison(original,[{...fresh[0]!,source_id:'other-source'}],metric,originalCoverage,freshCoverage,window),/same logical source/);
 // An inclusive success horizon preserves six fractional digits without Date rounding.
 const entry={...fresh[0]!,event_id:'boundary-entry',session_id:'boundary',occurred_at:'2026-09-04T23:59:59.999999Z'},success={...entry,event_id:'boundary-success',event_name:metric.success_event,occurred_at:'2026-09-05T00:29:59.999999Z'};assert.equal(eventMicros(success.occurred_at)-eventMicros(entry.occurred_at),1_800_000_000n);assert.equal(computeFollowupComparison(original,[entry,success],metric,originalCoverage,freshCoverage,window).value.comparison?.converted,1);
});
