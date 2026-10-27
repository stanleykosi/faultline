import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {byteHash} from '../../canonical.js';
import {PostHogExportClient, parsePostHogManifest, type ExportDeclaration, type PostHogConfig} from './index.js';
import {ConnectorError, type SafeHttp, type WireResponse} from '../wire.js';
import {type FaultlineCoverageDeclaration} from '../../../../contracts/src/generated.js';

// Unit wire fixtures only; these HTTP responses are not live provider evidence.
const run = '10000000-0000-4000-8000-000000000001', fileA = '20000000-0000-4000-8000-000000000001', fileB = '20000000-0000-4000-8000-000000000002';
const config: PostHogConfig = {origin: 'https://us.posthog.com', project_id: 42, token: 'unit-test-secret', storage_origins: ['https://objects.example.com'], source_id: 'unit_posthog', workspace_id: 'unit_workspace'};
const declared: ExportDeclaration = {run_id: run, project_id: 42, model: 'events', data_interval_start: '2026-01-01T00:00:00.000Z', data_interval_end: '2026-01-02T00:00:00.000Z', file: {format: 'JSONLines', compression: null}, declared_by: 'owner_fixture', declared_at: '2026-01-03T00:00:00.000Z', artifact_hash: 'a'.repeat(64), provenance: 'owner_declared'};
const coverage: FaultlineCoverageDeclaration = {basis: 'none', event_time_intervals: [], declared_event_watermark: null, statement: 'No upstream completeness attestation was supplied.', reference_evidence_ids: [], late_arrival_hours: 0};
function response(value: unknown, status = 200, headers: Record<string, string> = {}): WireResponse {return {status, headers, body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))};}
const row = (id: string, overrides: Record<string, unknown> = {}) => ({uuid: id, event: 'checkout_started', timestamp: '2026-01-01T10:00:00.123456Z', created_at: '2026-01-01T10:00:02Z', properties: {$session_id: 'session_1', device: 'mobile'}, ...overrides});
function fake(options: {files?: string[]; count?: number | null; download?: (id: string) => WireResponse; redirect?: string; changed?: boolean; manifestStatus?: number} = {}) {
  const calls: {url: string; options?: Parameters<SafeHttp['get']>[1]}[] = []; let manifests = 0;
  const http: SafeHttp = {get: async (url, request) => {calls.push({url, options: request}); const parsed = new URL(url);
    if (parsed.hostname === 'objects.example.com') return options.download?.(parsed.pathname.slice(1)) ?? response(Buffer.from(JSON.stringify(row(parsed.pathname.slice(1))) + '\n'), 200, {'content-type': 'application/jsonl'});
    if (url.includes('/download/')) {const id = parsed.pathname.split('/').at(-2)!; return options.redirect ? response(Buffer.alloc(0), 302, {Location: options.redirect}) : options.download?.(id) ?? response(Buffer.from(JSON.stringify(row(id)) + '\n'));}
    manifests++; return response({status: 'Completed', files: options.changed && manifests > 1 ? [fileB] : options.files ?? [fileA], records_completed: Object.hasOwn(options, 'count') ? options.count : (options.files ?? [fileA]).length}, options.manifestStatus ?? 200, {'x-request-id': 'unit_manifest'});
  }};
  return {http, calls};
}
const isCode = (code: string) => (error: unknown) => error instanceof ConnectorError && error.code === code;

for (const [status, capabilityStatus, code] of [[403, 'unauthorized', 'PROVIDER_UNAUTHORIZED'], [404, 'unsupported', 'PROVIDER_NOT_FOUND']] as const) {
  test(`selected manifest ${status} (${status === 403 ? 'missing read scope' : 'nonexistent or inaccessible run'}) cannot grant export capability or publish an empty capture`, async () => {
    const probeWire = fake({manifestStatus: status});
    const probe = await new PostHogExportClient(probeWire.http, config).probe(declared);
    assert.equal(probe.status, capabilityStatus); assert.equal(probe.reason_code, code);
    assert.equal(probe.read_only, true); assert.deepEqual(probe.features, []);
    const captureWire = fake({manifestStatus: status}); let manifestCheckpoints = 0, fileCheckpoints = 0;
    await assert.rejects(new PostHogExportClient(captureWire.http, config).capture([declared], {device_property: 'device'}, coverage, {
      onManifest: async () => {manifestCheckpoints++;}, onFileReceived: async () => {fileCheckpoints++;},
    }), (error: unknown) => error instanceof ConnectorError && error.code === code && error.details.http_status === status && error.details.request_id === 'unit_manifest' && error.details.retry_at === undefined);
    assert.equal(manifestCheckpoints, 0); assert.equal(fileCheckpoints, 0);
    for (const wire of [probeWire, captureWire]) {
      assert.equal(wire.calls.length, 1);
      const call = wire.calls[0]!;
      assert.equal(call.url, `${config.origin}/api/projects/${config.project_id}/file_download_batch_exports/${run}/`);
      assert.equal(call.url.includes(config.token), false);
      assert.equal(call.url.includes('/download/'), false); assert.equal(call.url.includes('/query'), false);
      assert.deepEqual(call.options?.allowedOrigins, [config.origin]); assert.equal(call.options?.maxBytes, 1_048_576);
      assert.equal(call.options?.headers?.Authorization, `Bearer ${config.token}`);
    }
  });
}

test('completed unit export downloads every manifest file and keeps owner-declared provenance and local hashes', async () => {
  const fixture = fake({files: [fileA, fileB], count: 2}); const result = await new PostHogExportClient(fixture.http, config).capture([declared], {device_property: 'device'}, coverage);
  assert.equal(result.files.length, 2); assert.equal(result.normalization.counts.input, 2); assert.equal(result.normalization.counts.accepted, 2); assert.equal(result.terminal_state, 'complete');
  assert.equal(result.normalization.events[0]!.occurred_at, '2026-01-01T10:00:00.123456Z'); assert.equal(result.declarations[0]!.provenance, 'owner_declared'); assert.equal(result.coverage.basis, 'none');
  assert.equal(result.files[0]!.raw_hash, byteHash(result.files[0]!.raw_bytes)); assert.equal(fixture.calls.filter(call => !call.url.includes('/download/')).length, 2);
  assert.ok(fixture.calls.every(call => !call.url.includes('/query') && !call.url.includes(config.token)));
});

test('signed storage hops never inherit the provider authorization and signed URLs are absent from captured provenance', async () => {
  const fixture = fake({redirect: `https://objects.example.com/${fileA}?signature=unit-private-capability`}); const result = await new PostHogExportClient(fixture.http, config).capture([declared], {device_property: 'device'}, coverage);
  const download = fixture.calls.find(call => call.url.startsWith('https://objects.example.com'))!; assert.equal(download.options?.headers?.Authorization, undefined); assert.equal(download.options?.headers?.Cookie, undefined);
  assert.equal(fixture.calls[0]!.options?.headers?.Authorization, 'Bearer unit-test-secret'); assert.ok(!JSON.stringify(result).includes('signature=unit-private-capability')); assert.ok(!JSON.stringify(result).includes(config.token));
});

test('unapproved and private literal manifest redirects fail before an object request', async () => {
  for (const target of ['https://127.0.0.1/private', 'https://attacker.example.com/file', 'http://objects.example.com/file', 'https://unit-secret@objects.example.com/file']) {
    const fixture = fake({redirect: target}); await assert.rejects(new PostHogExportClient(fixture.http, config).capture([declared], {device_property: 'device'}, coverage)); assert.equal(fixture.calls.length, 2);
  }
});

test('a omitted second object, HTML login response, or mismatched raw count cannot complete extraction', async () => {
  const missing = fake({files: [fileA, fileB], download: id => id === fileB ? response({}, 404) : response(Buffer.from(JSON.stringify(row(id)) + '\n'))});
  await assert.rejects(new PostHogExportClient(missing.http, config).capture([declared], {device_property: 'device'}, coverage), isCode('PROVIDER_NOT_FOUND'));
  const html = fake({download: () => response(Buffer.from('<!doctype html>login'), 200, {'content-type': 'text/html'})}); await assert.rejects(new PostHogExportClient(html.http, config).capture([declared], {device_property: 'device'}, coverage), isCode('INVALID_EXPORT_CONTENT'));
  const mismatch = fake({count: 9}); await assert.rejects(new PostHogExportClient(mismatch.http, config).capture([declared], {device_property: 'device'}, coverage), isCode('EXPORT_RECORD_COUNT_MISMATCH'));
});

test('manifest identity changes and duplicate file identities are rejected', async () => {
  const changed = fake({changed: true}); await assert.rejects(new PostHogExportClient(changed.http, config).capture([declared], {device_property: 'device'}, coverage), isCode('EXPORT_MANIFEST_CHANGED'));
  assert.throws(() => parsePostHogManifest(response({status: 'Completed', files: [fileA, fileA], records_completed: 2}).body), isCode('DUPLICATE_EXPORT_FILE'));
  assert.throws(() => parsePostHogManifest(Buffer.from(`{"status":"Completed","files":[],"records_completed":0,"records_completed":1}`)), isCode('DUPLICATE_PROVIDER_KEY'));
});

test('only provider-confirmed zero rows allow a zero-file capture and an actual empty canonical artifact', async () => {
  const fixture = fake({files: [], count: 0}); const result = await new PostHogExportClient(fixture.http, config).capture([declared], {device_property: 'device'}, coverage); assert.equal(result.empty_artifact?.toString(), '[]\n'); assert.equal(result.normalization.counts.input, 0); assert.equal(result.files.length, 0);
  for (const count of [null, 3]) assert.throws(() => parsePostHogManifest(response({status: 'Completed', files: [], records_completed: count}).body), isCode('EXPORT_EMPTY_UNPROVEN'));
});

test('running, starting, terminal failures and unknown provider statuses remain non-passing', () => {
  for (const status of ['Starting', 'Running']) assert.throws(() => parsePostHogManifest(response({status}).body), isCode('EXPORT_NOT_READY'));
  for (const status of ['Cancelled', 'Failed', 'FailedRetryable', 'FailedBilling', 'Terminated', 'TimedOut']) assert.throws(() => parsePostHogManifest(response({status, error: 'untrusted secret provider text'}).body), isCode('EXPORT_FAILED'));
  assert.throws(() => parsePostHogManifest(response({status: 'NewSuccess'}).body), isCode('UNSUPPORTED_PROVIDER_STATUS'));
});

test('wrong project, missing original request metadata, unsupported format and revoked keys are explicit failures', async () => {
  const fixture = fake(); const client = new PostHogExportClient(fixture.http, config);
  for (const value of [{...declared, project_id: 99}, {...declared, artifact_hash: ''}, {...declared, model: 'persons'}, {...declared, file: {format: 'Parquet', compression: null}}, {...declared, file: {format: 'JSONLines', compression: 'brotli'}}]) await assert.rejects(client.capture([value as ExportDeclaration], {device_property: 'device'}, coverage));
  assert.equal(fixture.calls.length, 0); const revoked = await new PostHogExportClient(fake({manifestStatus: 401}).http, config).probe(declared); assert.equal(revoked.status, 'unauthorized'); assert.equal(revoked.reason_code, 'PROVIDER_UNAUTHORIZED');
});

test('truncated gzip, expansion and raw record caps stop bounded decoding', async () => {
  const compressed = gzipSync(Buffer.from(JSON.stringify(row('gzip_row')) + '\n')); const gzipDeclaration = {...declared, file: {format: 'JSONLines' as const, compression: 'gzip' as const}};
  const good = await new PostHogExportClient(fake({download: () => response(compressed)}).http, config).capture([gzipDeclaration], {device_property: 'device'}, coverage); assert.equal(good.normalization.counts.accepted, 1);
  await assert.rejects(new PostHogExportClient(fake({download: () => response(compressed.subarray(0, compressed.length - 4))}).http, config).capture([gzipDeclaration], {device_property: 'device'}, coverage), isCode('INVALID_EXPORT_GZIP'));
  await assert.rejects(new PostHogExportClient(fake({download: () => response(compressed)}).http, config).capture([gzipDeclaration], {device_property: 'device'}, coverage, {limits: {expandedBytes: 20}}), isCode('INVALID_EXPORT_GZIP'));
  await assert.rejects(new PostHogExportClient(fake({files: [fileA, fileB]}).http, config).capture([declared], {device_property: 'device'}, coverage, {limits: {records: 1}}), isCode('CAPTURE_RECORD_LIMIT'));
});

test('overlap duplicates are counted while conflicting UUID content and absent session keys block the candidate', async () => {
  const same = Buffer.from(JSON.stringify(row('same_event')) + '\n'); const duplicates = await new PostHogExportClient(fake({files: [fileA, fileB], download: () => response(same)}).http, config).capture([declared], {device_property: 'device'}, coverage); assert.equal(duplicates.normalization.counts.duplicates, 1); assert.equal(duplicates.normalization.counts.input, 2);
  const conflict = await new PostHogExportClient(fake({files: [fileA, fileB], download: id => response(Buffer.from(JSON.stringify(row('same_event', {event: id === fileA ? 'checkout_started' : 'purchase_completed'})) + '\n'))}).http, config).capture([declared], {device_property: 'device'}, coverage); assert.equal(conflict.terminal_state, 'blocked'); assert.equal(conflict.normalization.counts.conflicts, 1);
  const noSession = await new PostHogExportClient(fake({download: () => response(Buffer.from(JSON.stringify(row('no_session', {distinct_id: 'person_1', properties: {device: 'mobile'}})) + '\n'))}).http, config).capture([declared], {device_property: 'device'}, coverage); assert.equal(noSession.terminal_state, 'blocked'); assert.equal(noSession.normalization.issues[0]!.code, 'MISSING_SESSION_ID');
});

test('a cancelled or revoked operation cannot return a completed capture', async () => {
  const fixture = fake(); let checks = 0; await assert.rejects(new PostHogExportClient(fixture.http, config).capture([declared], {device_property: 'device'}, coverage, {assertActive: async () => {if (++checks === 7) throw new ConnectorError('CAPTURE_REVOKED', 'Unit authority was revoked.');}}), isCode('CAPTURE_REVOKED')); assert.equal(checks, 7);
});

test('private checkpoints retain downloaded evidence when a later file is absent without completing the capture', async () => {
  const received: string[] = [], decoded: string[] = []; const fixture = fake({files: [fileA, fileB], download: id => id === fileB ? response({}, 404) : response(Buffer.from(JSON.stringify(row(id)) + '\n'))});
  await assert.rejects(new PostHogExportClient(fixture.http, config).capture([declared], {device_property: 'device'}, coverage, {onFileReceived: async file => {received.push(file.file_id);}, onFileDecoded: async file => {decoded.push(file.file_id);}}), isCode('PROVIDER_NOT_FOUND'));
  assert.deepEqual(received, [fileA]); assert.deepEqual(decoded, [fileA]);
});

test('expired signed storage access is refreshed once through the original authenticated file endpoint', async () => {
  const fixture = fake({redirect: `https://objects.example.com/${fileA}?signature=private-unit`}); let signedAttempts = 0; const original = fixture.http.get;
  fixture.http.get = async (url, options) => {if (url.startsWith('https://objects.example.com') && ++signedAttempts === 1) return response({}, 403); return original(url, options);};
  const result = await new PostHogExportClient(fixture.http, config).capture([declared], {device_property: 'device'}, coverage); assert.equal(result.files.length, 1); assert.equal(signedAttempts, 2); assert.equal(fixture.calls.filter(call => call.url.includes('/download/')).length, 2);
});

test('received-range gaps remain explicit and an attributed lateness declaration never becomes a source guarantee', async () => {
  const second = {...declared, run_id: '10000000-0000-4000-8000-000000000002', data_interval_start: '2026-01-03T00:00:00.000Z', data_interval_end: '2026-01-04T00:00:00.000Z'};
  const result = await new PostHogExportClient(fake({files: [], count: 0}).http, config).capture([declared, second], {device_property: 'device'}, {...coverage, basis: 'lateness_assumption', late_arrival_hours: 12});
  assert.deepEqual(result.received_range_gaps, [{start: '2026-01-02T00:00:00.000Z', end: '2026-01-03T00:00:00.000Z'}]); assert.equal(result.coverage.basis, 'lateness_assumption'); assert.equal(result.coverage.event_time_intervals.length, 0); assert.equal(result.coverage.event_watermark, null);
});
