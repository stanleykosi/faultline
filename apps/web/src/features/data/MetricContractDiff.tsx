import type {Metric, MetricRecord, Snapshot} from './types';

export interface ContractDiffRow {field:string;previous:string;proposed:string;status:'Changed'|'Unchanged'|'Unknown';}
function coverage(snapshot:Snapshot|null):string|null {
  const value=snapshot?.coverage;
  if(!value)return null;
  return [`Extraction ${value.extraction_status}; basis ${value.basis}`,`Covered ${value.covered_start ?? 'unknown'} → ${value.covered_end ?? 'unknown'}`,`Watermark ${value.event_watermark ?? 'unknown'}`,...value.event_time_intervals.map(interval=>`${interval.start} → ${interval.end}`),`Statement ${value.attestation || 'none recorded'}`,`Assumptions ${value.assumptions?.join('; ') || 'none recorded'}`].join(' · ');
}
export function metricContractDiff(previous:MetricRecord|null,proposed:Metric,previousSnapshot:Snapshot|null,proposedSnapshot:Snapshot|null):ContractDiffRow[] {
  const old=previous?.value;
  const rows:ContractDiffRow[]=[];
  function row(field:string,before:string|number|null|undefined,after:string|number|null|undefined){rows.push({field,previous:before==null?'Unknown':String(before),proposed:after==null?'Unknown':String(after),status:before==null||after==null?'Unknown':String(before)===String(after)?'Unchanged':'Changed'});}
  row('Logical analytics source',old?.source_id,proposed.source_id);
  row('Entry event',old?.entry_event,proposed.entry_event);
  row('Success event',old?.success_event,proposed.success_event);
  row('Population unit',old?.unit,proposed.unit);
  row('Session population rule',old?'First qualifying entry, then entry exclusion; device frozen at entry':null,'First qualifying entry, then entry exclusion; device frozen at entry');
  row('Earlier period start — included',old?.windows.baseline.start,proposed.windows.baseline.start);
  row('Earlier period end — excluded',old?.windows.baseline.end,proposed.windows.baseline.end);
  row('Later period start — included',old?.windows.comparison.start,proposed.windows.comparison.start);
  row('Later period end — excluded',old?.windows.comparison.end,proposed.windows.comparison.end);
  row('Conversion time window',old?`${old.horizon_seconds} seconds`:null,`${proposed.horizon_seconds} seconds`);
  row('Exclusion rule',old?.exclusion_rule,proposed.exclusion_rule);
  row('Group property',old?.segment_property,proposed.segment_property);
  row('Entry-time groups',old?.cohorts.join(', '),proposed.cohorts.join(', '));
  row('Window timezone',old?.timezone,proposed.timezone);
  row('Snapshot identity',previous?.snapshot_id,proposedSnapshot?.id);
  row('Snapshot content hash',previousSnapshot?.content_hash ?? previousSnapshot?.snapshot_hash,proposedSnapshot?.content_hash ?? proposedSnapshot?.snapshot_hash);
  row('Snapshot source',previousSnapshot?.source_id,proposedSnapshot?.source_id);
  row('Completeness and observation tail',coverage(previousSnapshot),coverage(proposedSnapshot));
  return rows;
}
export function MetricContractDiff({previous,proposed,previousSnapshot,proposedSnapshot,priorKnown=true}: {previous:MetricRecord|null;proposed:Metric;previousSnapshot:Snapshot|null;proposedSnapshot:Snapshot|null;priorKnown?:boolean}) {
  const rows=metricContractDiff(previous,proposed,previousSnapshot,proposedSnapshot),changed=rows.filter(row=>row.status==='Changed').length;
  return <section aria-label="Metric and source contract comparison"><h3>Previous frozen inputs versus proposed inputs</h3>{previous?<p>Previous metric {previous.id} · Input revision {previous.revision_id ?? 'unknown'} · {changed} changed fields shown.</p>:<p className="notice">{priorKnown?'No prior frozen metric is recorded. Earlier values are unknown; this is an initial contract review.':'Prior frozen contract has not been selected. Choose the exact earlier version; earlier values remain unknown.'}</p>}<p className="fine-print">UTC windows are half-open: starts included, ends excluded. Completeness declarations preserve their attestation or lateness limits. Freezing creates a new input revision and makes dependent earlier claims stale, even when these fields are unchanged.</p><div className="table-scroll" role="region" aria-label="Metric contract differences" tabIndex={0}><table><thead><tr><th>Counting or source field</th><th>Previous frozen value</th><th>Proposed value</th><th>Comparison</th></tr></thead><tbody>{rows.map(row=><tr key={row.field}><th scope="row">{row.field}</th><td>{row.previous}</td><td>{row.proposed}</td><td>{row.status}</td></tr>)}</tbody></table></div></section>;
}
