import {createHash} from 'node:crypto';
import {createGunzip, gunzipSync} from 'node:zlib';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {parse as parseCsv, CsvError, type Options as CsvOptions} from 'csv-parse';
import {parse as parseCsvSync} from 'csv-parse/sync';
import {TextDecoder} from 'node:util';
import {byteHash, hash, hashCanonicalArray} from '../canonical.js';
import {demand, DomainError} from '../errors.js';
import {eventMicros, metadataMicros, normalizeEventTime} from './time.js';
import {rejectDuplicateJsonKeys} from './duplicate-json-keys.js';
import {validateContract} from '../../../contracts/src/validate.js';
import type {FaultlineCanonicalEvent, FaultlineEvidence} from '../../../contracts/src/generated.js';

export type ImportFormat = 'csv' | 'json' | 'jsonl';
export type FieldPath = string | readonly string[];
export interface AnalyticsMapping {
  record_kind?: 'analytics'; schema_version?: 1;
  excluded_default?: boolean;
  source_namespace?: string;
  event_id?: FieldPath; session_id?: FieldPath; event_name?: FieldPath; occurred_at?: FieldPath;
  device?: FieldPath; excluded?: FieldPath; release_id?: FieldPath; source_id?: FieldPath;
  event_names?: Readonly<Record<string, string>>; device_values?: Readonly<Record<string, string>>;
}
export interface ImportLimits {
  inputBytes: number; expandedBytes: number; records: number; recordBytes: number;
  depth: number; issues: number; expansionRatio: number;
}
export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  inputBytes: 50 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024, records: 100_000,
  recordBytes: 256 * 1024, depth: 32, issues: 100, expansionRatio: 100,
});
export interface SourceLocator {record: number; line_start: number; line_end: number;}
export interface ImportIssue {row: number; code: string; message: string; severity: 'blocker' | 'warning'; locator?: SourceLocator;}
export interface NormalizationResult {
  events: FaultlineCanonicalEvent[];
  issues: ImportIssue[];
  counts: {input: number; accepted: number; rejected: number; duplicates: number; conflicts: number; excluded: number; issueTotal: number};
  canFinalize: boolean;
  hashes: {raw: string; decoded: string; normalized: string; mapping: string};
  provenance: {row: number; event_id: string; source_timestamp: string; normalized_timestamp: string; locator?: SourceLocator}[];
  format: ImportFormat;
}
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const defaults: Required<Pick<AnalyticsMapping, 'event_id' | 'session_id' | 'event_name' | 'occurred_at' | 'device' | 'excluded' | 'release_id' | 'source_id'>> = {
  event_id: 'event_id', session_id: 'session_id', event_name: 'event_name', occurred_at: 'occurred_at',
  device: 'device', excluded: 'excluded', release_id: 'release_id', source_id: 'source_id',
};
function limitsFor(overrides: Partial<ImportLimits>): ImportLimits {
  const result = {...DEFAULT_IMPORT_LIMITS, ...overrides};
  for (const [key, value] of Object.entries(result)) demand(Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_IMPORT_LIMITS[key as keyof ImportLimits], 'INVALID_LIMIT', 'Import limits may only tighten the configured ceiling');
  return result;
}
function pathParts(path: FieldPath): readonly string[] {
  demand(typeof path === 'string' || Array.isArray(path), 'INVALID_MAPPING', 'Mapping requires a field name or finite field path');
  const parts = typeof path === 'string' ? [path] : path;
  demand(parts.length > 0 && parts.length <= 8 && parts.every(p => typeof p === 'string' && p.length > 0 && p.length <= 128 && !unsafeKeys.has(p)), 'INVALID_MAPPING', 'Mapping requires a finite safe field path');
  return parts;
}
function mapped(record: Record<string, unknown>, path: FieldPath): unknown {
  let value: unknown = record;
  for (const part of pathParts(path)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function checkStructure(value: unknown, ceiling: number, depth = 0): void {
  demand(depth <= ceiling, 'DEPTH_LIMIT', 'Input exceeds the supported nesting depth');
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') demand(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), 'UNSAFE_NUMBER', 'Unsafe numeric precision; supply identifiers and large integers as strings');
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    demand(!unsafeKeys.has(key), 'UNSAFE_FIELD', 'Input contains an unsafe object field');
    checkStructure(child, ceiling, depth + 1);
  }
}
function json(text: string, limits: ImportLimits): unknown {
  rejectDuplicateJsonKeys(text, limits.depth);
  let result: unknown;
  try {result = JSON.parse(text);} catch {throw new DomainError('INVALID_JSON', 'Malformed JSON');}
  checkStructure(result, limits.depth);
  return result;
}
function objectRecord(value: unknown): Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_RECORD', 'Expected a typed object record');
  return value as Record<string, unknown>;
}
interface ParsedRow {row: number; value: unknown; error?: DomainError; locator?: SourceLocator;}
function csvOptions(limits: ImportLimits): {options: CsvOptions; requireHeader: () => void} {
  let headers: string[] | undefined, lastLine = 0;
  const options: CsvOptions = {
    bom: true, encoding: 'utf8', columns: false, cast: false, cast_date: false,
    relax_column_count: false, relax_quotes: false, skip_records_with_error: false,
    skip_empty_lines: false, trim: false, max_record_size: limits.recordBytes, info: true, raw: true,
    on_record(record) {
      // csv-parse 6.1.0 types describe the unwrapped record. With info/raw enabled the
      // documented runtime value is a wrapper, and on_record may transform its shape.
      const wrapped = record as unknown as {record: string[]; raw: string; info: {lines: number; records: number}};
      demand(Buffer.byteLength(wrapped.raw) <= limits.recordBytes, 'RECORD_LIMIT', `CSV record ending on line ${wrapped.info.lines} exceeds the byte limit`, 413);
      if (!headers) {
        demand(wrapped.record.every(h => h.length > 0 && h.length <= 128 && !unsafeKeys.has(h)) && new Set(wrapped.record).size === wrapped.record.length, 'INVALID_HEADERS', 'CSV headers must be unique nonempty safe field names');
        headers = wrapped.record; lastLine = wrapped.info.lines; return null;
      }
      const locator = {record: wrapped.info.records - 1, line_start: lastLine + 1, line_end: wrapped.info.lines};
      lastLine = wrapped.info.lines;
      demand(locator.record <= limits.records, 'RECORD_LIMIT', 'Import exceeds the record count limit', 413);
      demand(wrapped.record.length === headers.length, 'INVALID_CSV', `CSV record ${locator.record} has an unexpected field count`);
      return {row: locator.line_start, value: Object.fromEntries(headers.map((header, i) => [header, wrapped.record[i]!])), locator} as unknown as string[];
    },
  };
  return {options, requireHeader: () => demand(headers, 'INVALID_HEADERS', 'CSV requires a header row')};
}
function csvFailure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  if (error instanceof CsvError) throw new DomainError(error.code === 'CSV_MAX_RECORD_SIZE' ? 'RECORD_LIMIT' : 'INVALID_CSV', `CSV ${error.code} at source line ${error.lines ?? 'unknown'}`, error.code === 'CSV_MAX_RECORD_SIZE' ? 413 : 400);
  throw error;
}
function* csvRows(text: string, limits: ImportLimits): Generator<ParsedRow> {
  const config = csvOptions(limits);
  try {
    const rows = parseCsvSync(text, config.options) as unknown as ParsedRow[];
    config.requireHeader(); yield* rows;
  } catch (error) {csvFailure(error);}
}
function* records(text: string, format: ImportFormat, limits: ImportLimits): Generator<ParsedRow> {
  if (format === 'csv') {yield* csvRows(text, limits); return;}
  if (format === 'json') {
    const parsed = json(text, limits);
    demand(Array.isArray(parsed), 'INVALID_STRUCTURE', 'JSON analytics import requires an array of records');
    demand(parsed.length <= limits.records, 'RECORD_LIMIT', 'Import exceeds the record count limit');
    for (const [i, value] of parsed.entries()) {demand(Buffer.byteLength(JSON.stringify(value)) <= limits.recordBytes, 'RECORD_LIMIT', `Record ${i + 1} exceeds the record limit`); yield {row: i + 1, value};}
    return;
  }
  let start = 0, row = 1;
  while (start < text.length) {
    let end = text.indexOf('\n', start); if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    demand(Buffer.byteLength(line) <= limits.recordBytes, 'RECORD_LIMIT', `JSONL line ${row} exceeds the record limit`);
    if (line.trim()) {
      try {yield {row, value: json(line, limits)};}
      catch (error) {yield {row, value: undefined, error: error instanceof DomainError ? error : new DomainError('INVALID_JSON', 'Malformed JSONL record')};}
    }
    start = end + 1; row++;
  }
}
function normalizeRecord(record: Record<string, unknown>, sourceId: string, mapping: AnalyticsMapping): FaultlineCanonicalEvent {
  if (Object.hasOwn(record, 'kind')) demand(record.kind === 'analytics', 'INVALID_RECORD_KIND', 'Expected analytics record kind');
  if (Object.hasOwn(record, 'schema_version')) demand(record.schema_version === 1, 'UNSUPPORTED_SCHEMA', 'Unsupported analytics record schema version');
  const get = (field: keyof typeof defaults) => mapped(record, mapping[field] ?? defaults[field]);
  const source = get('source_id');
  demand(source === undefined || source === (mapping.source_namespace ?? sourceId), 'SOURCE_MISMATCH', 'Record source does not match the configured logical source');
  const session = get('session_id');
  demand(typeof session === 'string' && session.length > 0, 'MISSING_SESSION_ID', 'An explicit string session identity is required; person identity is not a substitute');
  const eventId = get('event_id');
  demand(typeof eventId === 'string', 'INVALID_EVENT_ID', 'Event identity must be a stable string');
  let name = get('event_name'), device = get('device');
  if (typeof name === 'string' && mapping.event_names) {demand(Object.hasOwn(mapping.event_names, name), 'UNMAPPED_EVENT', 'Event name has no explicit configured mapping'); name = mapping.event_names[name];}
  if (typeof device === 'string' && mapping.device_values) {demand(Object.hasOwn(mapping.device_values, device), 'UNMAPPED_DEVICE', 'Device has no explicit configured mapping'); device = mapping.device_values[device];}
  const sourceExcluded = get('excluded');
  const rawExcluded = sourceExcluded === undefined ? mapping.excluded_default : sourceExcluded;
  demand(typeof rawExcluded === 'boolean' || rawExcluded === 'true' || rawExcluded === 'false', 'INVALID_EXCLUSION', 'Exclusion must be an explicit boolean');
  const rawRelease = get('release_id');
  const event = {source_id: sourceId, event_id: eventId, session_id: session, event_name: name, device,
    occurred_at: normalizeEventTime(get('occurred_at')), excluded: rawExcluded === true || rawExcluded === 'true', release_id: rawRelease === '' || rawRelease === null || rawRelease === undefined ? null : rawRelease};
  return validateContract<FaultlineCanonicalEvent>('canonical-event', event);
}
function checkMapping(sourceId: string, mapping: AnalyticsMapping): void {
  demand(mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping), 'INVALID_MAPPING', 'Mapping must be a finite object');
  demand(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(sourceId), 'INVALID_SOURCE', 'Invalid source identity');
  demand(mapping.record_kind === undefined || mapping.record_kind === 'analytics', 'INVALID_MAPPING', 'Mapping record kind must match analytics');
  demand(mapping.schema_version === undefined || mapping.schema_version === 1, 'INVALID_MAPPING', 'Unsupported mapping schema version');
  demand(mapping.excluded_default === undefined || typeof mapping.excluded_default === 'boolean', 'INVALID_MAPPING', 'Exclusion default must be an explicit boolean');
  for (const key of Object.keys(mapping)) demand(Object.hasOwn(defaults, key) || ['event_names', 'device_values', 'record_kind', 'schema_version', 'excluded_default','source_namespace'].includes(key), 'INVALID_MAPPING', 'Unsupported mapping field');
  demand(mapping.source_namespace === undefined || (typeof mapping.source_namespace === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(mapping.source_namespace)), 'INVALID_MAPPING', 'Invalid source namespace');
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) if (mapping[key] !== undefined) pathParts(mapping[key]!);
  for (const values of [mapping.event_names, mapping.device_values]) if (values) {
    demand(typeof values === 'object' && !Array.isArray(values), 'INVALID_MAPPING', 'Category mapping must be a finite object');
    demand(Object.keys(values).length <= 128, 'INVALID_MAPPING', 'Mapping categories exceed the finite limit');
    for (const [key, value] of Object.entries(values)) demand(!unsafeKeys.has(key) && typeof value === 'string', 'INVALID_MAPPING', 'Invalid category mapping');
  }
}
function collector(sourceId: string, mapping: AnalyticsMapping, limits: ImportLimits) {
  const events: FaultlineCanonicalEvent[] = [], issues: ImportIssue[] = [], provenance: NormalizationResult['provenance'] = [];
  const counts = {input: 0, accepted: 0, rejected: 0, duplicates: 0, conflicts: 0, excluded: 0, issueTotal: 0};
  const identities = new Map<string, FaultlineCanonicalEvent>();
  const add = (row: ParsedRow) => {
    counts.input++; demand(counts.input <= limits.records, 'RECORD_LIMIT', 'Import exceeds the record count limit');
    try {
      if (row.error) throw row.error;
      const record = objectRecord(row.value), event = normalizeRecord(record, sourceId, mapping);
      const key = event.event_id, previous = identities.get(key);
      if (previous) {
        if (previous.session_id===event.session_id&&previous.event_name===event.event_name&&previous.occurred_at===event.occurred_at&&previous.device===event.device&&previous.excluded===event.excluded&&previous.release_id===event.release_id) {counts.duplicates++; return;}
        counts.conflicts++; throw new DomainError('CONFLICTING_DUPLICATE', 'Conflicting content for the same source/event identity blocks snapshot finalization');
      }
      identities.set(key, event); events.push(event); counts.accepted++; if (event.excluded) counts.excluded++;
      provenance.push({row: row.row, event_id: event.event_id, source_timestamp: mapped(record, mapping.occurred_at ?? defaults.occurred_at) as string, normalized_timestamp: event.occurred_at, ...(row.locator ? {locator: row.locator} : {})});
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      counts.rejected++; counts.issueTotal++;
      if (issues.length < limits.issues) issues.push({row: row.row, code: error.code, message: error.message, severity: 'blocker', ...(row.locator ? {locator: row.locator} : {})});
    }
  };
  const finish = (raw: string, decoded: string, format: ImportFormat): NormalizationResult => {
    const ordered = [...events].sort((a, b) => a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
    return {events, issues, counts, canFinalize: counts.rejected === 0 && counts.conflicts === 0,
      hashes: {raw, decoded, normalized: hashCanonicalArray(ordered), mapping: hash({source_id: sourceId, record_kind: 'analytics', schema_version: 1, fields: {...defaults, ...Object.fromEntries(Object.entries(mapping).filter(([, value]) => value !== undefined))}})}, provenance, format};
  };
  return {add, finish};
}
export function normalizeAnalytics(bytes: Buffer, format: ImportFormat, sourceId: string, mapping: AnalyticsMapping = {}, overrides: Partial<ImportLimits> = {}): NormalizationResult {
  const limits = limitsFor(overrides);
  demand(['csv', 'json', 'jsonl'].includes(format), 'UNSUPPORTED_FORMAT', 'Supported formats are CSV, JSON and JSONL');
  checkMapping(sourceId, mapping);
  demand(bytes.length <= limits.inputBytes && bytes.length <= limits.expandedBytes, 'BYTE_LIMIT', 'Import exceeds the byte limit');
  let text: string;
  try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {throw new DomainError('INVALID_ENCODING', 'Import must be valid UTF-8');}
  text = text.replace(/^\uFEFF/, '');
  const result = collector(sourceId, mapping, limits);
  for (const row of records(text, format, limits)) result.add(row);
  return result.finish(byteHash(bytes), byteHash(bytes), format);
}
export function normalizeGzipJsonl(bytes: Buffer, sourceId: string, mapping: AnalyticsMapping = {}, overrides: Partial<ImportLimits> = {}): NormalizationResult {
  const limits = limitsFor(overrides);
  demand(bytes.length <= limits.inputBytes, 'BYTE_LIMIT', 'Compressed import exceeds the input byte limit');
  demand(bytes[0] === 0x1f && bytes[1] === 0x8b, 'INVALID_GZIP', 'Expected gzip JSONL content');
  const expandedCeiling = Math.min(limits.expandedBytes, Math.max(bytes.length, 1) * limits.expansionRatio);
  let decoded: Buffer;
  try {decoded = gunzipSync(bytes, {maxOutputLength: expandedCeiling});}
  catch {throw new DomainError('GZIP_OR_EXPANSION_LIMIT', 'Malformed/truncated gzip or expanded content exceeds the configured limit');}
  checkMapping(sourceId,mapping);
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(decoded).replace(/^\uFEFF/,'');}catch{throw new DomainError('INVALID_ENCODING','Import must be valid UTF-8');}
  const collected=collector(sourceId,mapping,limits);for(const row of records(text,'jsonl',limits))collected.add(row);
  const result=collected.finish(byteHash(decoded),byteHash(decoded),'jsonl');
  result.hashes.raw = byteHash(bytes); result.hashes.decoded = byteHash(decoded);
  return result;
}
export function requireFinalizableImport(result: NormalizationResult): FaultlineCanonicalEvent[] {
  demand(result.canFinalize && result.counts.rejected === 0 && result.counts.conflicts === 0, 'IMPORT_BLOCKED', 'Resolve all invalid records and conflicting event identities in a corrected import revision');
  return result.events;
}

async function collectCsvStream(input: AsyncIterable<Uint8Array>, limits: ImportLimits, add: (row: ParsedRow) => void, signal?: AbortSignal): Promise<string> {
  const rawHash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', {fatal: true}), config = csvOptions(limits);
  let inputBytes = 0;
  async function* boundedInput() {
    for await (const chunk of input) {
      signal?.throwIfAborted(); inputBytes += chunk.byteLength;
      demand(inputBytes <= limits.inputBytes && inputBytes <= limits.expandedBytes, 'BYTE_LIMIT', 'CSV import exceeds the input byte limit', 413);
      rawHash.update(chunk);
      try {yield decoder.decode(chunk, {stream: true});} catch {throw new DomainError('INVALID_ENCODING', 'CSV import must be valid UTF-8');}
    }
    try {const tail = decoder.decode(); if (tail) yield tail;} catch {throw new DomainError('INVALID_ENCODING', 'CSV ended within an incomplete UTF-8 character');}
  }
  const sink = new Writable({objectMode: true, write(row: ParsedRow, _encoding, callback) {
    try {signal?.throwIfAborted(); add(row); callback();} catch (error) {callback(error as Error);}
  }});
  try {
    await pipeline(Readable.from(boundedInput()), parseCsv(config.options), sink, {signal});
    config.requireHeader();
    return rawHash.digest('hex');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    csvFailure(error);
  }
}

async function collectJsonlStream(input: AsyncIterable<Uint8Array>, limits: ImportLimits, add: (row: ParsedRow) => void, options: {gzip?: boolean; signal?: AbortSignal}): Promise<{raw: string; decoded: string}> {
  const rawHash = createHash('sha256'), decodedHash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let inputBytes = 0, decodedBytes = 0, pending = '', row = 1, started = false;
  async function* boundedInput() {
    for await (const chunk of input) {
      options.signal?.throwIfAborted();
      inputBytes += chunk.byteLength; demand(inputBytes <= limits.inputBytes, 'BYTE_LIMIT', 'Import exceeds the input byte limit');
      rawHash.update(chunk); yield chunk;
    }
  }
  function consumeLine(line: string) {
    const current = row++;
    demand(Buffer.byteLength(line) <= limits.recordBytes, 'RECORD_LIMIT', `JSONL line ${current} exceeds the record limit`);
    if (!line.trim()) return;
    let value: unknown;
    try {value = json(line.replace(/\r$/, ''), limits);}
    catch (error) {if (!(error instanceof DomainError)) throw error; add({row: current, value: undefined, error}); return;}
    add({row: current, value});
  }
  function consumeText(text: string) {
    if (!started && text.length) {text = text.replace(/^\uFEFF/, ''); started = true;}
    pending += text;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {consumeLine(pending.slice(0, end)); pending = pending.slice(end + 1);}
    demand(Buffer.byteLength(pending) <= limits.recordBytes, 'RECORD_LIMIT', `JSONL line ${row} exceeds the record limit`);
  }
  const sink = new Writable({write(chunk: Buffer, _encoding, callback) {
    try {
      options.signal?.throwIfAborted();
      decodedBytes += chunk.byteLength;
      demand(decodedBytes <= limits.expandedBytes, 'BYTE_LIMIT', 'Import exceeds the expanded byte limit');
      if (options.gzip) demand(decodedBytes <= Math.max(1, inputBytes) * limits.expansionRatio, 'EXPANSION_LIMIT', 'Gzip exceeds the expansion ratio');
      decodedHash.update(chunk);
      try {consumeText(decoder.decode(chunk, {stream: true}));} catch (error) {if (error instanceof TypeError) throw new DomainError('INVALID_ENCODING', 'Import must be valid UTF-8'); throw error;}
      callback();
    } catch (error) {callback(error as Error);}
  }});
  try {
    const source = Readable.from(boundedInput());
    if (options.gzip) await pipeline(source, createGunzip(), sink, {signal: options.signal});
    else await pipeline(source, sink, {signal: options.signal});
    try {consumeText(decoder.decode());} catch (error) {if (error instanceof TypeError) throw new DomainError('INVALID_ENCODING', 'Import ended within an incomplete UTF-8 character'); throw error;}
    if (pending.length) consumeLine(pending);
    return {raw: rawHash.digest('hex'), decoded: decodedHash.digest('hex')};
  } catch (error) {
    if (error instanceof DomainError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new DomainError(options.gzip ? 'INVALID_GZIP' : 'IMPORT_STREAM_FAILED', options.gzip ? 'Malformed or truncated gzip JSONL' : 'Input stream failed; no import can be finalized');
  }
}

/** Production CSV path uses the pinned parser's Transform API; raw CSV is never retained in full. */
export async function normalizeCsvStream(input: AsyncIterable<Uint8Array>, sourceId: string, mapping: AnalyticsMapping = {}, options: {limits?: Partial<ImportLimits>; signal?: AbortSignal} = {}): Promise<NormalizationResult> {
  const limits = limitsFor(options.limits ?? {}); checkMapping(sourceId, mapping);
  const result = collector(sourceId, mapping, limits), raw = await collectCsvStream(input, limits, result.add, options.signal);
  return result.finish(raw, raw, 'csv');
}

/** Incremental production ingestion: decoded text is retained only for the current bounded line. */
export async function normalizeJsonlStream(input: AsyncIterable<Uint8Array>, sourceId: string, mapping: AnalyticsMapping = {}, options: {gzip?: boolean; limits?: Partial<ImportLimits>; signal?: AbortSignal} = {}): Promise<NormalizationResult> {
  const limits = limitsFor(options.limits ?? {}); checkMapping(sourceId, mapping);
  const result = collector(sourceId, mapping, limits), hashes = await collectJsonlStream(input, limits, result.add, options);
  return result.finish(hashes.raw, hashes.decoded, 'jsonl');
}

export type EvidenceImportKind = 'support' | 'release';
export interface EvidenceMapping {
  record_kind: EvidenceImportKind; schema_version: 1;
  id?: FieldPath; event_time?: FieldPath; text?: FieldPath; device?: FieldPath; provenance?: FieldPath;
}
export interface CanonicalImportedEvidence {
  kind: EvidenceImportKind; schema_version: 1; source_id: string; id: string;
  event_time: FaultlineEvidence['event_time']; text: string; device: string | null; provenance: string;
  deployment_status: 'not_proven_by_release_record' | null;
  reported_verified_user: boolean | null;
  verification_status: 'not_established_by_import';
}
export interface EvidenceNormalizationResult {
  records: CanonicalImportedEvidence[]; issues: ImportIssue[];
  counts: {input: number; accepted: number; rejected: number; duplicates: number; conflicts: number; unknown_times: number; issueTotal: number};
  captured_at: string; canFinalize: boolean;
  hashes: {raw: string; normalized: string; mapping: string};
}
function evidenceTime(value: unknown): FaultlineEvidence['event_time'] {
  if (value === undefined || value === null || value === '') return {kind: 'unknown', raw_description: 'Occurrence time was not supplied'};
  if (typeof value === 'string') {
    // Calendar-looking inputs are validation failures; vague human descriptions remain uncertainty.
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return {kind: 'exact', at: normalizeEventTime(value)};
    demand(value.length <= 1000, 'INVALID_TIME_DESCRIPTION', 'Uncertain time description exceeds its limit');
    return {kind: 'unknown', raw_description: value};
  }
  const input = objectRecord(value);
  if (input.kind === 'exact') return {kind: 'exact', at: normalizeEventTime(input.at)};
  if (input.kind === 'range') {
    const start = normalizeEventTime(input.start), end = normalizeEventTime(input.end);
    demand(eventMicros(start) < eventMicros(end), 'INVALID_TIME_RANGE', 'Occurrence time range must be positive');
    return {kind: 'range', start, end};
  }
  demand(input.kind === 'unknown' && typeof input.raw_description === 'string' && input.raw_description.length > 0 && input.raw_description.length <= 1000, 'INVALID_EVENT_TIME', 'Expected exact, range or unknown occurrence time');
  return {kind: 'unknown', raw_description: input.raw_description};
}
function evidenceCollector(kind: EvidenceImportKind, sourceId: string, capturedAt: string, mappingValue: EvidenceMapping | undefined, limits: ImportLimits) {
  demand(kind === 'support' || kind === 'release', 'INVALID_RECORD_KIND', 'Expected support or release import');
  demand(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(sourceId), 'INVALID_SOURCE', 'Invalid source identity');
  metadataMicros(capturedAt);
  const mapping = mappingValue ?? {record_kind: kind, schema_version: 1};
  demand(mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping), 'INVALID_MAPPING', 'Evidence mapping must be a finite object');
  demand(mapping.record_kind === kind && mapping.schema_version === 1, 'INVALID_MAPPING', 'Mapping discriminator/version must match the imported record kind');
  const fields = {id: 'id', event_time: kind === 'support' ? 'occurred_at' : 'published_at', text: kind === 'support' ? 'text' : 'description', device: 'device', provenance: 'provenance', ...mapping};
  for (const key of Object.keys(mapping)) demand(['record_kind', 'schema_version', 'id', 'event_time', 'text', 'device', 'provenance'].includes(key), 'INVALID_MAPPING', 'Unsupported evidence mapping field');
  for (const field of ['id', 'event_time', 'text', 'device', 'provenance'] as const) pathParts(fields[field]);
  const accepted: CanonicalImportedEvidence[] = [], issues: ImportIssue[] = [], identities = new Map<string, string>();
  const counts = {input: 0, accepted: 0, rejected: 0, duplicates: 0, conflicts: 0, unknown_times: 0, issueTotal: 0};
  const issue = (row: ParsedRow, code: string, message: string, severity: ImportIssue['severity']) => {counts.issueTotal++; if (issues.length < limits.issues) issues.push({row: row.row, code, message, severity, ...(row.locator ? {locator: row.locator} : {})});};
  const add = (row: ParsedRow) => {
    counts.input++; demand(counts.input <= limits.records, 'RECORD_LIMIT', 'Import exceeds the record count limit');
    try {
      if (row.error) throw row.error;
      const record = objectRecord(row.value);
      demand(!Object.hasOwn(record, 'kind') || record.kind === kind, 'INVALID_RECORD_KIND', 'Record discriminator does not match the selected import kind');
      demand(!Object.hasOwn(record, 'schema_version') || record.schema_version === 1, 'UNSUPPORTED_SCHEMA', 'Unsupported record schema version');
      demand(!Object.hasOwn(record, 'source_id') || record.source_id === sourceId, 'SOURCE_MISMATCH', 'Record source does not match the configured logical source');
      const get = (field: 'id' | 'event_time' | 'text' | 'device' | 'provenance') => mapped(record, fields[field]);
      const recordId = get('id'), body = get('text'), device = get('device'), provenance = get('provenance');
      demand(typeof recordId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(recordId), 'INVALID_RECORD_ID', 'Evidence identity must be a stable string');
      demand(typeof body === 'string' && body.length <= 8000, 'INVALID_TEXT', 'Evidence text must be a string of at most 8000 characters');
      demand(device === undefined || device === null || (typeof device === 'string' && device.length > 0 && device.length <= 64), 'INVALID_DEVICE', 'Invalid evidence device');
      demand(provenance === undefined || (typeof provenance === 'string' && provenance.length <= 1000), 'INVALID_PROVENANCE', 'Invalid evidence provenance');
      const normalized: CanonicalImportedEvidence = {kind, schema_version: 1, source_id: sourceId, id: recordId, event_time: evidenceTime(get('event_time')), text: body, device: typeof device === 'string' ? device : null, provenance: typeof provenance === 'string' ? provenance : 'imported_file', deployment_status: kind === 'release' ? 'not_proven_by_release_record' : null, reported_verified_user: typeof record.verified_user_report === 'boolean' ? record.verified_user_report : null, verification_status: 'not_established_by_import'};
      const content = hash(normalized), previous = identities.get(recordId);
      if (previous === content) {counts.duplicates++; return;}
      if (previous) {counts.conflicts++; throw new DomainError('CONFLICTING_DUPLICATE', 'Conflicting content for the same source/evidence identity requires a corrected revision');}
      identities.set(recordId, content); accepted.push(normalized); counts.accepted++;
      if (normalized.event_time.kind === 'unknown') {counts.unknown_times++; issue(row, 'UNKNOWN_OCCURRENCE_TIME', 'Occurrence time remains unknown; capture time cannot substitute for it', 'warning');}
      if (kind === 'release' && record.deployment_status && record.deployment_status !== 'not_proven_by_release_record') issue(row, 'UNVERIFIED_DEPLOYMENT_CLAIM', 'Imported release metadata cannot prove a served deployment identity', 'warning');
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      counts.rejected++; issue(row, error.code, error.message, 'blocker');
    }
  };
  const finish = (raw: string): EvidenceNormalizationResult => ({records: accepted, issues, counts, captured_at: capturedAt, canFinalize: counts.rejected === 0 && counts.conflicts === 0,
    hashes: {raw, normalized: hash([...accepted].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), mapping: hash({source_id: sourceId, ...fields})}});
  return {add, finish};
}

/** Tickets and releases have their own discriminator and never require analytics session fields. */
export function normalizeEvidenceRecords(bytes: Buffer, format: ImportFormat, kind: EvidenceImportKind, sourceId: string, capturedAt: string, mappingValue?: EvidenceMapping, overrides: Partial<ImportLimits> = {}): EvidenceNormalizationResult {
  const limits = limitsFor(overrides);
  demand(['csv', 'json', 'jsonl'].includes(format), 'UNSUPPORTED_FORMAT', 'Supported formats are CSV, JSON and JSONL');
  const result = evidenceCollector(kind, sourceId, capturedAt, mappingValue, limits);
  demand(bytes.length <= limits.inputBytes && bytes.length <= limits.expandedBytes, 'BYTE_LIMIT', 'Import exceeds the byte limit');
  let text: string; try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/, '');} catch {throw new DomainError('INVALID_ENCODING', 'Import must be valid UTF-8');}
  for (const row of records(text, format, limits)) result.add(row);
  return result.finish(byteHash(bytes));
}

/** Bounded CSV/JSONL evidence ingestion shares the exact synchronous collector. */
export async function normalizeEvidenceStream(input: AsyncIterable<Uint8Array>, format: 'csv' | 'jsonl', kind: EvidenceImportKind, sourceId: string, capturedAt: string, mapping?: EvidenceMapping, options: {gzip?: boolean; limits?: Partial<ImportLimits>; signal?: AbortSignal} = {}): Promise<EvidenceNormalizationResult> {
  demand(format === 'csv' || format === 'jsonl', 'UNSUPPORTED_FORMAT', 'Evidence streaming requires CSV or JSONL');
  demand(!options.gzip || format === 'jsonl', 'UNSUPPORTED_FORMAT', 'Gzip evidence streaming requires JSONL');
  const limits = limitsFor(options.limits ?? {}), result = evidenceCollector(kind, sourceId, capturedAt, mapping, limits);
  const raw = format === 'csv' ? await collectCsvStream(input, limits, result.add, options.signal) : (await collectJsonlStream(input, limits, result.add, options)).raw;
  return result.finish(raw);
}
