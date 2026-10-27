import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateContract} from '../../../contracts/src/validate.js';
import {type FaultlineReport} from '../../../contracts/src/generated.js';
import {renderReport} from './render.js';
import {analyticReportFindings, requireAnalyticFindings} from './analytic-findings.js';
import {type AnalyticResult} from '../investigation/analytic.js';
import {hash} from '../canonical.js';

// render
const report=validateContract<FaultlineReport>('report',{schema_version:1,id:'report-a',workspace_id:'workspace-a',case_id:'case-a',revision_id:'revision-a',status:'published',title:'Reviewed <script>alert(1)</script>',created_at:'2026-10-13T02:00:00.000Z',metric_hash:'a'.repeat(64),snapshot_hash:'b'.repeat(64),input_manifest_hash:'c'.repeat(64),claim:{association:'observed',mechanism:'untested',correction:'not_tested',attribution:{scope:'association_only',causal_effect:'not_established'},freshness:'fresh',coverage_quality:'complete_attested',scope:'specified_snapshot_and_test_environment',warning:null},findings:[{text:'Observed decline <img src=x onerror=alert(1)>',evidence_ids:['evidence-a'],test_result_ids:['result-a']}],alternatives:['Unresolved alternative'],limitations:['Source completeness is attested.'],recommended_actions:['Review controlled tests.'],follow_up:null,artifact_files:[]});
test("portable reports preserve frozen truth and citations while escaping untrusted content", () => {
 // every portable report format preserves exact frozen IDs/time/hashes, claim axes and citations
 {
  for(const format of ['json','html','markdown']){const rendered=renderReport(report,format),text=rendered.bytes.toString();for(const literal of ['report-a','revision-a',report.created_at,report.metric_hash,report.snapshot_hash,report.input_manifest_hash,'evidence-a','result-a','not_established','association_only','complete_attested'])assert.ok(text.includes(literal),format+' omitted '+literal);if(format==='json')assert.deepEqual(JSON.parse(text),report);if(format==='markdown')assert.deepEqual(JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!),report);}
 }
 // portable HTML and Markdown treat untrusted text as data, with no executable HTML inserted
 {
  const html=renderReport(report,'html').bytes.toString(),markdown=renderReport(report,'markdown').bytes.toString();assert.ok(!html.includes('<script>')&&!html.includes('<img '));assert.match(html,/default-src &#39;none&#39;|default-src 'none'/);assert.match(html,/&lt;script&gt;/);assert.ok(!markdown.split('```json')[0]!.includes('<script>'));assert.throws(()=>renderReport(report,'shell'),{code:'UNSUPPORTED_EXPORT'});
 }
});

// analytic findings
function row(outcome:AnalyticResult['outcome']='failed',id='failed-check'){
 return {id,title:'Checkout fell within each device group',fresh:true,value:{kind:'cohort_change' as const,outcome,result_hash:'a'.repeat(64),reasons:outcome==='failed'?['observed_cohort_direction_contradicts_prediction']:[],evidence_hashes:{'comparison-evidence':'b'.repeat(64)}},evidence:[{id:'comparison-evidence',content_hash:'c'.repeat(64),redaction_status:'sanitized'}]};
}
test("every analytic outcome remains cited without promoting prediction support to cause", () => {
 // failed prediction is an explicit immutable finding with both record and result citations
 {
  const check=row(),before=structuredClone(check),p=analyticReportFindings([check]);assert.equal(p.findings.length,1);assert.match(p.findings[0]!.text,/Did not support the prediction/);assert.match(p.findings[0]!.text,/did not change in the predicted direction/);assert.doesNotMatch(p.findings[0]!.text,/Supported the prediction\./);assert.deepEqual(p.findings[0]!.test_result_ids,['failed-check']);assert.deepEqual(p.findings[0]!.evidence_ids,['comparison-evidence']);assert.deepEqual(p.resultHashes,{'failed-check':'a'.repeat(64)});assert.deepEqual(p.evidenceHashes,{'comparison-evidence':'c'.repeat(64)});assert.deepEqual(p.required,[{id:'failed-check',finding_hash:hash(p.findings[0])}]);assert.deepEqual(check,before);
 }
 // blocked and inconclusive results are retained without becoming support or success
 {
  const p=analyticReportFindings([row('blocked','blocked-check'),row('inconclusive','small-group-check')]);assert.equal(p.findings.length,2);assert.match(p.findings[0]!.text,/Could not run/);assert.match(p.findings[1]!.text,/No conclusion/);assert.ok(p.findings.every(f=>!f.text.includes('Supported the prediction.')));assert.deepEqual(Object.keys(p.resultHashes),['blocked-check','small-group-check']);
 }
 // a passed check supports only its prediction and never promotes an explanation or establishes cause
 {
  const check=row('passed'),p=analyticReportFindings([check]);assert.match(p.findings[0]!.text,/Supported the prediction/);assert.match(p.findings[0]!.text,/does not change the saved explanation or prove the cause/);assert.equal(check.value.outcome,'passed');assert.ok(!('status' in check));
 }
});

test('stale checks stay outside current citations and cause a visible rerun limitation',()=>{
 const p=analyticReportFindings([{...row('passed','old-check'),fresh:false},row()]);assert.equal(p.findings.length,1);assert.deepEqual(p.findings[0]!.test_result_ids,['failed-check']);assert.deepEqual(Object.keys(p.resultHashes),['failed-check']);assert.match(p.limitations.join(' '),/out of date.*Run those checks again/);
});
test("report assembly rejects restricted evidence and unsupported outcomes or diagnostics", () => {
 // restricted or missing records block report assembly instead of hiding the failed check
 {
  for(const redaction_status of ['restricted','withdrawn'])assert.throws(()=>analyticReportFindings([{...row(),evidence:[{...row().evidence[0]!,redaction_status}]}]),{code:'CITATION_RESTRICTED'});
    assert.throws(()=>analyticReportFindings([{...row(),evidence:[]}]),{code:'CITATION_RESTRICTED'});
 }
 // unsupported outcomes are rejected rather than described as a passed check
 {
  const check=row();check.value.outcome='unknown' as AnalyticResult['outcome'];assert.throws(()=>analyticReportFindings([check]),{code:'INVALID_CHECK_RESULT'});
 }
 // unrecognized diagnostic codes do not become injected instructions or a false support label
 {
  const check=row();check.value.reasons=['<script>send credentials</script>'];const p=analyticReportFindings([check]);assert.doesNotMatch(p.findings[0]!.text,/<script>|credentials/);assert.match(p.findings[0]!.text,/Did not support the prediction.*Review the saved check details/);
 }
});

test('failed-check findings cannot be removed, edited into support or rebound to another result',()=>{
 const p=analyticReportFindings([row()]),f=p.findings[0]!;for(const findings of [[],[{...f,text:'Supported the prediction.'}],[{...f,test_result_ids:['other-result']}],[{...f,evidence_ids:['other-evidence']}]])assert.throws(()=>requireAnalyticFindings(findings,p.required),{code:'CHECK_RESULTS_REQUIRED'});
 assert.doesNotThrow(()=>requireAnalyticFindings([...p.findings,{text:'Reviewed additional context',evidence_ids:['comparison-evidence'],test_result_ids:[]}],p.required));
});
