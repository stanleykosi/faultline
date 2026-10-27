export interface JobEvent {id: string; status: string; attempt?: number; created_at: string;}
export interface JobConnection {state: 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'access_closed' | 'closed'; cursor: string | null; reason?: string; retry_in_ms?: number;}
export interface JobStreamView {connection: JobConnection; lastEvent: JobEvent | null; lastJobReadAt: string | null;}
export interface JobStreamOptions {signal: AbortSignal; cursor: string | null; onEvent: (event: JobEvent) => void; onConnection: (connection: JobConnection) => void;}
const states = new Set(['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed', 'waiting_for_input', 'blocked']);
const maxLine = 8192, maxFrameBytes = 16384, maxConnectionBytes = 1048576;
export const isJobCursor = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,18}$/.test(value) && BigInt(value) > 0n;
const protocolError = () => new Error('The progress stream was invalid or exceeded its bounds. Its event data cannot establish a job outcome.');

/** Finite SSE parser. Only complete, validated job frames can advance a cursor. */
export class JobEventParser {
  private decoder = new TextDecoder('utf-8', {fatal: true});
  private line = ''; private cr = false; private event = ''; private id = ''; private data: string[] = [];
  private frameBytes = 0; private totalBytes = 0; private eventSeen = false; private idSeen = false; private closed = false;
  public cursor: string | null;
  constructor(cursor: string | null, private onEvent: (event: JobEvent) => void, private onAccessClosed: () => void) {
    if (cursor !== null && cursor !== '0' && !isJobCursor(cursor)) throw protocolError(); this.cursor = cursor === '0' ? null : cursor;
  }
  push(bytes: Uint8Array) {
    if (this.closed) return;
    this.totalBytes += bytes.byteLength; if (bytes.byteLength > 65536 || this.totalBytes > maxConnectionBytes) throw protocolError();
    try {this.characters(this.decoder.decode(bytes, {stream: true}));} catch (cause) {if (cause instanceof TypeError) throw protocolError(); throw cause;}
  }
  finish() {
    if (this.closed) return;
    try {this.characters(this.decoder.decode());} catch {throw protocolError();}
    // A disconnected wire may end mid-frame. Discard it; replay uses the last
    // fully validated cursor and must never infer completion from EOF.
    this.line = ''; this.reset();
  }
  private characters(value: string) {
    for (const char of value) {
      if (this.closed) break;
      if (this.cr) {this.cr = false; if (char === '\n') continue;}
      if (char === '\r' || char === '\n') {this.readLine(); this.cr = char === '\r';}
      else {this.line += char; if (this.line.length > maxLine) throw protocolError();}
    }
  }
  private readLine() {
    const line = this.line; this.line = ''; this.frameBytes += new TextEncoder().encode(line).byteLength + 1;
    if (this.frameBytes > maxFrameBytes) throw protocolError();
    if (!line) {this.dispatch(); this.reset(); return;}
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon), raw = colon < 0 ? '' : line.slice(colon + 1), value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') {if (this.eventSeen) throw protocolError(); this.eventSeen = true; this.event = value;}
    else if (field === 'id') {if (this.idSeen) throw protocolError(); this.idSeen = true; this.id = value;}
    else if (field === 'data') this.data.push(value);
    // Server retry directives and unknown fields never control client timing.
  }
  private dispatch() {
    if (!this.eventSeen && !this.idSeen && !this.data.length) return;
    if (this.event === 'access_closed') {this.closed = true; this.onAccessClosed(); return;}
    if (this.event !== 'job' || !isJobCursor(this.id) || !this.data.length) throw protocolError();
    let value: unknown; try {value = JSON.parse(this.data.join('\n'));} catch {throw protocolError();}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError();
    const payload = value as Record<string, unknown>;
    if (typeof payload.status !== 'string' || !states.has(payload.status) || typeof payload.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(payload.created_at) || !Number.isFinite(Date.parse(payload.created_at)) || (payload.attempt !== undefined && (!Number.isSafeInteger(payload.attempt) || Number(payload.attempt) < 0))) throw protocolError();
    if (this.cursor !== null && BigInt(this.id) <= BigInt(this.cursor)) return;
    const event: JobEvent = {id: this.id, status: payload.status, created_at: payload.created_at, ...(payload.attempt !== undefined ? {attempt: payload.attempt as number} : {})};
    this.onEvent(event); this.cursor = this.id;
  }
  private reset() {this.event = ''; this.id = ''; this.data = []; this.eventSeen = false; this.idSeen = false; this.frameBytes = 0;}
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {reject(new DOMException('Cancelled', 'AbortError')); return;}
  const abort = () => {clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError'));};
  const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, ms); signal.addEventListener('abort', abort, {once: true});
});
type StreamTransport = {fetch: typeof fetch; sleep: typeof sleep; readTimeoutMs?: number; connectionTimeoutMs?: number;};

/** Injectable wire transport for focused protocol tests; production uses fetch. */
export function createJobEventWatcher(transport: StreamTransport) {
  return async function watch(path: string, options: JobStreamOptions): Promise<void> {
    if (!/^\/api\/v1\/workspaces\/[A-Za-z0-9:_-]{1,128}\/jobs\/[A-Za-z0-9:_-]{1,128}\/events$/.test(path)) throw protocolError();
    const {signal, onEvent, onConnection} = options; let cursor = options.cursor === '0' ? null : options.cursor, failures = 0;
    if (cursor !== null && !isJobCursor(cursor)) throw protocolError();
    const connection = (state: JobConnection['state'], reason?: string, retry_in_ms?: number) => {if (!signal.aborted) onConnection({state, cursor, ...(reason ? {reason} : {}), ...(retry_in_ms !== undefined ? {retry_in_ms} : {})});};
    while (!signal.aborted) {
      const request = new AbortController(), abort = () => request.abort(); signal.addEventListener('abort', abort, {once: true});
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, accessClosed = false, protocolFailed = false, received = false;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      const timed = async <T,>(promise: Promise<T>, maximum: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
        const stop = new Promise<never>((_, reject) => {onAbort = () => reject(new DOMException('Cancelled', 'AbortError')); request.signal.addEventListener('abort', onAbort, {once: true}); timer = setTimeout(() => {reject(new Error('Progress stream read deadline exceeded.')); request.abort();}, maximum); if (request.signal.aborted) onAbort();});
        try {return await Promise.race([promise, stop]);} finally {if (timer) clearTimeout(timer); if (onAbort) request.signal.removeEventListener('abort', onAbort);}
      };
      connection(failures ? 'reconnecting' : 'connecting');
      try {
        const response = await timed(transport.fetch(path, {method: 'GET', headers: {Accept: 'text/event-stream', ...(cursor !== null ? {'Last-Event-ID': cursor} : {})}, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: request.signal}), transport.connectionTimeoutMs ?? 10000);
        if ([401, 403, 404].includes(response.status)) {accessClosed = true; connection('access_closed', 'Job access is unavailable. Previously displayed job authority has been cleared.'); return;}
        if (!response.ok) {connection('unavailable', `Progress request returned HTTP ${response.status}. No current event progress is established.`); if (response.status < 500 && response.status !== 429) return; throw new Error('Progress request unavailable.');}
        if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {protocolFailed = true; throw protocolError();}
        reader = response.body.getReader(); lifetime = setTimeout(() => request.abort(), 35000); connection('connected');
        const parser = new JobEventParser(cursor, event => {if (!signal.aborted) {onEvent(event); cursor = event.id;}}, () => {accessClosed = true; connection('access_closed', 'Job access closed. Previously displayed job authority has been cleared.'); request.abort();});
        while (!signal.aborted && !accessClosed) {
          const part = await timed(reader.read(), transport.readTimeoutMs ?? 10000); if (part.done) {try {parser.finish();} catch {protocolFailed = true; throw protocolError();} break;}
          received = true; try {parser.push(part.value);} catch {protocolFailed = true; throw protocolError();}
        }
        if (accessClosed || signal.aborted) return;
      } catch {
        if (signal.aborted || accessClosed) return;
        if (protocolFailed) {connection('unavailable', 'Progress events were invalid or exceeded their bounds. Recorded-job polling remains separate.'); return;}
      } finally {
        request.abort(); signal.removeEventListener('abort', abort); if (lifetime) clearTimeout(lifetime);
        if (reader) {void reader.cancel().catch(() => {}); try {reader.releaseLock();} catch { /* Pending read cancellation still belongs to the aborted request. */ }}
      }
      failures = received ? 0 : failures + 1;
      if (failures >= 6) {connection('unavailable', 'Progress transport remains unavailable after bounded retries. Use recorded-job refresh; polling continues.'); return;}
      const delay = Math.min(15000, 1000 * 2 ** Math.max(0, failures - 1)); connection('reconnecting', 'Progress transport is disconnected; last shown job information may be stale until a recorded-job read succeeds.', delay);
      try {await transport.sleep(delay, signal);} catch {return;}
    }
  };
}

export function watchJobEvents(path: string, options: JobStreamOptions): Promise<void> {return createJobEventWatcher({fetch: globalThis.fetch.bind(globalThis), sleep})(path, options);}

/** Cursor only, never event payloads, credentials or authority. Bounded per tab. */
export class JobCursorStore {
  private values = new Map<string, string>();
  constructor(private storage?: Pick<Storage, 'getItem' | 'setItem'>) {}
  get(binding: string): string | null {
    if (this.values.has(binding)) return this.values.get(binding)!;
    try {const raw = this.storage?.getItem('faultline.job-event-cursors') ?? '[]'; if (raw.length > 16384) return null; const rows: unknown = JSON.parse(raw); if (Array.isArray(rows) && rows.length <= 20) for (const row of rows) if (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && row[0].length <= 400 && isJobCursor(row[1])) this.values.set(row[0], row[1]);} catch { /* Storage is optional; in-memory reconnect still works. */ }
    return this.values.get(binding) ?? null;
  }
  set(binding: string, cursor: string) {
    if (binding.length > 400 || !isJobCursor(cursor)) throw protocolError(); const previous = this.get(binding); if (previous && BigInt(cursor) <= BigInt(previous)) return;
    this.values.delete(binding); this.values.set(binding, cursor); while (this.values.size > 20) this.values.delete(this.values.keys().next().value!);
    try {this.storage?.setItem('faultline.job-event-cursors', JSON.stringify([...this.values]));} catch { /* No token or business result is written as a fallback. */ }
  }
}
