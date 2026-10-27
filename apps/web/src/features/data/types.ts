export type RecordKind = 'analytics' | 'support' | 'release';
export interface CoverageDeclaration {
  basis: 'operator_attestation' | 'lateness_assumption' | 'none';
  event_time_intervals: {start: string; end: string}[];
  declared_event_watermark: string | null; statement: string; reference_evidence_ids: string[]; late_arrival_hours: number;
}
export interface Coverage {
  extraction_status: 'complete' | 'partial' | 'unknown'; basis: string; covered_start: string | null; covered_end: string | null;
  event_watermark: string | null; attestation: string; event_time_intervals: {start: string; end: string}[]; assumptions?: string[];
}
export interface ImportRecord {
  id: string; source_id: string; record_kind: RecordKind; stage: string; mapping_id?: string | null;
  mapping?: {id: string; value: import('./mapping').ImportMapping; mapping_hash: string};
  counts?: Record<string, number>; issues?: {id?: string; row?: number; code: string; message: string; severity?: string}[];
  can_finalize?: boolean; hashes?: Record<string, string>; preview_rows?: Record<string, unknown>[];
  declared_source_namespace?: string | null; logical_source_id?: string; snapshot_id?: string | null; job_id?: string | null;
}
export interface Snapshot {
  id: string; source_id: string; record_kind?: RecordKind; record_type?: RecordKind; kind?: RecordKind;
  coverage?: Coverage; source_mode?: 'file' | 'fixture' | 'live'; content_hash?: string; snapshot_hash?: string;
  record_count?: number; created_at?: string; captured_at?: string;
}
export interface Metric {
  version: 1; template: 'session_conversion_v1'; source_id: string; unit: 'session'; entry_event: string; success_event: string;
  horizon_seconds: 1800; segment_property: 'device'; cohorts: string[];
  windows: {baseline: {start: string; end: string}; comparison: {start: string; end: string}};
  exclusion_rule: 'entry_excluded_false'; timezone: 'UTC';
}
export interface MetricRecord {id: string; value: Metric; metric_hash: string; state: string; snapshot_id?: string | null; revision_id?: string;}
export interface Rate {eligible: number; converted: number; rate: number | null; interval: {low: number; high: number; level: number; method: string} | null;}
export interface PeriodResult extends Rate {strata: Record<string, Rate>; unknown_cohort_count: number;}
export interface MetricResult {metric_hash: string; quality: 'complete_attested' | 'provisional' | 'incomplete'; basis: string; baseline: PeriodResult | null; comparison: PeriodResult | null; delta_pp: number | null; relative_change: number | null; reason?: string;}
export interface MixResult {status: string; standardized_rate: number | null; within_component_pp: number | null; composition_component_pp: number | null; baseline_weights: Record<string, number>; missing_comparison_strata: string[]; comparison_only_strata: string[]; limitations: string[]; reason?: string;}
export interface Comparison {id: string; revision_id: string; metric_hash: string; snapshot_hash: string; value: MetricResult; mix: MixResult; freshness: 'fresh' | 'stale';}
export interface MetricPreview {preview: {baseline: PeriodResult; comparison: PeriodResult; samples?: Record<string, Record<string, unknown>[]>; limitations?: string[]}; quality: {quality: string; reason?: string} | string;}
export interface Job {id: string; case_id?: string; status: string; result: {snapshot_id?: string; comparison_id?: string; [key: string]: unknown} | null; error_code?: string | null; updated_at?: string; attempt?: number;}
export interface AcceptedJob {job_id: string; status: string; events_url?: string; result_url?: string;}

export function utcInput(value: string): string {return value.replace(/Z$/, '');}
export function utcInstant(value: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) throw new Error('Enter each boundary as a valid UTC date and time.');
  const parsed = new Date(value + 'Z'); if (!Number.isFinite(parsed.getTime())) throw new Error('A UTC date or time is invalid.'); return parsed.toISOString();
}
export function rateLabel(value: number | null | undefined): string {return value === null || value === undefined ? 'Unknown' : `${(value * 100).toLocaleString(undefined, {maximumFractionDigits: 2})}%`;}
export function pointsLabel(value: number | null | undefined): string {return value === null || value === undefined ? 'Unknown' : `${value > 0 ? '+' : ''}${value.toLocaleString(undefined, {maximumFractionDigits: 2})} pp`;}
export function safeId(value: string | null): string {return value && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value) ? value : '';}
