import {isIP} from 'node:net';
import {TextDecoder} from 'node:util';
import {byteHash} from '../canonical.js';

/** Must enforce DNS/IP policy, byte/deadline caps, and return redirects without following them. */
export interface SafeHttp {
  get(url: string, options?: {headers?: Record<string, string>; allowedOrigins?: string[]; maxBytes?: number}): Promise<{status: number; headers: Record<string, string>; body: Buffer}>;
}
export type WireResponse = Awaited<ReturnType<SafeHttp['get']>>;
export interface ExecutionControl {signal?: AbortSignal; assertActive?: () => Promise<void>;}
export class ConnectorError extends Error {
  constructor(public code: string, message: string, public details: {http_status?: number; request_id?: string; retry_at?: string} = {}) {super(message);}
}
export function requireWire(condition: unknown, code: string, message: string): asserts condition {if (!condition) throw new ConnectorError(code, message);}
export async function checkActive(control: ExecutionControl = {}): Promise<void> {control.signal?.throwIfAborted(); await control.assertActive?.(); control.signal?.throwIfAborted();}
export function header(response: WireResponse, name: string): string | undefined {const key = Object.keys(response.headers).find(k => k.toLowerCase() === name.toLowerCase()); return key ? response.headers[key] : undefined;}
export function safeRequestId(response: WireResponse): string | undefined {const value = header(response, 'x-github-request-id') ?? header(response, 'x-request-id'); return value && /^[A-Za-z0-9:_-]{1,100}$/.test(value) ? value : undefined;}
export function approvedHttps(url: string, origins: readonly string[]): URL {
  let parsed: URL;
  try {parsed = new URL(url);} catch {throw new ConnectorError('INVALID_PROVIDER_URL', 'Provider URL is malformed.');}
  requireWire(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash && (!parsed.port || parsed.port === '443'), 'UNSAFE_PROVIDER_URL', 'Provider requests require an approved HTTPS origin without credentials or fragments.');
  requireWire(!isIP(parsed.hostname.replace(/^\[|\]$/g, '')) && parsed.hostname !== 'localhost' && !parsed.hostname.endsWith('.localhost') && !parsed.hostname.endsWith('.local'), 'UNSAFE_PROVIDER_URL', 'Provider requests cannot target a local or literal network address.');
  requireWire(origins.includes(parsed.origin), 'UNAPPROVED_ORIGIN', 'The provider destination is outside the configured origin allowlist.');
  return parsed;
}
export function providerOrigin(origin: string): string {let value: URL; try {value = new URL(origin);} catch {throw new ConnectorError('INVALID_PROVIDER_ORIGIN', 'Provider configuration must contain a valid origin.');} const parsed = approvedHttps(origin, [value.origin]); requireWire(parsed.pathname === '/' && !parsed.search, 'INVALID_PROVIDER_ORIGIN', 'Provider configuration must contain only an origin.'); return parsed.origin;}
export async function getWire(http: SafeHttp, url: string, options: Parameters<SafeHttp['get']>[1], control: ExecutionControl = {}): Promise<WireResponse> {
  await checkActive(control);
  let response: WireResponse;
  try {response = await http.get(url, options);} catch (error) {if (error instanceof ConnectorError || (error instanceof Error && error.name === 'AbortError')) throw error; throw new ConnectorError('PROVIDER_UNAVAILABLE', 'The provider request failed. Retry through the bounded capture job.');}
  await checkActive(control);
  requireWire(Buffer.isBuffer(response.body) && response.body.length <= (options?.maxBytes ?? 1_048_576), 'PROVIDER_BYTE_LIMIT', 'Provider response exceeds the configured byte limit.');
  return response;
}
export function requireSuccess(response: WireResponse, github = false, clock = Date.now()): void {
  if (response.status === 200) return;
  const details: ConnectorError['details'] = {http_status: response.status}; const requestId = safeRequestId(response); if (requestId) details.request_id = requestId;
  const retryAfter = header(response, 'retry-after'); const exhausted = header(response, 'x-ratelimit-remaining') === '0';
  let secondaryLimit = false;
  if (github && response.status === 403) {try {const value = object(strictJson(response.body)); secondaryLimit = typeof value.message === 'string' && /secondary rate limit/i.test(value.message);} catch { /* Unparseable error text grants no capability. */ }}
  if (response.status === 429 || (response.status === 403 && (retryAfter !== undefined || exhausted || secondaryLimit))) {
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
    const retryDate = retryAfter && seconds === undefined ? Date.parse(retryAfter) : undefined;
    const reset = Number(header(response, 'x-ratelimit-reset')) * 1000;
    const target = seconds !== undefined ? clock + seconds * 1000 : retryDate && Number.isFinite(retryDate) ? retryDate : exhausted && Number.isFinite(reset) && reset > clock ? reset : clock + (github ? 60_000 : 2000);
    details.retry_at = new Date(Math.min(Math.max(clock + (github ? 60_000 : 1000), target), clock + 7 * 24 * 60 * 60 * 1000)).toISOString();
    throw new ConnectorError('PROVIDER_RATE_LIMITED', 'The provider deferred this read. Schedule a bounded retry at the recorded time.', details);
  }
  if (response.status === 401 || response.status === 403) throw new ConnectorError('PROVIDER_UNAUTHORIZED', 'The provider credential does not permit this selected read.', details);
  if (response.status === 404) throw new ConnectorError('PROVIDER_NOT_FOUND', 'The selected provider resource is absent or inaccessible.', details);
  if (response.status === 304) throw new ConnectorError('PROVIDER_CACHE_MISS', 'A not-modified response has no matching complete local object.', details);
  if (response.status >= 500) {details.retry_at = new Date(clock + 2000).toISOString(); throw new ConnectorError('PROVIDER_UNAVAILABLE', 'The provider is temporarily unavailable. Use a bounded job retry.', details);}
  throw new ConnectorError('PROVIDER_RESPONSE_REJECTED', 'The provider rejected the selected read or returned an unsupported response.', details);
}

/** JSON.parse establishes syntax; this focused lexical pass rejects keys it would overwrite. */
export function strictJson(bytes: Buffer, maxBytes = 1_048_576, maxDepth = 32): unknown {
  requireWire(bytes.length <= maxBytes, 'PROVIDER_BYTE_LIMIT', 'Provider JSON exceeds the configured byte limit.');
  let text: string, result: unknown;
  try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/, ''); result = JSON.parse(text);} catch {throw new ConnectorError('INVALID_PROVIDER_JSON', 'The provider returned malformed JSON or invalid UTF-8.');}
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '{' || character === '[') {stack.push(character === '{' ? new Set() : null); requireWire(stack.length <= maxDepth, 'PROVIDER_DEPTH_LIMIT', 'Provider JSON exceeds the configured nesting depth.');}
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = i++;
      while (i < text.length) {if (text[i] === '\\') i += 2; else if (text[i] === '"') break; else i++;}
      let next = i + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)) as string; const keys = stack.at(-1);
        requireWire(keys && !keys.has(key), 'DUPLICATE_PROVIDER_KEY', 'Provider JSON contains a duplicate object key.');
        requireWire(!['__proto__', 'constructor', 'prototype'].includes(key), 'UNSAFE_PROVIDER_KEY', 'Provider JSON contains an unsafe object key.'); keys.add(key);
      }
    }
  }
  function numbers(value: unknown): void {if (typeof value === 'number') requireWire(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), 'UNSAFE_PROVIDER_NUMBER', 'Provider numeric precision cannot be represented safely.'); else if (value && typeof value === 'object') for (const child of Object.values(value)) numbers(child);}
  numbers(result); return result;
}
export function object(value: unknown): Record<string, unknown> {requireWire(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_PROVIDER_SCHEMA', 'Provider response must contain an object.'); return value as Record<string, unknown>;}
export function text(value: unknown, field: string, max = 2000): string {requireWire(typeof value === 'string' && value.length > 0 && value.length <= max, 'INVALID_PROVIDER_SCHEMA', `Provider field ${field} is absent or invalid.`); return value;}
export const wireFingerprint = (response: WireResponse) => ({body_hash: byteHash(response.body), request_id: safeRequestId(response) ?? null, etag: header(response, 'etag')?.slice(0, 200) ?? null});
