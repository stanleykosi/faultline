import {gunzipSync} from 'node:zlib';
import {TextDecoder} from 'node:util';
import {byteHash, hash, now} from '../../canonical.js';
import {normalizeAnalytics, type NormalizationResult} from '../../imports/parser.js';
import {normalizeEventTime} from '../../imports/time.js';
import {validateContract} from '../../../../contracts/src/validate.js';
import type {FaultlineConnectorCapabilities, FaultlineCoverage, FaultlineCoverageDeclaration} from '../../../../contracts/src/generated.js';
import {approvedHttps, checkActive, ConnectorError, getWire, header, object, providerOrigin, requireSuccess, requireWire, strictJson, text, wireFingerprint, type ExecutionControl, type SafeHttp} from '../wire.js';

export const POSTHOG_ADAPTER_VERSION = 'posthog-file-export-v1:c08b5a4';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = ['Starting', 'Running', 'Completed', 'Cancelled', 'Failed', 'FailedRetryable', 'FailedBilling', 'Terminated', 'TimedOut'];
export interface PostHogConfig {origin: string; project_id: number; token: string; storage_origins: string[]; source_id: string; workspace_id: string;}
export interface ExportDeclaration {
  run_id: string; project_id: number; model: 'events'; data_interval_start: string; data_interval_end: string;
  file: {format: 'JSONLines'; compression: 'gzip' | null}; include?: string[]; exclude?: string[];
  declared_by: string; declared_at: string; artifact_hash: string; provenance: 'owner_declared';
}
export interface PostHogMapping {device_property: string; device_values?: Record<string, string>; excluded_property?: string; release_property?: string; event_names?: Record<string, string>;}
export interface CaptureLimits {fileBytes: number; totalBytes: number; expandedBytes: number; files: number; records: number; recordBytes: number; depth: number; runs: number;}
const ceilings: CaptureLimits = {fileBytes: 52_428_800, totalBytes: 268_435_456, expandedBytes: 268_435_456, files: 100, records: 100_000, recordBytes: 262_144, depth: 32, runs: 20};
export interface RunManifest {run_id: string; status: string; files: string[]; records_completed: number | null; manifest_hash: string; body_hash: string; request_id: string | null;}
export interface DownloadedFile {run_id: string; file_id: string; manifest_hash: string; raw_bytes: Buffer; byte_count: number; expanded_byte_count: number; raw_hash: string; decoded_hash: string; raw_record_count: number;}
export interface PostHogCaptureOptions extends ExecutionControl {
  limits?: Partial<CaptureLimits>;
  onManifest?: (manifest: RunManifest) => Promise<void>;
  onFileReceived?: (file: Pick<DownloadedFile, 'run_id' | 'file_id' | 'manifest_hash' | 'raw_bytes' | 'byte_count' | 'raw_hash'>) => Promise<void>;
  onFileDecoded?: (file: DownloadedFile) => Promise<void>;
}
export interface PostHogCapture {
  adapter_version: string; source_id: string; workspace_id: string; captured_at: string; input_hash: string;
  declarations: ExportDeclaration[]; manifests: RunManifest[]; files: DownloadedFile[]; normalization: NormalizationResult;
  coverage: FaultlineCoverage; received_range_gaps: {start: string; end: string}[];
  terminal_state: 'complete' | 'blocked'; empty_artifact: Buffer | null;
  record_provenance: {row: number; source_event_id: unknown; source_timestamp: unknown; source_ingested_at: unknown; source_inserted_at: unknown}[];
}
function getLimits(overrides: Partial<CaptureLimits> = {}): CaptureLimits {const limits = {...ceilings, ...overrides}; for (const [key, value] of Object.entries(limits)) requireWire(Number.isSafeInteger(value) && value > 0 && value <= ceilings[key as keyof CaptureLimits], 'INVALID_CAPTURE_LIMIT', 'Capture limits can only tighten the configured ceilings.'); return limits;}
function stamp(value: unknown): string {const normalized = normalizeEventTime(value); requireWire(normalized.slice(23, 26) === '000', 'INVALID_EXPORT_DECLARATION', 'Export metadata uses millisecond timestamp precision.'); return normalized.slice(0, 23) + 'Z';}
function safeProperty(value: string | undefined) {if (value !== undefined) requireWire(typeof value === 'string' && value.length > 0 && value.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(value), 'INVALID_MAPPING', 'A finite safe property mapping is required.');}
function declaration(value: ExportDeclaration, config: PostHogConfig): ExportDeclaration {
  requireWire(value && uuid.test(value.run_id) && value.project_id === config.project_id && value.model === 'events' && value.provenance === 'owner_declared', 'INVALID_EXPORT_DECLARATION', 'Each selected run needs its owner-declared project and events-model request metadata.');
  requireWire(value.file?.format === 'JSONLines' && [null, 'gzip'].includes(value.file.compression), 'UNSUPPORTED_EXPORT_FORMAT', 'The supported export profile is plain or gzip JSONLines.');
  const start = stamp(value.data_interval_start), end = stamp(value.data_interval_end);
  requireWire(start < end && Date.parse(end) - Date.parse(start) <= 7 * 86_400_000 && Date.parse(end) <= Date.now(), 'INVALID_EXPORT_DECLARATION', 'An existing events export requires a historical received interval of at most seven days.');
  text(value.declared_by, 'declared_by', 128); stamp(value.declared_at); requireWire(/^[a-f0-9]{64}$/.test(value.artifact_hash), 'INVALID_EXPORT_DECLARATION', 'The declaration needs the original request artifact hash.');
  for (const list of [value.include, value.exclude]) if (list !== undefined) requireWire(Array.isArray(list) && list.length <= 128 && list.every(item => typeof item === 'string' && item.length > 0 && item.length <= 128) && new Set(list).size === list.length, 'INVALID_EXPORT_DECLARATION', 'Event filters must be finite declared name lists.');
  return {...value, data_interval_start: start, data_interval_end: end};
}
export function parsePostHogManifest(body: Buffer): Omit<RunManifest, 'run_id' | 'body_hash' | 'request_id'> {
  const value = object(strictJson(body)); const status = text(value.status, 'status', 30);
  requireWire(statuses.includes(status), 'UNSUPPORTED_PROVIDER_STATUS', 'The export status is outside the pinned provider profile.');
  if (status !== 'Completed') throw new ConnectorError(status === 'Starting' || status === 'Running' ? 'EXPORT_NOT_READY' : 'EXPORT_FAILED', `The selected export is ${status}; no dataset was accepted.`);
  requireWire(Array.isArray(value.files) && value.files.length <= ceilings.files && value.files.every(file => typeof file === 'string' && uuid.test(file)), 'INVALID_EXPORT_MANIFEST', 'A completed export needs a finite file UUID manifest.');
  const files = value.files as string[]; requireWire(new Set(files.map(file => file.toLowerCase())).size === files.length, 'DUPLICATE_EXPORT_FILE', 'The export manifest repeats a file identity.');
  const count = value.records_completed; requireWire(count === null || Number.isSafeInteger(count) && (count as number) >= 0, 'INVALID_EXPORT_MANIFEST', 'The completed export needs an integer or explicit null record count.');
  requireWire(files.length !== 0 || count === 0, 'EXPORT_EMPTY_UNPROVEN', 'A completed zero-file export is only proven empty when its reported row count is zero.');
  return {status, files, records_completed: count as number | null, manifest_hash: hash({status, files, records_completed: count})};
}

export class PostHogExportClient {
  private origin: string;
  private storageOrigins: string[];
  constructor(private http: SafeHttp, private config: PostHogConfig) {
    this.origin = providerOrigin(config.origin); requireWire(Number.isSafeInteger(config.project_id) && config.project_id > 0, 'INVALID_PROJECT', 'PostHog requires one selected positive integer project identity.');
    text(config.token, 'credential', 4096); requireWire(Array.isArray(config.storage_origins) && config.storage_origins.length <= 20, 'INVALID_STORAGE_ORIGINS', 'Storage origins require a finite operator allowlist.'); this.storageOrigins = config.storage_origins.map(providerOrigin);
    requireWire(/^[^\s\x00-\x1f\x7f]+$/.test(config.token), 'INVALID_PROVIDER_CREDENTIAL', 'The provider credential has an invalid header representation.'); this.config = {...config, storage_origins: [...config.storage_origins]};
  }
  private runUrl(runId: string) {requireWire(uuid.test(runId), 'INVALID_RUN_ID', 'Select an existing export run UUID.'); return `${this.origin}/api/projects/${this.config.project_id}/file_download_batch_exports/${runId}/`;}
  private async manifest(runId: string, control: ExecutionControl = {}): Promise<RunManifest> {
    const response = await getWire(this.http, this.runUrl(runId), {headers: {Authorization: `Bearer ${this.config.token}`, Accept: 'application/json'}, allowedOrigins: [this.origin], maxBytes: 1_048_576}, control); requireSuccess(response);
    const parsed = parsePostHogManifest(response.body), fingerprint = wireFingerprint(response); return {...parsed, run_id: runId, body_hash: fingerprint.body_hash, request_id: fingerprint.request_id};
  }
  async probe(selected: ExportDeclaration): Promise<FaultlineConnectorCapabilities> {
    let status: FaultlineConnectorCapabilities['status'] = 'available', reason: string | null = null;
    try {declaration(selected, this.config); await this.manifest(selected.run_id);} catch (error) {reason = error instanceof ConnectorError ? error.code : 'INVALID_EXPORT_DECLARATION'; status = reason === 'PROVIDER_UNAUTHORIZED' ? 'unauthorized' : ['PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED', 'EXPORT_NOT_READY'].includes(reason) ? 'unavailable' : 'unsupported';}
    return validateContract('connector-capabilities', {schema_version: 1, source_kind: 'posthog_existing_file_export', status, checked_at: now(), adapter_version: POSTHOG_ADAPTER_VERSION, read_only: true, features: status === 'available' ? ['selected_completed_file_export', 'all_manifest_files', 'jsonlines'] : [], unsupported_features: ['create_export', 'raw_query', 'parquet', 'brotli'], reason_code: reason, provider_version: 'c08b5a4d6cac1112294eeb0c49c62393839e8c05'});
  }
  private async download(runId: string, fileId: string, limit: number, control: ExecutionControl): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
    let response = await getWire(this.http, `${this.runUrl(runId)}download/${fileId}/`, {headers: {Authorization: `Bearer ${this.config.token}`, Accept: 'application/octet-stream'}, allowedOrigins: [this.origin], maxBytes: limit}, control);
    const seen = new Set<string>();
    for (let hop = 0; [301, 302, 303, 307, 308].includes(response.status); hop++) {
      requireWire(hop < 3, 'DOWNLOAD_REDIRECT_LIMIT', 'The download exceeded the approved redirect limit.'); const target = header(response, 'location');
      requireWire(target, 'INVALID_DOWNLOAD_REDIRECT', 'The download redirect has no destination.'); const url = approvedHttps(target, this.storageOrigins);
      requireWire(!seen.has(url.href), 'DOWNLOAD_REDIRECT_LOOP', 'The download redirect repeated a destination.'); seen.add(url.href);
      // The signed object request never inherits provider auth, cookies, or ambient credentials.
      response = await getWire(this.http, url.href, {headers: {Accept: 'application/octet-stream'}, allowedOrigins: this.storageOrigins, maxBytes: limit}, control);
    }
    if (response.status === 403 && seen.size > 0 && attempt === 0) continue;
    if (response.status === 403 && seen.size > 0) throw new ConnectorError('EXPORT_DOWNLOAD_EXPIRED', 'The signed object remained inaccessible after one refreshed download link.');
    requireSuccess(response); const media = header(response, 'content-type')?.split(';')[0]?.toLowerCase();
    requireWire(media !== 'text/html' && !response.body.subarray(0, 128).toString('utf8').trimStart().startsWith('<'), 'INVALID_EXPORT_CONTENT', 'The download contains an HTML/login response rather than JSONLines.');
    return response.body;
    }
    throw new ConnectorError('EXPORT_DOWNLOAD_EXPIRED', 'The signed object could not be downloaded within the retry budget.');
  }
  async capture(selected: ExportDeclaration[], mapping: PostHogMapping, coverageDeclaration: FaultlineCoverageDeclaration, options: PostHogCaptureOptions = {}): Promise<PostHogCapture> {
    const limits = getLimits(options.limits); requireWire(Array.isArray(selected) && selected.length > 0 && selected.length <= limits.runs && new Set(selected.map(item => item.run_id)).size === selected.length, 'INVALID_RUN_SELECTION', 'Capture requires unique explicitly selected existing runs within the configured cap.');
    const declarations = selected.map(item => declaration(item, this.config)); requireWire(typeof mapping.device_property === 'string', 'INVALID_MAPPING', 'Choose the explicit source device property.'); safeProperty(mapping.device_property); safeProperty(mapping.excluded_property); safeProperty(mapping.release_property);
    const declaredCoverage = validateContract<FaultlineCoverageDeclaration>('coverage-declaration', coverageDeclaration);
    for (const interval of declaredCoverage.event_time_intervals) requireWire(stamp(interval.start) < stamp(interval.end), 'INVALID_COVERAGE_DECLARATION', 'Declared event coverage intervals must have ordered boundaries.');
    const allRows: Record<string, unknown>[] = [], files: DownloadedFile[] = [], manifests: RunManifest[] = [], provenance: PostHogCapture['record_provenance'] = [];
    let rawBytes = 0, expandedBytes = 0;
    for (const declared of declarations) {
      const manifest = await this.manifest(declared.run_id, options); manifests.push(manifest); await options.onManifest?.(manifest); requireWire(files.length + manifest.files.length <= limits.files, 'CAPTURE_FILE_LIMIT', 'The selected manifests exceed the capture file cap.'); let runRecords = 0;
      for (const fileId of manifest.files) {
        const bytes = await this.download(declared.run_id, fileId, Math.min(limits.fileBytes, limits.totalBytes - rawBytes), options); rawBytes += bytes.length;
        const received = {run_id: declared.run_id, file_id: fileId, manifest_hash: manifest.manifest_hash, raw_bytes: bytes, byte_count: bytes.length, raw_hash: byteHash(bytes)};
        await options.onFileReceived?.(received); await checkActive(options);
        requireWire(rawBytes <= limits.totalBytes, 'CAPTURE_BYTE_LIMIT', 'Capture exceeds its total source-byte budget.'); let decoded = bytes;
        if (declared.file.compression === 'gzip') {requireWire(bytes[0] === 0x1f && bytes[1] === 0x8b, 'INVALID_EXPORT_GZIP', 'The declared gzip export has incorrect magic bytes.'); try {decoded = gunzipSync(bytes, {maxOutputLength: limits.expandedBytes - expandedBytes});} catch {throw new ConnectorError('INVALID_EXPORT_GZIP', 'The gzip export is malformed, truncated, or exceeds the expanded budget.');}}
        else requireWire(!(bytes[0] === 0x1f && bytes[1] === 0x8b), 'EXPORT_COMPRESSION_MISMATCH', 'Compressed content does not match the owner-declared export profile.');
        expandedBytes += decoded.length; requireWire(expandedBytes <= limits.expandedBytes, 'CAPTURE_EXPANSION_LIMIT', 'Capture exceeds its expanded-byte budget.');
        let contents: string; try {contents = new TextDecoder('utf-8', {fatal: true}).decode(decoded).replace(/^\uFEFF/, '');} catch {throw new ConnectorError('INVALID_EXPORT_ENCODING', 'Export JSONLines must be valid UTF-8.');}
        const lines = contents.split('\n').filter(line => line.trim()); const fileRecords = lines.length;
        const decodedFile = {...received, expanded_byte_count: decoded.length, decoded_hash: byteHash(decoded), raw_record_count: fileRecords};
        files.push(decodedFile); await options.onFileDecoded?.(decodedFile); await checkActive(options);
        requireWire(allRows.length + fileRecords <= limits.records, 'CAPTURE_RECORD_LIMIT', 'Capture exceeds the raw source-record cap.');
        for (const line of lines) {const row = object(strictJson(Buffer.from(line), limits.recordBytes, limits.depth)); allRows.push(row); provenance.push({row: allRows.length, source_event_id: row.uuid ?? null, source_timestamp: row.timestamp ?? null, source_ingested_at: row.created_at ?? null, source_inserted_at: row._inserted_at ?? null});}
        runRecords += fileRecords;
      }
      requireWire(manifest.records_completed === null || manifest.records_completed === runRecords, 'EXPORT_RECORD_COUNT_MISMATCH', 'The raw downloaded row count differs from the provider completed count.');
      const refreshed = await this.manifest(declared.run_id, options); requireWire(refreshed.manifest_hash === manifest.manifest_hash, 'EXPORT_MANIFEST_CHANGED', 'The export state or file manifest changed during capture.');
    }
    const canonicalRows = allRows.map(row => {const props = row.properties && typeof row.properties === 'object' && !Array.isArray(row.properties) ? row.properties as Record<string, unknown> : {}; return {event_id: row.uuid, session_id: props.$session_id, event_name: row.event, occurred_at: row.timestamp, device: props[mapping.device_property] ?? 'unknown', excluded: mapping.excluded_property ? props[mapping.excluded_property] : false, release_id: mapping.release_property ? props[mapping.release_property] ?? null : null};});
    // The common normalizer accounts for exact duplicates and rejects identity conflicts/missing sessions.
    const normalization = normalizeAnalytics(Buffer.from(JSON.stringify(canonicalRows)), 'json', this.config.source_id, {...mapping.event_names ? {event_names: mapping.event_names} : {}, ...mapping.device_values ? {device_values: mapping.device_values} : {}});
    const intervals = declarations.map(item => ({start: item.data_interval_start, end: item.data_interval_end})).sort((a, b) => a.start.localeCompare(b.start)); const merged: {start: string; end: string}[] = [], gaps: {start: string; end: string}[] = [];
    for (const interval of intervals) {const last = merged.at(-1); if (last && interval.start <= last.end) {if (interval.end > last.end) last.end = interval.end;} else {if (last) gaps.push({start: last.end, end: interval.start}); merged.push({...interval});}}
    const eventIntervals = [...declaredCoverage.event_time_intervals].sort((a, b) => a.start.localeCompare(b.start));
    const coverage = validateContract<FaultlineCoverage>('coverage', {extraction_status: 'complete', basis: declaredCoverage.basis, covered_start: eventIntervals[0]?.start ?? null, covered_end: eventIntervals.reduce<string | null>((end, interval) => end === null || interval.end > end ? interval.end : end, null), event_watermark: declaredCoverage.declared_event_watermark, attestation: declaredCoverage.statement, event_time_intervals: eventIntervals, received_time_intervals: merged, assumptions: declaredCoverage.basis === 'lateness_assumption' ? [`Owner-declared late-arrival margin: ${declaredCoverage.late_arrival_hours} hours; not an upstream guarantee.`] : []});
    await checkActive(options);
    return {adapter_version: POSTHOG_ADAPTER_VERSION, source_id: this.config.source_id, workspace_id: this.config.workspace_id, captured_at: now(), input_hash: hash({declarations, mapping, coverage: declaredCoverage}), declarations, manifests, files, normalization, coverage, received_range_gaps: gaps, terminal_state: normalization.canFinalize ? 'complete' : 'blocked', empty_artifact: allRows.length === 0 ? Buffer.from('[]\n') : null, record_provenance: provenance};
  }
}
