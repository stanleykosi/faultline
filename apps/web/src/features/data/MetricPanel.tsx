import { useEffect, useRef, useState, type FormEvent } from 'react';
import {ApiError, casePath, resource} from '../../api';
import { commandKey, type CommandIdentity } from '../../command-key';
import { ErrorNotice, Field, Modal, Status, formError } from '../../ui';
import { CoverageSummary, RateTable, SourceRows } from './Presentation';
import {safeId, utcInput, utcInstant, type Coverage, type Metric, type MetricPreview, type MetricRecord, type Snapshot} from './types';
import type {SelectionInvestigation} from './SnapshotSelection';
import {MetricContractDiff} from './MetricContractDiff';

export type MetricFreezeFacts = {base: string; investigation: SelectionInvestigation; metric: MetricRecord | null; snapshot: Snapshot | null; canMutate: boolean; metadataAvailable: boolean};
export type MetricFreezeReview = {
  base: string; case_revision: number; active_revision_id: string; snapshot_bundle_hash: string | null;
  metric_id: string; metric_hash: string; metric: Metric; snapshot_id: string; snapshot_hash: string; source_id: string;
  acknowledged_assumptions: string[]; coverage?: Coverage;
};
const sha = /^[a-f0-9]{64}$/;
export function pinMetricFreezeReview(facts: MetricFreezeFacts): MetricFreezeReview {
  const {investigation, metric, snapshot} = facts, selection = investigation.snapshot_selection;
  const unavailable = snapshot as (Snapshot & {withdrawn?: boolean; retention_expired?: boolean}) | null;
  if (!facts.canMutate || !facts.metadataAvailable || investigation.archived || investigation.lifecycle !== 'open'
    || !safeId(investigation.id) || !safeId(investigation.workspace_id) || !safeId(investigation.active_revision_id)
    || !Number.isSafeInteger(investigation.revision) || investigation.revision < 1 || facts.base !== casePath(investigation.workspace_id, investigation.id)
    || !metric || metric.state !== 'draft' || !safeId(metric.id) || !sha.test(metric.metric_hash)
    || !snapshot || !safeId(snapshot.id) || !safeId(snapshot.source_id) || snapshot.source_id !== metric.value.source_id
    || (snapshot.record_kind ?? snapshot.record_type ?? snapshot.kind ?? 'analytics') !== 'analytics' || unavailable?.withdrawn || unavailable?.retention_expired
    || !sha.test(snapshot.content_hash ?? snapshot.snapshot_hash ?? '')) {
    throw new Error('Refresh the permitted current case, metric draft and retained matching snapshot before reviewing a freeze.');
  }
  if (selection === undefined || selection !== null && (selection.revision_id !== investigation.active_revision_id || !sha.test(selection.snapshot_bundle_hash))) {
    throw new Error('Refresh the investigation and selected data before locking the metric.');
  }
  return {
    base: facts.base, case_revision: investigation.revision, active_revision_id: investigation.active_revision_id, snapshot_bundle_hash: selection?.snapshot_bundle_hash ?? null,
    metric_id: metric.id, metric_hash: metric.metric_hash, metric: structuredClone(metric.value), snapshot_id: snapshot.id, snapshot_hash: (snapshot.content_hash ?? snapshot.snapshot_hash)!, source_id: snapshot.source_id,
    acknowledged_assumptions: [...snapshot.coverage?.assumptions ?? []], ...(snapshot.coverage ? {coverage: structuredClone(snapshot.coverage)} : {})
  };
}
function reviewSignature(review: MetricFreezeReview): string {
  // The server hashes remain authoritative; this is only local consent invalidation.
  return JSON.stringify([review.base, review.case_revision, review.active_revision_id, review.snapshot_bundle_hash, review.metric_id, review.metric_hash,
    review.snapshot_id, review.snapshot_hash, review.source_id, review.acknowledged_assumptions, review.coverage ?? null]);
}
export function metricFreezeReviewCurrent(review: MetricFreezeReview, facts: MetricFreezeFacts): boolean {
  try {return reviewSignature(review) === reviewSignature(pinMetricFreezeReview(facts));} catch {return false;}
}
export async function submitMetricFreezeReview(review: MetricFreezeReview, facts: MetricFreezeFacts, csrf: string, acknowledged: boolean, identity: {current: CommandIdentity}) {
  if (!acknowledged) throw new Error('Review and acknowledge the exact frozen inputs before submitting.');
  if (!metricFreezeReviewCurrent(review, facts)) throw new ApiError(409, 'STALE_METRIC_REVIEW', 'The investigation or selected data changed. Review the current inputs before locking the metric.');
  const path = `${review.base}/metrics/${encodeURIComponent(review.metric_id)}/freeze`, body = {snapshot_id: review.snapshot_id, metric_hash: review.metric_hash, acknowledged_assumptions: [...review.acknowledged_assumptions]};
  const record = await resource<{id: string; state: string; revision_id: string; metric_hash: string; snapshot_id: string}>(path, {method: 'POST', csrf, revision: review.case_revision, body, idempotencyKey: commandKey(identity, {path, method: 'POST', revision: review.case_revision, body})});
  if (record?.id !== review.metric_id || record.state !== 'frozen' || record.metric_hash !== review.metric_hash || record.snapshot_id !== review.snapshot_id
    || !safeId(record.revision_id ?? '') || record.revision_id === review.active_revision_id) throw new Error('The server did not return the reviewed frozen metric and a new investigation revision. Refresh recorded state.');
  identity.current = null; return record;
}
export function MetricFreezeReviewSummary({review, onRefresh, pending = false}: {review: MetricFreezeReview; onRefresh?: () => Promise<void>; pending?: boolean}) {
  return <><details><summary>Input identifiers and hashes</summary><dl className="binding-list"><div><dt>Metric</dt><dd>{review.metric_id}</dd></div><div><dt>Metric hash</dt><dd>{review.metric_hash}</dd></div><div><dt>Snapshot</dt><dd>{review.snapshot_id}</dd></div><div><dt>Snapshot hash</dt><dd>{review.snapshot_hash}</dd></div><div><dt>Reviewed case revision</dt><dd>{review.case_revision}</dd></div><div><dt>Reviewed active revision</dt><dd>{review.active_revision_id}</dd></div><div><dt>Reviewed snapshot bundle hash</dt><dd>{review.snapshot_bundle_hash ?? 'No saved bundle'}</dd></div></dl></details>{onRefresh && <button className="secondary" type="button" onClick={() => {void onRefresh();}} disabled={pending}>Refresh recorded inputs</button>}</>;
}

type MetricFields = {source_id: string; entry_event: string; success_event: string; cohorts: string; baseline_start: string; baseline_end: string; comparison_start: string; comparison_end: string;};
// Read the displayed controls before a pending render disables the fieldset.
// Browser date editing and autofill need not have committed a React change event.
export function metricFromFormData(values: FormData): Metric {
  function text(name: keyof MetricFields): string {
    const value = values.get(name);
    if (typeof value !== 'string') throw new Error(`Missing metric field: ${name}.`);
    return value;
  }
  const source_id = text('source_id'), entry_event = text('entry_event').trim(), success_event = text('success_event').trim();
  if (!source_id.trim() || !entry_event || !success_event) throw new Error('Choose an analytics source and enter both event names.');
  const cohorts = text('cohorts').split(',').map(cohort => cohort.trim()).filter(Boolean);
  if (cohorts.length < 1 || cohorts.length > 8 || new Set(cohorts).size !== cohorts.length) throw new Error('Choose one to eight unique device groups.');
  const metric: Metric = {version: 1, template: 'session_conversion_v1', source_id, unit: 'session', entry_event, success_event, horizon_seconds: 1800, segment_property: 'device', cohorts, windows: {baseline: {start: utcInstant(text('baseline_start')), end: utcInstant(text('baseline_end'))}, comparison: {start: utcInstant(text('comparison_start')), end: utcInstant(text('comparison_end'))}}, exclusion_rule: 'entry_excluded_false', timezone: 'UTC'};
  if (metric.windows.baseline.start >= metric.windows.baseline.end || metric.windows.comparison.start >= metric.windows.comparison.end) throw new Error('Each UTC window end must follow its start.');
  return metric;
}
const emptyFields: MetricFields = {source_id: '', entry_event: '', success_event: '', cohorts: '', baseline_start: '', baseline_end: '', comparison_start: '', comparison_end: ''};
const fieldsFrom = (metric: Metric): MetricFields => ({source_id: metric.source_id, entry_event: metric.entry_event, success_event: metric.success_event, cohorts: metric.cohorts.join(', '), baseline_start: utcInput(metric.windows.baseline.start), baseline_end: utcInput(metric.windows.baseline.end), comparison_start: utcInput(metric.windows.comparison.start), comparison_end: utcInput(metric.windows.comparison.end)});

export function MetricPanel({base, csrf, investigation, snapshots, metrics, selectedMetricId, selectedSnapshotId, canMutate, onMetric, onSnapshot, onFrozen, onCompare, onRefresh, metadataAvailable = true}: {metadataAvailable?: boolean; base: string; csrf: string; investigation: SelectionInvestigation; snapshots: Snapshot[]; metrics: MetricRecord[]; selectedMetricId: string; selectedSnapshotId: string; canMutate: boolean; onMetric: (id: string, record?: MetricRecord) => void; onSnapshot: (id: string) => void; onFrozen: (id: string) => Promise<void>; onCompare: (revisionId: string) => Promise<void>; onRefresh?: () => Promise<void>}) {
  const selected = metrics.find(metric => metric.id === selectedMetricId) ?? null;
  const priorFrozen = metrics.filter(metric => metric.state === 'frozen' && metric.id !== (selected?.state === 'draft' ? selected.id : ''));
  const [priorMetricId, setPriorMetricId] = useState('');
  const currentFrozen = priorFrozen.find(metric => metric.revision_id === investigation.active_revision_id);
  const priorMetric = priorFrozen.find(metric => metric.id === priorMetricId) ?? currentFrozen ?? (priorFrozen.length === 1 ? priorFrozen[0] : null);
  const priorSnapshot = snapshots.find(snapshot => snapshot.id === priorMetric?.snapshot_id) ?? null;
  const [fields, setFields] = useState<MetricFields>(emptyFields), [error, setError] = useState<Error | null>(null), [pending, setPending] = useState('');
  const [preview, setPreview] = useState<MetricPreview | null>(null), [reviewFreeze, setReviewFreeze] = useState(false), [acknowledged, setAcknowledged] = useState(false);
  const [freezeReviewBinding, setFreezeReviewBinding] = useState<MetricFreezeReview | null>(null);
  const createCommand = useRef<CommandIdentity>(null), previewCommand = useRef<CommandIdentity>(null), freezeCommand = useRef<CommandIdentity>(null);
  const freezeInFlight = useRef(false), refreshInFlight = useRef(false);
  const reviewSnapshot = snapshots.find(item => item.id === selectedSnapshotId) ?? null;
  const freezeFacts: MetricFreezeFacts = {base, investigation, metric: selected, snapshot: reviewSnapshot, canMutate, metadataAvailable};
  const reviewCurrent = !!freezeReviewBinding && metricFreezeReviewCurrent(freezeReviewBinding, freezeFacts);
  useEffect(() => {if (reviewFreeze && !reviewCurrent) setAcknowledged(false);}, [reviewFreeze, reviewCurrent]);
  useEffect(() => {if (selected) setFields(fieldsFrom(selected.value)); setPreview(null); setAcknowledged(false);}, [selected?.id]);
  useEffect(() => {setPreview(null); setAcknowledged(false);}, [selectedSnapshotId]);
  useEffect(() => {setAcknowledged(false);}, [priorMetricId]);
  // Keep entered draft fields in memory while prerequisite reads are unavailable.
  if (!metadataAvailable) return null;
  const analyticsSnapshots = snapshots.filter(snapshot => (snapshot.record_kind ?? snapshot.record_type ?? snapshot.kind ?? 'analytics') === 'analytics');
  const sourceIds = [...new Set(analyticsSnapshots.map(snapshot => snapshot.source_id))];
  if (fields.source_id && !sourceIds.includes(fields.source_id)) sourceIds.push(fields.source_id);
  const snapshot = analyticsSnapshots.find(item => item.id === selectedSnapshotId), sourceMatches = !!snapshot && !!selected && snapshot.source_id === selected.value.source_id;
  const frozen = selected?.state === 'frozen', currentRevision = frozen && selected.revision_id === investigation.active_revision_id;
  if (!selected && sourceIds.length === 0) return <section className="panel metric-panel"><h2>Conversion metric</h2><p>{canMutate ? "Upload session data first." : "No session data is available."}</p></section>;
  function field(name: keyof MetricFields, value: string) {setFields(previous => ({...previous, [name]: value}));}
  function newDraft() {if (selected) setFields(fieldsFrom(selected.value)); onMetric(''); setPreview(null); setError(null);}
  function openFreezeReview() {try {const binding = pinMetricFreezeReview(freezeFacts); setFreezeReviewBinding(binding); setAcknowledged(false); setReviewFreeze(true); setError(null);} catch (cause) {setError(formError(cause));}}
  async function refreshReviewedInputs() {
    if (!onRefresh || refreshInFlight.current || freezeInFlight.current) return;
    refreshInFlight.current = true; setAcknowledged(false); setPending('Reading current metric inputs…'); setError(null);
    try {await onRefresh();} catch (cause) {setError(formError(cause));} finally {refreshInFlight.current = false; setPending('');}
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    try {
      const metric = metricFromFormData(new FormData(event.currentTarget));
      setPending('Saving metric draft…');
      const path = `${base}/metrics`, body = {metric}; const record = await resource<MetricRecord>(path, {method: 'POST', csrf, body, idempotencyKey: commandKey(createCommand, {path, method: 'POST', body})}); createCommand.current = null; onMetric(record.id, record);
    } catch (cause) {setError(formError(cause));} finally {setPending('');}
  }
  async function previewMetric() {
    if (!selected || !sourceMatches) return; setPending('Counting diagnostic sessions…'); setError(null);
    try {const path = `${base}/metrics/${encodeURIComponent(selected.id)}/preview`, body = {snapshot_id: selectedSnapshotId}; setPreview(await resource<MetricPreview>(path, {method: 'POST', csrf, body, idempotencyKey: commandKey(previewCommand, {path, method: 'POST', body})})); previewCommand.current = null;}
    catch (cause) {setError(formError(cause));} finally {setPending('');}
  }
  async function freeze() {
    if (!freezeReviewBinding || !acknowledged || freezeInFlight.current || refreshInFlight.current) return; freezeInFlight.current = true; setPending('Freezing reviewed metric inputs…'); setError(null);
    try {
      const record = await submitMetricFreezeReview(freezeReviewBinding, freezeFacts, csrf, acknowledged, freezeCommand); setReviewFreeze(false); setFreezeReviewBinding(null); setAcknowledged(false); await onFrozen(record.id);
    } catch (cause) {setError(formError(cause)); if (cause instanceof ApiError && cause.status === 409) setAcknowledged(false);} finally {freezeInFlight.current = false; setPending('');}
  }
  async function compare() {if (!selected?.revision_id || !currentRevision) return; setPending('Queuing frozen comparison…'); setError(null); try {await onCompare(selected.revision_id);} catch (cause) {setError(formError(cause));} finally {setPending('');}}
  const quality = typeof preview?.quality === 'string' ? preview.quality : preview?.quality.quality;
  return <section className="panel metric-panel"><div className="section-heading"><div><h2>Conversion metric</h2></div>{selected && <Status>{selected.state}</Status>}</div><p className="fine-print">Session conversion · success within 30 minutes of entry.</p><ErrorNotice error={error} /><div className="metric-selection"><Field label="Metric"><select value={selectedMetricId} onChange={event => onMetric(event.target.value)}><option value="">Create a new metric</option>{metrics.map(metric => <option value={metric.id} key={metric.id}>{metric.state} · {metric.value.entry_event} → {metric.value.success_event} · {metric.id.slice(0, 8)}</option>)}</select></Field>{selected && canMutate && <button className="secondary" onClick={newDraft}>Copy as new metric</button>}</div>{canMutate ? <details open={!selected}><summary>{selected ? "Metric definition" : "Define the metric"}</summary><form onSubmit={save}><fieldset disabled={!!selected || !!pending} className="metric-fields"><div className="date-pair"><Field label="Analytics source"><select name="source_id" value={fields.source_id} onChange={event => field('source_id', event.target.value)} required><option value="">Choose a captured source</option>{sourceIds.map(source => <option value={source} key={source}>{source}</option>)}</select></Field><Field label="Device groups" hint="One to eight exact entry-time device values, separated by commas."><input name="cohorts" value={fields.cohorts} onChange={event => field('cohorts', event.target.value)} required maxLength={520} placeholder="For example, mobile, desktop" /></Field></div><div className="date-pair"><Field label="Entry event"><input name="entry_event" value={fields.entry_event} onChange={event => field('entry_event', event.target.value)} required maxLength={128} placeholder="Exact qualifying entry event" /></Field><Field label="Success event"><input name="success_event" value={fields.success_event} onChange={event => field('success_event', event.target.value)} required maxLength={128} placeholder="Exact conversion event" /></Field></div><div className="window-grid"><section><h3>Earlier period · UTC</h3><Field label="Earlier period starts (included)"><input name="baseline_start" type="datetime-local" step="1" required value={fields.baseline_start} onChange={event => field('baseline_start', event.target.value)} /></Field><Field label="Earlier period ends (excluded)"><input name="baseline_end" type="datetime-local" step="1" required value={fields.baseline_end} onChange={event => field('baseline_end', event.target.value)} /></Field></section><section><h3>Later period · UTC</h3><Field label="Later period starts (included)"><input name="comparison_start" type="datetime-local" step="1" required value={fields.comparison_start} onChange={event => field('comparison_start', event.target.value)} /></Field><Field label="Later period ends (excluded)"><input name="comparison_end" type="datetime-local" step="1" required value={fields.comparison_end} onChange={event => field('comparison_end', event.target.value)} /></Field></section></div><details className="metric-semantics"><summary>How sessions are counted</summary><p>Date ranges use UTC and exclude the end time. Each session uses its first matching entry. Excluded entries stay excluded. Success must happen within 30 minutes. Device is set when the session enters.</p></details>{!selected && <button className="primary" type="submit" disabled={!sourceIds.length || !!pending}>{pending || 'Save metric draft'}</button>}</fieldset></form></details> : selected ? <dl className="binding-list"><div><dt>Source</dt><dd>{selected.value.source_id}</dd></div><div><dt>Events</dt><dd>{selected.value.entry_event} → {selected.value.success_event}</dd></div><div><dt>Earlier period</dt><dd>{selected.value.windows.baseline.start} → {selected.value.windows.baseline.end}</dd></div><div><dt>Comparison</dt><dd>{selected.value.windows.comparison.start} → {selected.value.windows.comparison.end}</dd></div></dl> : <p className="notice">An owner or analyst can define the metric. Your viewer role can inspect saved inputs and results.</p>}{selected && <div className="metric-execution">{priorFrozen.length > 1 && <Field label="Previous frozen contract for comparison"><select value={priorMetric?.id ?? ''} onChange={event => setPriorMetricId(event.target.value)} disabled={!!pending}><option value="">Choose the exact earlier contract</option>{priorFrozen.map(metric => <option key={metric.id} value={metric.id}>{metric.id} · revision {metric.revision_id ?? 'unknown'}</option>)}</select></Field>}<details><summary>Compare previous metric inputs</summary><MetricContractDiff previous={priorMetric} proposed={selected.value} previousSnapshot={priorSnapshot} proposedSnapshot={snapshot ?? null} priorKnown={priorFrozen.length === 0 || !!priorMetric}/></details><Field label="Saved data" hint="Choose data from the same source."><select value={selectedSnapshotId} onChange={event => onSnapshot(event.target.value)} disabled={!!pending}><option value="">Choose saved data</option>{analyticsSnapshots.filter(item => item.source_id === selected.value.source_id).map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 12)} · {item.source_mode ?? 'mode unavailable'} · {item.record_count ?? 'unknown'} records</option>)}</select></Field>{snapshot && <CoverageSummary coverage={snapshot.coverage} />}{!sourceMatches && <p className="notice warning">Choose saved data from the same source before previewing or locking the metric.</p>}{canMutate && <div className="action-row"><button className="secondary" onClick={previewMetric} disabled={!sourceMatches || !!pending}>Preview counts</button>{!frozen && <button className="primary" onClick={openFreezeReview} disabled={!sourceMatches || !!pending}>Review and lock metric</button>}{frozen && <button className="primary" onClick={compare} disabled={!currentRevision || !!pending}>{pending || 'Run comparison'}</button>}</div>}{frozen && !currentRevision && <p className="notice warning">These inputs changed. Review and lock the current metric before testing.</p>}<details><summary>Metric details</summary><pre>{JSON.stringify({id: selected.id, metric_hash: selected.metric_hash, snapshot_id: selected.snapshot_id ?? null, revision_id: selected.revision_id ?? null, value: selected.value}, null, 2)}</pre></details></div>}{preview && <section className="diagnostic-preview"><div className="section-heading"><h3>Preview counts</h3><Status tone="warning">{quality ?? 'Quality unknown'}</Status></div><p className="fine-print">Preview only. Coverage and the frozen comparison remain separate.</p><RateTable baseline={preview.preview.baseline} comparison={preview.preview.comparison} />{typeof preview.quality !== 'string' && preview.quality.reason && <p className="notice warning">{preview.quality.reason.replaceAll('_', ' ')}</p>}{preview.preview.limitations?.map((limitation, index) => <p className="fine-print" key={index}>{limitation}</p>)}{preview.preview.samples && <details><summary>Inspect actual counted-session samples</summary>{Object.entries(preview.preview.samples).map(([window, rows]) => <section key={window}><h3>{window}</h3><SourceRows rows={rows} title={`${window} counted sessions`} /></section>)}</details>}</section>}{reviewFreeze && freezeReviewBinding && <Modal title="Review frozen metric inputs" onClose={() => {if (!pending) setReviewFreeze(false);}}><ErrorNotice error={error} /><p className="muted">Lock these inputs for testing. Earlier findings will become outdated.</p><MetricContractDiff previous={priorMetric} proposed={freezeReviewBinding.metric} previousSnapshot={priorSnapshot} proposedSnapshot={{id:freezeReviewBinding.snapshot_id,source_id:freezeReviewBinding.source_id,content_hash:freezeReviewBinding.snapshot_hash,coverage:freezeReviewBinding.coverage}} priorKnown={priorFrozen.length === 0 || !!priorMetric}/><MetricFreezeReviewSummary review={freezeReviewBinding} onRefresh={onRefresh ? refreshReviewedInputs : undefined} pending={!!pending} /><CoverageSummary coverage={freezeReviewBinding.coverage} />{!reviewCurrent && <div className="notice warning" role="status"><strong>These reviewed inputs changed</strong><p>The current case revision, saved snapshot bundle or selected input binding differs from this review. The earlier acknowledgment is cleared. Review the current inputs again before freezing.</p><button className="secondary" type="button" onClick={openFreezeReview} disabled={!!pending || !canMutate}>Review current inputs again</button></div>}<label className="review-checkbox"><input type="checkbox" checked={acknowledged && reviewCurrent} disabled={!!pending || !reviewCurrent} onChange={event => setAcknowledged(reviewCurrent && event.target.checked)} />I reviewed the exact source, windows, observation tail, and displayed completeness assumptions. Human attestation and late-arrival assumptions retain their stated limits.</label><div className="form-actions"><button className="secondary" onClick={() => setReviewFreeze(false)} disabled={!!pending}>Cancel</button><button className="primary" onClick={freeze} disabled={!acknowledged || !reviewCurrent || !!pending}>{pending || 'Freeze reviewed inputs'}</button></div></Modal>}</section>;
}
