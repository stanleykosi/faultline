import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {MetricContractDiff, metricContractDiff} from './MetricContractDiff';
import type {Metric, MetricRecord, Snapshot} from './types';

const value:Metric={version:1,template:'session_conversion_v1',source_id:'source-before',unit:'session',entry_event:'entered',success_event:'converted',horizon_seconds:1800,segment_property:'device',cohorts:['mobile','desktop'],windows:{baseline:{start:'2026-09-01T00:00:00Z',end:'2026-09-02T00:00:00Z'},comparison:{start:'2026-09-02T00:00:00Z',end:'2026-09-03T00:00:00Z'}},exclusion_rule:'entry_excluded_false',timezone:'UTC'};
const record:MetricRecord={id:'prior-metric',state:'frozen',value,metric_hash:'a'.repeat(64),revision_id:'prior-revision',snapshot_id:'prior-snapshot'};
const snapshot:Snapshot={id:'prior-snapshot',source_id:'source-before',content_hash:'b'.repeat(64),coverage:{extraction_status:'complete',basis:'operator_attestation',covered_start:'2026-09-01T00:00:00Z',covered_end:'2026-09-03T00:30:00Z',event_watermark:'2026-09-03T00:30:00Z',attestation:'Authored complete interval.',event_time_intervals:[{start:'2026-09-01T00:00:00Z',end:'2026-09-03T00:30:00Z'}]}};

test('changed windows, source and attribution horizon are independently visible',()=>{
  // The comparator can expose a changed historical field; the editor/server still enforce locked V1 horizon.
  const proposed={...value,source_id:'source-after',horizon_seconds:900,windows:{...value.windows,comparison:{...value.windows.comparison,end:'2026-09-04T00:00:00Z'}}} as unknown as Metric;
  const rows=metricContractDiff(record,proposed,snapshot,{...snapshot,id:'proposed-snapshot',source_id:'source-after',content_hash:'c'.repeat(64)});
  for(const field of ['Logical analytics source','Later period end — excluded','Conversion time window','Snapshot identity','Snapshot source','Snapshot content hash'])assert.equal(rows.find(row=>row.field===field)?.status,'Changed',field);
  assert.equal(rows.find(row=>row.field==='Entry event')?.status,'Unchanged');
  assert.equal(rows.find(row=>row.field==='Conversion time window')?.proposed,'900 seconds');
});
test('identical inputs show unchanged without claiming that earlier verification remains fresh',()=>{
  const rows=metricContractDiff(record,value,snapshot,snapshot); assert.ok(rows.every(row=>row.status==='Unchanged'));
  const html=renderToStaticMarkup(<MetricContractDiff previous={record} proposed={value} previousSnapshot={snapshot} proposedSnapshot={snapshot}/>);
  assert.match(html,/0 changed fields/);assert.match(html,/dependent earlier claims stale, even when these fields are unchanged/);assert.doesNotMatch(html,/>PASS<|verification remains fresh/);
});
test('new investigation and unavailable earlier snapshot preserve unknown states and authored text is escaped',()=>{
  const proposed={...value,entry_event:'<script>entered</script>'};
  const html=renderToStaticMarkup(<MetricContractDiff previous={null} proposed={proposed} previousSnapshot={null} proposedSnapshot={snapshot}/>);
  assert.match(html,/No prior frozen metric is recorded/); assert.match(html,/Unknown/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  const unknown=metricContractDiff(record,value,null,snapshot);
  assert.equal(unknown.find(row=>row.field==='Snapshot content hash')?.status,'Unknown');
  assert.equal(unknown.find(row=>row.field==='Completeness and observation tail')?.status,'Unknown');
  assert.equal(unknown.find(row=>row.field==='Snapshot identity')?.status,'Unchanged');
});
