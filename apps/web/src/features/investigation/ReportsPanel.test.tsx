import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError} from '../../api';
import {readReportDownload,ReportFinding} from './ReportsPanel';
import {readPreparedReport} from '../providers/DiagnosisModelDraft';

const id = '05caa198-42db-44c6-abeb-df58ec2bb42e';
const headers = {'content-type': 'application/zip', 'content-disposition': `attachment; filename="investigation-${id}.zip"`};

test('created draft review reads authoritative freshness and revision from the exact report GET', async () => {
  const original = globalThis.fetch, calls: {path: string; options?: RequestInit}[] = [];
  const created = {id, revision: 1}; // The creation receipt has no freshness projection.
  globalThis.fetch = async (path, options) => {calls.push({path: String(path), options}); return Response.json({data: {...created, revision: 2, freshness: 'fresh'}});};
  try {
    const record = await readPreparedReport('/api/v1/workspaces/w/cases/c', created.id);
    assert.equal(record.freshness, 'fresh'); assert.equal(record.revision, 2);
    assert.equal(calls.length, 1); assert.equal(calls[0]?.path, `/api/v1/workspaces/w/cases/c/reports/${id}`);
    assert.equal(calls[0]?.options?.method ?? 'GET', 'GET');
    assert.equal(calls[0]?.options?.body, undefined);
    globalThis.fetch = async () => Response.json({data: {...created, id: 'another-report', freshness: 'fresh'}});
    await assert.rejects(readPreparedReport('/api/v1/workspaces/w/cases/c', id), /exact created draft/);
    globalThis.fetch = async () => Response.json({data: {...created, freshness: 'stale'}});
    assert.equal((await readPreparedReport('/api/v1/workspaces/w/cases/c', id)).freshness, 'stale', 'A stale read is preserved for the sentence-review gate rather than promoted to fresh.');
    globalThis.fetch = async () => Response.json({error: {code: 'FORBIDDEN', message: 'Current report access unavailable.'}}, {status: 403});
    await assert.rejects(readPreparedReport('/api/v1/workspaces/w/cases/c', id), error => error instanceof ApiError && error.code === 'FORBIDDEN');
    await assert.rejects(readPreparedReport('/api/v1/workspaces/w/cases/c', '../other'), /valid report identity/);
  } finally {globalThis.fetch = original;}
});

test('authenticated ZIP response validation preserves the exact bytes, MIME and server filename', async () => {
  // A response-validation unit fixture, not evidence of browser download or ZIP verification.
  const bytes = new Uint8Array([80, 75, 3, 4, 10]);
  const result = await readReportDownload(new Response(bytes, {headers: {...headers, 'content-length': '5'}}), id, 'zip');
  assert.equal(result.filename, `investigation-${id}.zip`); assert.equal(result.blob.type, 'application/zip');
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
});

test('a browser HTTP 204 or empty/truncated body cannot produce a report download', async () => {
  await assert.rejects(readReportDownload(new Response(null, {status: 204}), id, 'zip'), error => error instanceof ApiError && error.code === 'ARTIFACT_BYTES_UNAVAILABLE' && /No download was requested/.test(error.message));
  for (const response of [new Response(null, {headers}), new Response('x', {headers: {...headers, 'content-length': '5'}})]) await assert.rejects(readReportDownload(response, id, 'zip'), /empty or incomplete/);
});

test('mismatched artifact type/name and current access errors remain failures', async () => {
  await assert.rejects(readReportDownload(new Response('x', {headers: {...headers, 'content-type': 'text/plain'}}), id, 'zip'), /expected report filename and media type/);
  await assert.rejects(readReportDownload(new Response('x', {headers}), 'another-export', 'zip'), /expected report filename and media type/);
  await assert.rejects(readReportDownload(new Response('x', {headers}), id, 'json'), /expected report filename and media type/);
  await assert.rejects(readReportDownload(new Response(JSON.stringify({error: {code: 'REPORT_INPUTS_STALE', message: 'Report inputs changed.'}, meta: {request_id: 'safe-request-id'}}), {status: 409, headers: {'content-type': 'application/json'}}), id, 'zip'), error => error instanceof ApiError && error.status === 409 && error.code === 'REPORT_INPUTS_STALE' && error.requestId === 'safe-request-id');
});

test('report findings keep exact check citations and make failed, stale or unavailable outcomes explicit',()=>{
 const finding={text:'A failed check does not confirm the suspected cause.',evidence_ids:[],test_result_ids:['failed-check','not-loaded']};
 const result={id:'failed-check',value:{kind:'data_quality' as const,outcome:'failed' as const,freshness:'stale' as const,reasons:[],limitations:[],details:{},revision_id:'revision'}};
 const html=renderToStaticMarkup(<ReportFinding finding={finding} evidence={[]} analyticResult={result}/>);
 assert.match(html,/failed-check/);assert.match(html,/>failed<\/span>/);assert.match(html,/>stale<\/span>/);assert.match(html,/not-loaded/);assert.match(html,/Outcome not loaded/);assert.doesNotMatch(html,/>passed<|>PASS</);
 assert.deepEqual(finding.test_result_ids,['failed-check','not-loaded']);
});
