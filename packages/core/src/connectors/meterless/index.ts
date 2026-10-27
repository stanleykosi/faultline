import {performance} from 'node:perf_hooks';
import {hash} from '../../canonical.js';
import {DomainError, demand} from '../../errors.js';
import {HMEM} from './vendor/hmem/src/index.js';
import type {FeedbackKind as HmemFeedbackKind} from './vendor/hmem/src/types.js';

export const METERLESS_ADAPTER_VERSION = 'faultline-meterless-v1';
export const METERLESS_HMEM_COMMIT = '0aa7417ba5c826396d91e891328be78c45e6fbf6';
export const METERLESS_RETRIEVAL_THRESHOLD = 0.2;

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_MEMORY_BYTES = 64 * 1024;

export interface InvestigationFinding {
  text: string;
  evidence_ids: string[];
}

export interface InvestigationClaimAxes {
  association: 'observed' | 'not_observed' | 'unknown';
  mechanism: 'reproduced' | 'not_reproduced' | 'inconclusive' | 'untested';
  correction: 'validated' | 'not_validated' | 'inconclusive' | 'not_tested';
  causal_effect: 'not_established';
}

/** Immutable, user-accepted investigation knowledge. Authority is resolved by PostgreSQL. */
export interface InvestigationCapsuleContent {
  schema_version: 1;
  status: 'accepted';
  capsule_id: string;
  workspace_id: string;
  source_case_id: string;
  published_report_id: string;
  revision_id: string;
  report_hash: string;
  metric_hash: string;
  snapshot_hash: string;
  evidence_hashes: string[];
  affected_flow: string;
  cohort_keys: string[];
  release_refs: string[];
  accepted_findings: InvestigationFinding[];
  rejected_or_unresolved_alternatives: string[];
  falsifiers: string[];
  control_observations: string[];
  test_prerequisites: string[];
  oracle_version: string | null;
  claim_axes: InvestigationClaimAxes;
  limitations: string[];
  follow_up_outcome: string | null;
  created_by: string;
  accepted_at: string;
}

export interface InvestigationCapsuleAuthority {
  workspace_id: string;
  current_revision_id: string;
  current_metric_hash: string;
  current_snapshot_hash: string;
  current_report_hash: string;
  capsule_hash: string;
  withdrawn: boolean;
  deleted: boolean;
}

export interface InvestigationCapsule extends InvestigationCapsuleContent {
  capsule_hash: string;
  authority: InvestigationCapsuleAuthority;
}

export interface MemoryRetrievalQuery {
  workspace_id: string;
  catalog_generation: string;
  text: string;
  max_results?: number;
  /** Optional latest PostgreSQL projection used to re-resolve engine candidates. */
  current_capsules?: readonly InvestigationCapsule[];
}

export type MeterlessRejectionReason =
  | 'foreign_workspace'
  | 'withdrawn'
  | 'deleted'
  | 'capsule_hash_mismatch'
  | 'stale_revision'
  | 'stale_metric'
  | 'stale_snapshot'
  | 'stale_report'
  | 'catalog_hash_changed'
  | 'not_authoritative'
  | 'unmapped_engine_id';

export interface MeterlessRejectedCapsule {
  capsule_id: string;
  reason: MeterlessRejectionReason;
}

export interface MeterlessTraceEntry {
  operation: 'add' | 'query' | 'feedback';
  adapter_version: typeof METERLESS_ADAPTER_VERSION;
  workspace_id: string;
  catalog_generation: string;
  input_hash: string;
  input_bytes: number;
  latency_ms: number;
  redacted: true;
  capsule_id?: string;
  capsule_hash?: string;
  query_hash?: string;
  feedback_kind?: MemoryFeedbackKind;
  returned_capsule_ids?: string[];
}

export interface MeterlessMetrics {
  latency_ms: number;
  input_bytes: number;
  indexed_count: number;
  engine_candidates: number;
  returned_count: number;
}

export interface MemoryRetrievalResult {
  adapter_version: typeof METERLESS_ADAPTER_VERSION;
  workspace_id: string;
  catalog_generation: string;
  capsules: Array<{capsule: InvestigationCapsule; relevance: number}>;
  rejected: MeterlessRejectedCapsule[];
  trace: MeterlessTraceEntry[];
  metrics: MeterlessMetrics;
}

export interface MeterlessRebuildResult {
  adapter_version: typeof METERLESS_ADAPTER_VERSION;
  workspace_id: string;
  catalog_generation: string;
  indexed_capsule_ids: string[];
  rejected: MeterlessRejectedCapsule[];
  trace: MeterlessTraceEntry[];
  metrics: Omit<MeterlessMetrics, 'engine_candidates' | 'returned_count'>;
}

export type MemoryFeedbackKind = 'helpful' | 'not_relevant' | 'wrong';
export interface MeterlessFeedbackResult {
  adapter_version: typeof METERLESS_ADAPTER_VERSION;
  workspace_id: string;
  catalog_generation: string;
  capsule_id: string;
  applied: true;
  trace: MeterlessTraceEntry[];
  metrics: {latency_ms: number; input_bytes: number};
}

type Plain = Record<string, unknown>;

function plain(value: unknown, name: string, allowed: readonly string[]): Plain {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_METERLESS_CAPSULE', `${name} must be an object.`);
  const object = value as Plain;
  demand(Object.keys(object).every(key => allowed.includes(key)), 'INVALID_METERLESS_CAPSULE', `${name} contains an unsupported field.`);
  return object;
}

function literal<T extends string | number>(value: unknown, expected: T, name: string): T {
  demand(value === expected, 'INVALID_METERLESS_CAPSULE', `${name} must be ${String(expected)}.`);
  return expected;
}

function text(value: unknown, name: string, max = 2_000): string {
  demand(typeof value === 'string', 'INVALID_METERLESS_CAPSULE', `${name} must be text.`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  demand(normalized.length > 0 && normalized.length <= max, 'INVALID_METERLESS_CAPSULE', `${name} is empty or too long.`);
  return normalized;
}

function id(value: unknown, name: string): string {
  const normalized = text(value, name, 200);
  demand(ID.test(normalized), 'INVALID_METERLESS_CAPSULE', `${name} has an invalid identifier.`);
  return normalized;
}

function digest(value: unknown, name: string): string {
  demand(typeof value === 'string' && HASH.test(value), 'INVALID_METERLESS_CAPSULE', `${name} must be a lowercase SHA-256 digest.`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  demand(typeof value === 'boolean', 'INVALID_METERLESS_CAPSULE', `${name} must be a boolean.`);
  return value;
}

function nullableText(value: unknown, name: string, max = 2_000): string | null {
  return value === null ? null : text(value, name, max);
}

function list(value: unknown, name: string, mapper: (item: unknown, itemName: string) => string, maxItems = 20): string[] {
  demand(Array.isArray(value) && value.length <= maxItems, 'INVALID_METERLESS_CAPSULE', `${name} must be a bounded list.`);
  const normalized = value.map((item, index) => mapper(item, `${name}[${index}]`));
  demand(new Set(normalized).size === normalized.length, 'INVALID_METERLESS_CAPSULE', `${name} must not contain duplicates.`);
  return normalized;
}

function iso(value: unknown, name: string): string {
  demand(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)), 'INVALID_METERLESS_CAPSULE', `${name} must be a millisecond UTC timestamp.`);
  return value;
}

const contentFields = [
  'schema_version', 'status', 'capsule_id', 'workspace_id', 'source_case_id', 'published_report_id', 'revision_id', 'report_hash', 'metric_hash', 'snapshot_hash',
  'evidence_hashes', 'affected_flow', 'cohort_keys', 'release_refs', 'accepted_findings', 'rejected_or_unresolved_alternatives', 'falsifiers',
  'control_observations', 'test_prerequisites', 'oracle_version', 'claim_axes', 'limitations', 'follow_up_outcome', 'created_by', 'accepted_at',
] as const;

function normalizeContent(value: unknown): InvestigationCapsuleContent {
  const source = plain(value, 'capsule', contentFields);
  const findingValues = source.accepted_findings;
  demand(Array.isArray(findingValues) && findingValues.length > 0 && findingValues.length <= 20, 'INVALID_METERLESS_CAPSULE', 'accepted_findings must be a non-empty bounded list.');
  const findings = findingValues.map((entry, index): InvestigationFinding => {
    const finding = plain(entry, `accepted_findings[${index}]`, ['text', 'evidence_ids']);
    const evidenceIds = list(finding.evidence_ids, `accepted_findings[${index}].evidence_ids`, id, 50);
    demand(evidenceIds.length > 0, 'INVALID_METERLESS_CAPSULE', `accepted_findings[${index}] requires evidence.`);
    return {text: text(finding.text, `accepted_findings[${index}].text`, 4_000), evidence_ids: evidenceIds};
  });
  const axes = plain(source.claim_axes, 'claim_axes', ['association', 'mechanism', 'correction', 'causal_effect']);
  demand(['observed', 'not_observed', 'unknown'].includes(String(axes.association)), 'INVALID_METERLESS_CAPSULE', 'claim_axes.association is unsupported.');
  demand(['reproduced', 'not_reproduced', 'inconclusive', 'untested'].includes(String(axes.mechanism)), 'INVALID_METERLESS_CAPSULE', 'claim_axes.mechanism is unsupported.');
  demand(['validated', 'not_validated', 'inconclusive', 'not_tested'].includes(String(axes.correction)), 'INVALID_METERLESS_CAPSULE', 'claim_axes.correction is unsupported.');
  literal(axes.causal_effect, 'not_established', 'claim_axes.causal_effect');
  const evidenceHashes = list(source.evidence_hashes, 'evidence_hashes', digest, 100);
  demand(evidenceHashes.length > 0, 'INVALID_METERLESS_CAPSULE', 'evidence_hashes must identify accepted evidence.');
  return {
    schema_version: literal(source.schema_version, 1, 'schema_version'), status: literal(source.status, 'accepted', 'status'),
    capsule_id: id(source.capsule_id, 'capsule_id'), workspace_id: id(source.workspace_id, 'workspace_id'), source_case_id: id(source.source_case_id, 'source_case_id'),
    published_report_id: id(source.published_report_id, 'published_report_id'), revision_id: id(source.revision_id, 'revision_id'), report_hash: digest(source.report_hash, 'report_hash'),
    metric_hash: digest(source.metric_hash, 'metric_hash'), snapshot_hash: digest(source.snapshot_hash, 'snapshot_hash'), evidence_hashes: evidenceHashes,
    affected_flow: text(source.affected_flow, 'affected_flow', 500), cohort_keys: list(source.cohort_keys, 'cohort_keys', (item, name) => text(item, name, 200), 20),
    release_refs: list(source.release_refs, 'release_refs', (item, name) => text(item, name, 300), 20), accepted_findings: findings,
    rejected_or_unresolved_alternatives: list(source.rejected_or_unresolved_alternatives, 'rejected_or_unresolved_alternatives', (item, name) => text(item, name, 2_000), 20),
    falsifiers: list(source.falsifiers, 'falsifiers', (item, name) => text(item, name, 2_000), 20), control_observations: list(source.control_observations, 'control_observations', (item, name) => text(item, name, 2_000), 20),
    test_prerequisites: list(source.test_prerequisites, 'test_prerequisites', (item, name) => text(item, name, 2_000), 20), oracle_version: nullableText(source.oracle_version, 'oracle_version', 200),
    claim_axes: {association: axes.association as InvestigationClaimAxes['association'], mechanism: axes.mechanism as InvestigationClaimAxes['mechanism'], correction: axes.correction as InvestigationClaimAxes['correction'], causal_effect: 'not_established'},
    limitations: list(source.limitations, 'limitations', (item, name) => text(item, name, 2_000), 20), follow_up_outcome: nullableText(source.follow_up_outcome, 'follow_up_outcome', 2_000),
    created_by: id(source.created_by, 'created_by'), accepted_at: iso(source.accepted_at, 'accepted_at'),
  };
}

/** Hash only immutable accepted knowledge; mutable PostgreSQL authority is intentionally excluded. */
export function investigationCapsuleHash(value: InvestigationCapsuleContent): string {
  const source = value as unknown as Plain;
  return hash(normalizeContent(Object.fromEntries(contentFields.map(field => [field, source[field]]))));
}

export function validateInvestigationCapsule(value: unknown): InvestigationCapsule {
  const source = plain(value, 'capsule', [...contentFields, 'capsule_hash', 'authority']);
  const content = normalizeContent(Object.fromEntries(contentFields.map(field => [field, source[field]])));
  const authority = plain(source.authority, 'authority', ['workspace_id', 'current_revision_id', 'current_metric_hash', 'current_snapshot_hash', 'current_report_hash', 'capsule_hash', 'withdrawn', 'deleted']);
  return {
    ...content,
    capsule_hash: digest(source.capsule_hash, 'capsule_hash'),
    authority: {
      workspace_id: id(authority.workspace_id, 'authority.workspace_id'), current_revision_id: id(authority.current_revision_id, 'authority.current_revision_id'),
      current_metric_hash: digest(authority.current_metric_hash, 'authority.current_metric_hash'), current_snapshot_hash: digest(authority.current_snapshot_hash, 'authority.current_snapshot_hash'),
      current_report_hash: digest(authority.current_report_hash, 'authority.current_report_hash'), capsule_hash: digest(authority.capsule_hash, 'authority.capsule_hash'),
      withdrawn: boolean(authority.withdrawn, 'authority.withdrawn'), deleted: boolean(authority.deleted, 'authority.deleted'),
    },
  };
}

function eligibility(capsule: InvestigationCapsule, workspaceId: string): MeterlessRejectionReason | null {
  if (capsule.workspace_id !== workspaceId || capsule.authority.workspace_id !== workspaceId) return 'foreign_workspace';
  if (capsule.authority.withdrawn) return 'withdrawn';
  if (capsule.authority.deleted) return 'deleted';
  const computed = investigationCapsuleHash(capsule);
  if (capsule.capsule_hash !== computed || capsule.authority.capsule_hash !== computed) return 'capsule_hash_mismatch';
  if (capsule.revision_id !== capsule.authority.current_revision_id) return 'stale_revision';
  if (capsule.metric_hash !== capsule.authority.current_metric_hash) return 'stale_metric';
  if (capsule.snapshot_hash !== capsule.authority.current_snapshot_hash) return 'stale_snapshot';
  if (capsule.report_hash !== capsule.authority.current_report_hash) return 'stale_report';
  return null;
}

function renderCapsule(capsule: InvestigationCapsule): string {
  const findings = capsule.accepted_findings.map(finding => finding.text).join(' | ');
  const rendered = [
    `Flow: ${capsule.affected_flow}`,
    `Cohorts: ${capsule.cohort_keys.join(', ') || 'none recorded'}`,
    `Releases: ${capsule.release_refs.join(', ') || 'none recorded'}`,
    `Accepted findings: ${findings}`,
    `Unresolved alternatives: ${capsule.rejected_or_unresolved_alternatives.join(' | ') || 'none recorded'}`,
    `Falsifiers: ${capsule.falsifiers.join(' | ') || 'none recorded'}`,
    `Control observations: ${capsule.control_observations.join(' | ') || 'none recorded'}`,
    `Test prerequisites: ${capsule.test_prerequisites.join(' | ') || 'none recorded'}`,
    `Oracle: ${capsule.oracle_version ?? 'none recorded'}`,
    `Claims: association ${capsule.claim_axes.association}; mechanism ${capsule.claim_axes.mechanism}; correction ${capsule.claim_axes.correction}; aggregate causal effect ${capsule.claim_axes.causal_effect}`,
    `Limitations: ${capsule.limitations.join(' | ') || 'none recorded'}`,
    `Follow-up: ${capsule.follow_up_outcome ?? 'none recorded'}`,
  ].join('\n');
  demand(Buffer.byteLength(rendered) <= MAX_MEMORY_BYTES, 'METERLESS_CAPSULE_TOO_LARGE', 'The rendered memory exceeds the bounded H-MEM input size.');
  return rendered;
}

function elapsed(start: number): number {
  return Number(Math.max(0, performance.now() - start).toFixed(3));
}

function traceBase(workspaceId: string, generation: string, operation: MeterlessTraceEntry['operation'], input: unknown, inputBytes: number, latencyMs: number): MeterlessTraceEntry {
  return {operation, adapter_version: METERLESS_ADAPTER_VERSION, workspace_id: workspaceId, catalog_generation: generation, input_hash: hash(input), input_bytes: inputBytes, latency_ms: latencyMs, redacted: true};
}

function uniqueCapsules(values: readonly InvestigationCapsule[]): Map<string, InvestigationCapsule> {
  const result = new Map<string, InvestigationCapsule>();
  for (const value of values) {
    const capsule = validateInvestigationCapsule(value);
    demand(!result.has(capsule.capsule_id), 'DUPLICATE_METERLESS_CAPSULE', 'A catalog generation cannot contain duplicate capsule identities.');
    result.set(capsule.capsule_id, capsule);
  }
  return result;
}

/**
 * One instance owns exactly one H-MEM store for one workspace/catalog generation.
 * Create a new instance and call rebuild after process restart or catalog change.
 */
export class MeterlessInvestigationMemory {
  readonly workspace_id: string;
  readonly catalog_generation: string;
  private engine: HMEM;
  private capsules = new Map<string, InvestigationCapsule>();
  private memoryToCapsule = new Map<string, string>();
  private capsuleToMemory = new Map<string, string>();
  private rebuildRejections: MeterlessRejectedCapsule[] = [];
  private readonly clock: () => number;

  constructor(input: {workspace_id: string; catalog_generation: string; clock?: () => number}) {
    this.workspace_id = id(input.workspace_id, 'workspace_id');
    this.catalog_generation = id(input.catalog_generation, 'catalog_generation');
    this.clock = input.clock ?? Date.now;
    this.engine = new HMEM({clock: this.clock, actor: `faultline-meterless:${this.workspace_id}`});
  }

  rebuild(capsules: readonly InvestigationCapsule[]): MeterlessRebuildResult {
    const start = performance.now();
    const normalized = uniqueCapsules(capsules);
    const nextEngine = new HMEM({clock: this.clock, actor: `faultline-meterless:${this.workspace_id}`});
    const nextCapsules = new Map<string, InvestigationCapsule>();
    const nextMemoryToCapsule = new Map<string, string>();
    const nextCapsuleToMemory = new Map<string, string>();
    const rejected: MeterlessRejectedCapsule[] = [];
    const trace: MeterlessTraceEntry[] = [];
    let inputBytes = 0;
    for (const capsule of normalized.values()) {
      const reason = eligibility(capsule, this.workspace_id);
      if (reason) { rejected.push({capsule_id: capsule.capsule_id, reason}); continue; }
      const rendered = renderCapsule(capsule);
      const bytes = Buffer.byteLength(rendered);
      const addStart = performance.now();
      const memory = nextEngine.add({
        content: rendered,
        type: 'factual',
        layer: 'long_term',
        tags: [`project:${this.workspace_id}`, `flow:${capsule.affected_flow}`, ...capsule.cohort_keys.map(value => `cohort:${value}`), ...capsule.release_refs.map(value => `release:${value}`)].slice(0, 50),
        confidence: 0.9,
        source: `faultline:capsule:${capsule.capsule_id}`,
        provenance: {origin: 'manual', learnedAt: Date.parse(capsule.accepted_at), label: `accepted investigation ${capsule.capsule_id}`, refs: [capsule.published_report_id]},
      });
      nextCapsules.set(capsule.capsule_id, structuredClone(capsule));
      nextMemoryToCapsule.set(memory.id, capsule.capsule_id);
      nextCapsuleToMemory.set(capsule.capsule_id, memory.id);
      inputBytes += bytes;
      trace.push({...traceBase(this.workspace_id, this.catalog_generation, 'add', {capsule_id: capsule.capsule_id, capsule_hash: capsule.capsule_hash}, bytes, elapsed(addStart)), capsule_id: capsule.capsule_id, capsule_hash: capsule.capsule_hash});
    }
    this.engine = nextEngine;
    this.capsules = nextCapsules;
    this.memoryToCapsule = nextMemoryToCapsule;
    this.capsuleToMemory = nextCapsuleToMemory;
    this.rebuildRejections = rejected;
    return {
      adapter_version: METERLESS_ADAPTER_VERSION,
      workspace_id: this.workspace_id,
      catalog_generation: this.catalog_generation,
      indexed_capsule_ids: [...nextCapsules.keys()],
      rejected: structuredClone(rejected),
      trace,
      metrics: {latency_ms: elapsed(start), input_bytes: inputBytes, indexed_count: nextCapsules.size},
    };
  }

  query(input: MemoryRetrievalQuery): MemoryRetrievalResult {
    demand(input.workspace_id === this.workspace_id, 'METERLESS_WORKSPACE_MISMATCH', 'Memory retrieval cannot cross workspaces.', 403);
    demand(input.catalog_generation === this.catalog_generation, 'STALE_METERLESS_CATALOG', 'Memory retrieval requires the current catalog generation.', 409);
    const query = text(input.text, 'query', 4_000);
    const maxResults = input.max_results ?? 5;
    demand(Number.isSafeInteger(maxResults) && maxResults >= 1 && maxResults <= 5, 'INVALID_METERLESS_LIMIT', 'Memory retrieval returns between one and five capsules.');
    const authoritative = input.current_capsules ? uniqueCapsules(input.current_capsules) : this.capsules;
    const start = performance.now();
    // H-MEM's long structured capsules contain more tokens than its short-chat
    // reference profile. Keep its hybrid ranking and use a lower, explicit
    // candidate threshold; Faultline still re-resolves every candidate and
    // returns at most five.
    const engineResult = this.engine.query(query, {topN: Math.min(50, Math.max(5, this.capsules.size)), threshold: METERLESS_RETRIEVAL_THRESHOLD});
    const selected: MemoryRetrievalResult['capsules'] = [];
    const rejected: MeterlessRejectedCapsule[] = [];
    for (const candidate of engineResult.memories) {
      const capsuleId = this.memoryToCapsule.get(candidate.memory.id);
      if (!capsuleId) { rejected.push({capsule_id: candidate.memory.id, reason: 'unmapped_engine_id'}); continue; }
      const indexed = this.capsules.get(capsuleId);
      const current = authoritative.get(capsuleId);
      if (!indexed || !current) { rejected.push({capsule_id: capsuleId, reason: 'not_authoritative'}); continue; }
      const reason = eligibility(current, this.workspace_id);
      if (reason) { rejected.push({capsule_id: capsuleId, reason}); continue; }
      if (current.capsule_hash !== indexed.capsule_hash) { rejected.push({capsule_id: capsuleId, reason: 'catalog_hash_changed'}); continue; }
      selected.push({capsule: structuredClone(current), relevance: Number(candidate.relevance.toFixed(6))});
      if (selected.length === maxResults) break;
    }
    const latency = elapsed(start);
    const bytes = Buffer.byteLength(query);
    const queryHash = hash({adapter_version: METERLESS_ADAPTER_VERSION, hmem_commit: METERLESS_HMEM_COMMIT, retrieval_threshold: METERLESS_RETRIEVAL_THRESHOLD, workspace_id: this.workspace_id, catalog_generation: this.catalog_generation, text: query, max_results: maxResults});
    const trace = {...traceBase(this.workspace_id, this.catalog_generation, 'query', {query_hash: queryHash, max_results: maxResults}, bytes, latency), query_hash: queryHash, returned_capsule_ids: selected.map(value => value.capsule.capsule_id)};
    return {
      adapter_version: METERLESS_ADAPTER_VERSION,
      workspace_id: this.workspace_id,
      catalog_generation: this.catalog_generation,
      capsules: selected,
      rejected: [...structuredClone(this.rebuildRejections), ...rejected],
      trace: [trace],
      metrics: {latency_ms: latency, input_bytes: bytes, indexed_count: this.capsules.size, engine_candidates: engineResult.memories.length, returned_count: selected.length},
    };
  }

  feedback(capsuleIdValue: string, kind: MemoryFeedbackKind): MeterlessFeedbackResult {
    const capsuleId = id(capsuleIdValue, 'capsule_id');
    demand(['helpful', 'not_relevant', 'wrong'].includes(kind), 'INVALID_METERLESS_FEEDBACK', 'Memory feedback kind is unsupported.');
    const memoryId = this.capsuleToMemory.get(capsuleId);
    demand(memoryId && this.capsules.has(capsuleId), 'METERLESS_CAPSULE_NOT_CURRENT', 'Feedback requires a current indexed capsule.', 409);
    const mapped: HmemFeedbackKind = kind === 'not_relevant' ? 'not_helpful' : kind;
    const bytes = Buffer.byteLength(`${capsuleId}:${kind}`);
    const start = performance.now();
    this.engine.feedback(memoryId, mapped);
    const latency = elapsed(start);
    const trace = {...traceBase(this.workspace_id, this.catalog_generation, 'feedback', {capsule_id: capsuleId, kind}, bytes, latency), capsule_id: capsuleId, feedback_kind: kind};
    return {adapter_version: METERLESS_ADAPTER_VERSION, workspace_id: this.workspace_id, catalog_generation: this.catalog_generation, capsule_id: capsuleId, applied: true, trace: [trace], metrics: {latency_ms: latency, input_bytes: bytes}};
  }
}

export function isMeterlessDomainError(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}
