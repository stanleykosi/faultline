import type {Comparison, Metric, MetricResult} from '../data/types';

export type TestKind = 'data_quality' | 'cohort_change' | 'mix_shift' | 'temporal_alignment' | 'negative_control' | 'mechanism' | 'correction';
export type AnalyticKind = Exclude<TestKind, 'mechanism' | 'correction'>;
export const testLabels: Record<TestKind, string> = {data_quality: 'Data quality', cohort_change: 'Change within groups', mix_shift: 'Traffic composition', temporal_alignment: 'Release-time alignment', negative_control: 'Unaffected group check', mechanism: 'Reproduce the issue — runner required', correction: 'Check the fix — runner required'};
export interface Evidence {
  id: string; workspace_id: string; case_id: string; revision_id: string; snapshot_id: string | null;
  source_kind: string; source_ref: string; content_hash: string; captured_at: string;
  event_time: {kind: 'exact'; at: string} | {kind: 'range'; start: string; end: string} | {kind: 'unknown'; raw_description: string};
  text: string; redaction_status: 'sanitized' | 'restricted' | 'withdrawn'; evidence_status: string;
  supersedes_id: string | null; resource_revision?: number; revision?: number;
  freshness?: 'fresh' | 'stale';
  artifact_refs?: {artifact_id: string; sha256: string; size_bytes: number; media_type: string; redaction_status: 'sanitized' | 'restricted' | 'withdrawn'}[];
  annotations?: {kind: string; related_evidence_ids: string[]; reason?: string; actor_id?: string; created_at?: string}[];
}
export interface Hypothesis {
  id: string; revision_id: string; title: string; statement: string; mechanism_description: string; falsifier: string;
  supporting_evidence_ids: string[]; contradicting_evidence_ids: string[]; missing_evidence: string[];
  proposed_test_kinds: TestKind[]; origin: string; status: 'proposed' | 'accepted' | 'rejected' | 'needs_evidence';
  priority: 'low' | 'normal' | 'high'; resource_revision: number;
}
export interface Binding {workspace_id: string; case_id: string; revision_id: string; metric_hash: string; snapshot_hash: string;}
export interface AnalysisContext {binding: Binding; metric: Metric; comparison: Comparison | null; case_revision?: number; capabilities: {model: string; external_runner: string};}
export interface AnalyticPlan extends Binding {schema_version: 1; id: string; hypothesis_id: string; kind: AnalyticKind; evidence_ids: string[]; cohorts: string[]; expected_direction: 'increase' | 'decrease' | 'unchanged' | 'unknown'; minimum_denominator: number; purpose: string;}
export interface PlanRecord {id: string; value: AnalyticPlan; plan_hash: string;}
export interface AnalyticRecord {id: string; value: {kind: AnalyticKind; outcome: 'passed' | 'failed' | 'blocked' | 'inconclusive'; freshness: 'fresh' | 'stale'; reasons: string[]; limitations: string[]; details: Record<string, unknown>; result_hash?: string; revision_id: string;};}
export interface Claim {association: string; mechanism: string; correction: string; freshness: string; coverage_quality: string; scope: string; warning: string | null; attribution: {scope: 'association_only'; causal_effect: 'not_established'};}
export interface Finding {text: string; evidence_ids: string[]; test_result_ids: string[];}
export interface Report {id: string; revision_id: string; title: string; status: 'draft' | 'published' | 'superseded' | 'withdrawn'; created_at: string; metric_hash: string; snapshot_hash: string; claim: Claim; findings: Finding[]; alternatives: string[]; limitations: string[]; recommended_actions: string[]; input_manifest_hash: string;}
export interface ReportRecord {id: string; value?: Report; revision?: number; freshness?: 'fresh' | 'stale'; status?: string; reason?: string;}
export interface ExportRecord {id: string; download_url: string; manifest: {signer_key_id?: string; files?: {path: string; sha256: string; size_bytes: number}[]; [key: string]: unknown}; signature: string;}
export interface Comment {id: string; actor_id: string; text: string | null; evidence_ids: string[]; revision: number; tombstone: boolean; created_at: string; updated_at: string;}
export interface FollowUp {id: string; revision: number; revision_id: string; state: 'scheduled' | 'waiting_for_data' | 'compared' | 'cancelled'; freshness?: 'fresh' | 'stale'; current_state?: string; created_at: string; value: {trigger_mode: 'manual' | 'due_check'; due_at: string | null; metric_hash: string; comparison_start: string; comparison_end: string; source_ids: string[]; export_declaration_ids: string[]; rollout_evidence_id: string | null; note: string; original_snapshot_id: string; metric_id: string;}; result: null | {snapshot_id?: string; snapshot_hash?: string; metric_hash?: string; followup_metric_hash?: string; value?: MetricResult; mode: 'observational'; causal_effect: 'not_established'; reason?: string; missing_data_notified_at?: string | null};}
export function lines(text: string): string[] {return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);}
export function selected(form: FormData, name: string): string[] {return [...new Set(form.getAll(name).map(String))];}
export function revisionOf(evidence: Evidence): number | undefined {return evidence.resource_revision ?? evidence.revision;}
