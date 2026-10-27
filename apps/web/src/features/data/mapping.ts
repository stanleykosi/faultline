import type {RecordKind} from './types';

export type ImportMapping =
  | {kind: 'canonical'; record_type: RecordKind; schema_version: 1}
  | {kind: 'analytics'; event_id_path: FieldPath; session_id_path: FieldPath; event_time_path: FieldPath; event_name_path: FieldPath; device_path: FieldPath; device_map: {source_value: string; cohort: string}[]; precision_policy: 'lossless_utc_microseconds'; excluded_path?: FieldPath; release_id_path?: FieldPath}
  | {kind: 'support'; record_id_path: FieldPath; text_path: FieldPath; event_time_path?: FieldPath; device_path?: FieldPath}
  | {kind: 'release'; record_id_path: FieldPath; description_path: FieldPath; published_at_path?: FieldPath; commit_path?: FieldPath};

export type FieldPath = string | readonly string[];
export type AddressFormat = 'literal' | 'array';
export interface AddressDraft {format: AddressFormat; text: string; needsReview: boolean}

const unsafeFields = new Set(['__proto__', 'constructor', 'prototype']);
export function addressDraft(value: FieldPath | undefined, fallback = ''): AddressDraft {
  return {format: Array.isArray(value) ? 'array' : 'literal', text: Array.isArray(value) ? JSON.stringify(value) : typeof value === 'string' ? value : fallback, needsReview: false};
}
/** Format changes retain the original text and require an explicit resolution; they never translate it. */
export function changeAddressFormat(draft: AddressDraft, format: AddressFormat): AddressDraft {
  return format === draft.format ? draft : {...draft, format, needsReview: true};
}
export function changeAddressText(draft: AddressDraft, text: string): AddressDraft {return {...draft, text, needsReview: false};}
export function parseAddress(text: string, format: AddressFormat, required = false): FieldPath | undefined {
  if (!text.trim()) {if (required) throw new Error('Supply a required source address.'); return undefined;}
  if (format === 'literal') {
    if (text.length > 128 || unsafeFields.has(text)) throw new Error('Source fields must be safe exact names of at most 128 characters.');
    return text;
  }
  if (text.length > 8192) throw new Error('A finite JSON path supports 1–8 safe string components, each at most 128 characters.');
  let value: unknown;
  try {value = JSON.parse(text);} catch {throw new Error('Enter a JSON array of field-name strings, such as ["properties","session_id"].');}
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some(part => typeof part !== 'string' || !part.trim() || part.length > 128 || unsafeFields.has(part))) throw new Error('A finite JSON path supports 1–8 nonempty safe string components, each at most 128 characters.');
  return value as string[];
}
export function confirmAddressFormat(draft: AddressDraft, required = false): AddressDraft {
  parseAddress(draft.text, draft.format, required);
  return {...draft, needsReview: false};
}
function field(form: FormData, name: string, required = false): FieldPath | undefined {
  if (form.get(`${name}_format_reviewed`) === 'pending') throw new Error(`${name}: Address format changed. Edit the field text or explicitly confirm its address before applying the mapping.`);
  const format = String(form.get(`${name}_format`) ?? 'literal');
  if (format !== 'literal' && format !== 'array') throw new Error(`${name}: Select a supported address format.`);
  try {return parseAddress(String(form.get(name) ?? ''), format, required);} catch (cause) {throw new Error(`${name}: ${(cause as Error).message}`);}
}
/** Only exact names, finite string paths, and bounded category pairs are sent. No expressions or executable code. */
export function mappingFromForm(kind: RecordKind, mode: 'canonical' | 'fields', form: FormData): ImportMapping {
  if (mode === 'canonical') return {kind: 'canonical', record_type: kind, schema_version: 1};
  if (kind === 'analytics') {
    const source = form.getAll('device_source').map(String), cohorts = form.getAll('device_cohort').map(String);
    if (!source.length || source.length > 8 || source.length !== cohorts.length) throw new Error('Declare 1–8 device value mappings. Every observed source value needs an explicit group.');
    if (new Set(source).size !== source.length) throw new Error('Each source device value may map to only one group. Remove duplicate source values.');
    const device_map = source.map((source_value, index) => {const cohort = cohorts[index]; if (!source_value.trim() || !cohort.trim() || source_value.length > 200 || cohort.length > 200 || unsafeFields.has(source_value)) throw new Error('Device values and groups must be nonempty safe strings of at most 200 characters.'); return {source_value, cohort};});
    const excluded_path = field(form, 'excluded_path'), release_id_path = field(form, 'release_id_path');
    if (!excluded_path && form.get('exclusion_default') !== 'reviewed') throw new Error('Review the explicit excluded=false default when there is no exclusion field.');
    return {kind, event_id_path: field(form, 'event_id_path', true)!, session_id_path: field(form, 'session_id_path', true)!, event_time_path: field(form, 'event_time_path', true)!, event_name_path: field(form, 'event_name_path', true)!, device_path: field(form, 'device_path', true)!, device_map, precision_policy: 'lossless_utc_microseconds', ...excluded_path ? {excluded_path} : {}, ...release_id_path ? {release_id_path} : {}};
  }
  if (kind === 'support') {const event_time_path = field(form, 'event_time_path'), device_path = field(form, 'device_path'); return {kind, record_id_path: field(form, 'record_id_path', true)!, text_path: field(form, 'text_path', true)!, ...event_time_path ? {event_time_path} : {}, ...device_path ? {device_path} : {}};}
  const published_at_path = field(form, 'published_at_path'), commit_path = field(form, 'commit_path');
  return {kind, record_id_path: field(form, 'record_id_path', true)!, description_path: field(form, 'description_path', true)!, ...published_at_path ? {published_at_path} : {}, ...commit_path ? {commit_path} : {}};
}

export function sameMapping(left: ImportMapping | undefined, right: ImportMapping): boolean {
  if (!left) return false;
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
