import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {serviceFailureDiagnostic, type PoolSnapshot} from './request-diagnostics.js';
import {createServer, request as httpRequest} from 'node:http';
import Fastify from 'fastify';
import {installRequestWorkTracking} from './request-work.js';
import {createVercelHandler} from './vercel-handler.js';
import {resourceRevision} from './resource-revision.js';
import {expected} from '../../../packages/core/src/workspaces/service.js';
import {DomainError} from '../../../packages/core/src/errors.js';
import {buildServer} from './server.js';

describe("request diagnostics", async () => {
  const context = { request_id: 'safe-request-id', route: '/api/v1/workspaces/:workspaceId/cases', elapsed_ms: 32.9 };
  
  test('classifies known acquisition timeouts without exposing error details', () => {
      for (const message of ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']) {
          const diagnostic = serviceFailureDiagnostic(new Error(message), {}, context);
          assert.equal(diagnostic.failure_class, 'pool_acquire_timeout');
          assert.equal('pg_code' in diagnostic, false);
          assert.equal(JSON.stringify(diagnostic).includes(message), false);
          assert.equal(serviceFailureDiagnostic(new Error(`${message}: private database URL`), {}, context).failure_class, 'unknown');
      }
  });
  
  test('known transport codes map to a fixed classification while arbitrary provider codes remain unknown', () => {
      for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CERT_HAS_EXPIRED']) {
          const diagnostic = serviceFailureDiagnostic({ code }, {}, context);
          assert.equal(diagnostic.failure_class, 'connection_transport');
          assert.equal('pg_code' in diagnostic, false);
          assert.equal(JSON.stringify(diagnostic).includes(code), false);
      }
      for (const code of ['MODEL_UNAVAILABLE', 'PROVIDER_SECRET_TOKEN', 'TOKEN', 'ABCDE', '23505\n', '28p01', 12345, null]) {
          const diagnostic = serviceFailureDiagnostic({ code }, {}, context);
          assert.equal(diagnostic.failure_class, 'unknown');
          assert.equal('pg_code' in diagnostic, false);
      }
  });
  
  test('SQLSTATE is the only error-derived string exposed and is restricted to known PostgreSQL classes', () => {
      for (const code of ['23505', '28P01', '08006', '40001', '57P01', '53300', 'HV00N', 'P0001', 'XX000']) {
          const diagnostic = serviceFailureDiagnostic({ code, message: 'private SQL text', detail: 'private row' }, {}, context);
          assert.equal(diagnostic.failure_class, 'postgres_sqlstate');
          assert.equal(diagnostic.pg_code, code);
          assert.match(diagnostic.pg_code!, /^[0-9A-Z]{5}$/);
      }
  });
  
  test('all error details and pool configuration secrets are excluded by an independent exact projection', () => {
      const secret = 'postgresql://private-user:private-password@private-host/db?token=private-token';
      const failure = Object.assign(new Error(secret), {
          name: secret, code: secret, detail: secret, hint: secret, query: secret, stack: secret,
          cause: { message: secret, code: secret }, credentials: secret, url: secret, env: { DATABASE_URL: secret },
          toJSON() { throw Error('Untrusted serialization must never run.'); },
      });
      const domain = Object.assign({ totalCount: 4, idleCount: 1, waitingCount: 2, options: { max: 6, password: secret, connectionString: secret } }, { secret });
      const diagnostic = serviceFailureDiagnostic(failure, { domain, auth: null }, context);
      assert.deepEqual(diagnostic, {
          diagnostic: 'request_service_failure', request_id: context.request_id, route: context.route, elapsed_ms: 32,
          failure_class: 'unknown', pools: { domain: { totalCount: 4, idleCount: 1, waitingCount: 2, max: 6 }, auth: null },
      });
      assert.equal(Object.getPrototypeOf(diagnostic), Object.prototype);
      assert.equal(JSON.stringify(diagnostic).includes(secret), false);
      assert.equal(failure.message, secret);
      assert.equal(domain.options.password, secret);
  });
  
  test('metrics and trusted context lengths are bounded without coercing arbitrary values', () => {
      const poison = { toString() { throw Error('Do not coerce this value.'); }, valueOf() { throw Error('Do not coerce this value.'); } };
      const invalid = { totalCount: Number.POSITIVE_INFINITY, idleCount: -1, waitingCount: Number.NaN, options: { max: poison } } as unknown as PoolSnapshot;
      const diagnostic = serviceFailureDiagnostic(null, { domain: invalid, auth: { totalCount: 3.8, idleCount: Number.NEGATIVE_INFINITY, waitingCount: 1e20, options: { max: 3.8 } } }, { request_id: 'r'.repeat(1000), route: '/'.repeat(1000), elapsed_ms: Number.POSITIVE_INFINITY });
      assert.equal(diagnostic.request_id.length, 128);
      assert.equal(diagnostic.route.length, 256);
      assert.equal(diagnostic.elapsed_ms, 2147483647);
      assert.deepEqual(diagnostic.pools, {
          domain: { totalCount: 2147483647, idleCount: 0, waitingCount: 0, max: null },
          auth: { totalCount: 3, idleCount: 0, waitingCount: 2147483647, max: 3 },
      });
      assert.equal(serviceFailureDiagnostic(null, {}, { ...context, elapsed_ms: Number.NaN }).elapsed_ms, 0);
      assert.equal(serviceFailureDiagnostic(null, {}, { ...context, elapsed_ms: -5 }).elapsed_ms, 0);
      assert.equal(serviceFailureDiagnostic(null, { domain: { totalCount: 0, idleCount: 0, waitingCount: 0 } }, context).pools.domain?.max, null);
      assert.doesNotThrow(() => JSON.stringify(diagnostic));
  });
  
  test('unknown exceptions, throwing accessors and nested cause codes stay unknown without escaping the helper', () => {
      for (const failure of [undefined, null, 'timeout exceeded when trying to connect', new Error('read-only unknown failure'),
          { name: 'TimeoutError', cause: { code: '23505' } },
          new Proxy({}, { get() { throw Error('secret getter exception'); } }),
      ]) {
          assert.equal(serviceFailureDiagnostic(failure, {}, context).failure_class, 'unknown');
      }
      const pool = new Proxy({}, { get() { throw Error('secret pool exception'); } }) as PoolSnapshot;
      assert.deepEqual(serviceFailureDiagnostic({}, { domain: pool }, context).pools.domain, { totalCount: 0, idleCount: 0, waitingCount: 0, max: null });
  });
});

describe("request work", async () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
  
  for (const fail of [false, true])
      test(`disconnected invocation drains route resources before returning (${fail ? 'rejected' : 'successful'} work)`, async () => {
          const entered = deferred(), release = deferred(), closed = deferred(), invoked = deferred();
          let released = false, returned = false;
          const app = Fastify();
          installRequestWorkTracking(app);
          app.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: 'unavailable' }));
          app.get('/slow', async () => {
              try {
                  entered.resolve();
                  await release.promise;
                  if (fail)
                      throw Error('synthetic-private-failure');
                  return { ok: true };
              }
              finally {
                  released = true;
              }
          });
          app.get('/unrelated', () => ({ ok: true }));
          await app.ready();
          const handler = createVercelHandler(async () => app);
          const server = createServer((req, res) => {
              if (req.url === '/slow')
                  res.once('close', closed.resolve);
              void handler(req, res).then(() => { if (req.url === '/slow') {
                  returned = true;
                  invoked.resolve();
              } });
          });
          await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const origin = 'http://127.0.0.1:' + address.port;
          const request = httpRequest(origin + '/slow');
          request.on('error', () => { });
          request.end();
          try {
              await entered.promise;
              request.destroy();
              await closed.promise;
              await new Promise<void>(r => setImmediate(r));
              assert.equal(returned, false, 'response close must not complete the invocation while backend work holds a resource');
              assert.equal(released, false);
              assert.deepEqual(await (await fetch(origin + '/unrelated')).json(), { ok: true }, 'a different request must not wait for the aborted route');
              release.resolve();
              await invoked.promise;
              assert.equal(released, true);
              assert.equal(returned, true);
              assert.deepEqual(await (await fetch(origin + '/unrelated')).json(), { ok: true });
          }
          finally {
              release.resolve();
              request.destroy();
              server.closeAllConnections();
              await new Promise<void>(r => server.close(() => r()));
              await app.close();
          }
      });
  
  test('tracked synchronous and async routes preserve response semantics and rejection handling', async () => {
      const app = Fastify();
      installRequestWorkTracking(app);
      app.get('/sync', () => ({ kind: 'sync' }));
      app.get('/async', async () => ({ kind: 'async' }));
      app.get('/reject', async () => { throw Error('synthetic failure'); });
      app.setErrorHandler((_e, _r, reply) => reply.code(503).send({ error: 'sanitized' }));
      await app.ready();
      const handler = createVercelHandler(async () => app);
      const server = createServer((req, res) => { void handler(req, res); });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = 'http://127.0.0.1:' + address.port;
      try {
          assert.deepEqual(await (await fetch(origin + '/sync')).json(), { kind: 'sync' });
          assert.deepEqual(await (await fetch(origin + '/async')).json(), { kind: 'async' });
          const failed = await fetch(origin + '/reject');
          assert.equal(failed.status, 503);
          assert.deepEqual(await failed.json(), { error: 'sanitized' });
      }
      finally {
          server.closeAllConnections();
          await new Promise<void>(r => server.close(() => r()));
          await app.close();
      }
  });
  
  test('disconnect during cold initialization completes without dispatching on a closed response', async () => {
      const entered = deferred(), initialize = deferred(), closed = deferred(), invoked = deferred();
      let calls = 0;
      const app = Fastify();
      installRequestWorkTracking(app);
      app.get('/cold', async () => { calls++; return { ok: true }; });
      await app.ready();
      const handler = createVercelHandler(async () => { entered.resolve(); await initialize.promise; return app; });
      const server = createServer((req, res) => { res.once('close', closed.resolve); void handler(req, res).then(invoked.resolve); });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const request = httpRequest('http://127.0.0.1:' + address.port + '/cold');
      request.on('error', () => { });
      request.end();
      try {
          await entered.promise;
          request.destroy();
          await closed.promise;
          initialize.resolve();
          await invoked.promise;
          assert.equal(calls, 0);
      }
      finally {
          initialize.resolve();
          request.destroy();
          server.closeAllConnections();
          await new Promise<void>(r => server.close(() => r()));
          await app.close();
      }
  });
});

describe("resource revision", async () => {
  test('hosted adapter preserves application revision checks on the real HTTP mutation path', async () => {
      const app = Fastify();
      let revision = 1, changes = 0;
      app.setErrorHandler((error, _r, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' }));
      app.patch('/api/review', async (r) => { expected(resourceRevision(r.headers), revision); changes++; return { revision: ++revision }; });
      await app.ready();
      const handler = createVercelHandler(async () => app), server = createServer((req, res) => void handler(req, res));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as {
          port: number;
      }).port}/api/review`;
      try {
          const send = (headers: Record<string, string>) => fetch(url, { method: 'PATCH', headers });
          const valid = await send({ 'X-Faultline-Revision': '1' });
          assert.equal(valid.status, 200);
          assert.deepEqual(await valid.json(), { revision: 2 });
          for (const [headers, status, code] of [[{ 'X-Faultline-Revision': '1' }, 409, 'STALE_INPUTS'], [{}, 400, 'REVISION_REQUIRED'], [{ 'X-Faultline-Revision': '2', 'If-Match': '1' }, 400, 'REVISION_CONFLICT'], [{ 'X-Faultline-Revision': '2, 3' }, 400, 'REVISION_REQUIRED']] as [
              Record<string, string>,
              number,
              string
          ][]) {
              const response = await send(headers);
              assert.equal(response.status, status);
              assert.deepEqual(await response.json(), { code });
              assert.equal(changes, 1);
              assert.equal(revision, 2);
          }
          const legacy = await send({ 'If-Match': '2' });
          assert.equal(legacy.status, 200);
          assert.deepEqual(await legacy.json(), { revision: 3 });
          const agree = await send({ 'X-Faultline-Revision': '3', 'If-Match': '3' });
          assert.equal(agree.status, 200);
          assert.equal(changes, 3);
      }
      finally {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
          await app.close();
      }
  });
  
  test('optional parent revision accepts absence but rejects malformed or conflicting bindings', () => {
      assert.equal(resourceRevision({}, false), undefined);
      assert.equal(resourceRevision({ 'x-faultline-revision': 'a'.repeat(64) }), 'a'.repeat(64));
      for (const value of [[], ['1', '1'], '', '1 2', '1\n2'])
          assert.throws(() => resourceRevision({ 'x-faultline-revision': value as any }, false), { code: 'REVISION_REQUIRED' });
      assert.throws(() => resourceRevision({ 'x-faultline-revision': '1', 'if-match': '2' }, false), { code: 'REVISION_CONFLICT' });
  });
});

describe("vercel handler", async () => {
  test('Node function preserves original route, cookies, JSON body and streaming lifetime', async () => {
      const app = Fastify();
      let complete: () => void = () => { }, resolved = false, initializations = 0;
      app.post('/api/echo', async (r) => ({ url: r.url, body: r.body, cookie: r.headers.cookie }));
      app.get('/api/stream', async (_r, reply) => { reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': ['one=1; HttpOnly', 'two=2; HttpOnly'] }); reply.raw.write('id: 1\ndata: first\n\n'); await new Promise<void>(resolve => { complete = resolve; }); reply.raw.end('id: 2\ndata: second\n\n'); });
      await app.ready();
      const handler = createVercelHandler(async () => { initializations++; return app; });
      const server = createServer((req, res) => { void handler(req, res).then(() => { if (req.url === '/api/stream')
          resolved = true; }); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = 'http://127.0.0.1:' + address.port;
      try {
          const echo = await fetch(origin + '/api/echo?retained=yes', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'synthetic=session' }, body: JSON.stringify({ value: 'preserved' }) });
          assert.deepEqual(await echo.json(), { url: '/api/echo?retained=yes', body: { value: 'preserved' }, cookie: 'synthetic=session' });
          const response = await fetch(origin + '/api/stream');
          assert.deepEqual(response.headers.getSetCookie(), ['one=1; HttpOnly', 'two=2; HttpOnly']);
          const reader = response.body!.getReader();
          const first = await reader.read();
          assert.match(new TextDecoder().decode(first.value), /id: 1/);
          assert.equal(resolved, false, 'function promise must wait for the stream to finish');
          complete();
          let tail = '';
          for (;;) {
              const next = await reader.read();
              if (next.done)
                  break;
              tail += new TextDecoder().decode(next.value);
          }
          assert.match(tail, /id: 2/);
          assert.equal(initializations, 1);
      }
      finally {
          complete();
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
          await app.close();
      }
  });
  
  test('failed initialization is sanitized and can recover on a later invocation', async () => {
      let attempts = 0;
      const app = Fastify();
      app.get('/health/ready', async () => ({ status: 'ready' }));
      await app.ready();
      const handler = createVercelHandler(async () => { if (++attempts === 1)
          throw Error('private-provider-credential'); return app; });
      const server = createServer((req, res) => { void handler(req, res); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      try {
          const url = 'http://127.0.0.1:' + address.port + '/health/ready', failure = await fetch(url);
          assert.equal(failure.status, 503);
          assert.doesNotMatch(await failure.text(), /private-provider/);
          assert.deepEqual(await (await fetch(url)).json(), { status: 'ready' });
          assert.equal(attempts, 2);
      }
      finally {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
          await app.close();
      }
  });
  
  test('liveness needs no backend initialization and only bypasses exact GET or HEAD requests', async () => {
      let attempts = 0;
      const handler = createVercelHandler(async () => { attempts++; throw Error('missing synthetic configuration'); });
      const server = createServer((req, res) => { void handler(req, res); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = 'http://127.0.0.1:' + address.port;
      try {
          for (const path of ['/health/live', '/health/live?probe=host']) {
              const response = await fetch(origin + path);
              assert.equal(response.status, 200);
              assert.equal(response.headers.get('cache-control'), 'no-store');
              assert.equal(response.headers.get('content-type'), 'application/json');
              assert.deepEqual(await response.json(), { status: 'alive' });
          }
          const head = await fetch(origin + '/health/live?probe=head', { method: 'HEAD' });
          assert.equal(head.status, 200);
          assert.equal(head.headers.get('cache-control'), 'no-store');
          assert.equal(await head.text(), '');
          assert.equal(attempts, 0);
          for (const [path, method] of [['/health/live', 'POST'], ['/health/live/extra', 'GET'], ['/health/ready', 'GET']]) {
              const response = await fetch(origin + path, { method });
              assert.equal(response.status, 503);
              assert.equal((await response.json()).error.code, 'DEPENDENCY_UNAVAILABLE');
          }
          assert.equal(attempts, 3, 'other routes and methods still require actual backend readiness');
      }
      finally {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
      }
  });
});

describe("foundation without database", async () => {
  test('real API separates process liveness from unavailable database/worker readiness', async () => {
      const app = await buildServer();
      try {
          const live = await app.inject('/health/live'), ready = await app.inject('/health/ready');
          assert.equal(live.statusCode, 200);
          assert.equal(live.json().status, 'alive');
          if (!process.env.DATABASE_URL) {
              assert.equal(ready.statusCode, 503);
              assert.equal(ready.json().components.database, 'unconfigured');
              assert.notEqual(ready.json().components.worker, 'ready');
          }
      }
      finally {
          await app.close();
      }
  });
  
  test('strict business body rejects unknown protected fields and numeric coercion before touching persistence', async () => {
      const app = await buildServer();
      try {
          for (const payload of [{ name: 'test', role: 'owner' }, { name: 123 }, { name: 'x'.repeat(201) }]) {
              const response = await app.inject({ method: 'POST', url: '/api/v1/workspaces', payload });
              assert.equal(response.statusCode, 400);
              assert.equal(response.json().error.code, 'INVALID_INPUT');
          }
      }
      finally {
          await app.close();
      }
  });
  
  test('unconfigured auth does not accept public signup or turn a session error into an empty workspace list', async () => {
      const app = await buildServer();
      try {
          if (!process.env.AUTH_DATABASE_URL) {
              const signup = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', payload: { email: 'nobody@example.test', password: 'long-enough-password', name: 'nobody' } });
              assert.equal(signup.statusCode, 503);
              const workspaces = await app.inject('/api/v1/workspaces');
              assert.equal(workspaces.statusCode, 503);
              assert.ok(workspaces.json().error);
              assert.equal(workspaces.json().data, undefined);
          }
      }
      finally {
          await app.close();
      }
  });
  
  test('malformed JSON and excessive request sizes remain client failures', async () => {
      const app = await buildServer();
      try {
          const response = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { 'content-type': 'application/json' }, payload: '{' });
          assert.equal(response.statusCode, 400);
          const huge = await app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'x'.repeat(6 * 1024 * 1024) } });
          assert.equal(huge.statusCode, 413);
      }
      finally {
          await app.close();
      }
  });
});
