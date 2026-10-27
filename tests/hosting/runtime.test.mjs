import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HOSTED_SECRET_INPUTS, prepareHostedPrivateRuntime} from '../../scripts/hosted-private-runtime.mjs';
import {EventEmitter} from 'node:events';
import {superviseHosted, probeHostedReadiness} from '../../scripts/hosted-supervisor.mjs';
import {initializePrivateVolume, mountInfoHasExactPath, planPrivateVolumeInitialization, PRIVATE_VOLUME_ROOT} from '../../scripts/initialize-private-volume.mjs';

describe("hosted private runtime", async () => {
  const keyNames = ['keyring.json', 'report-private.pem', 'report-public.pem'];
  
  const inputNames = HOSTED_SECRET_INPUTS;
  
  async function fixture(t) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-private-runtime-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const objects = path.join(root, 'objects'), keys = path.join(root, 'keys');
      await fs.mkdir(objects);
      await fs.mkdir(keys);
      const pair = generateKeyPairSync('ed25519');
      const ring = Buffer.from(JSON.stringify({ active: 'test-v1', keys: { 'test-v1': Buffer.alloc(32, 0x5a).toString('base64') } }));
      const privatePem = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
      const publicPem = Buffer.from(pair.publicKey.export({ format: 'pem', type: 'spki' }));
      const inputBytes = new Map([['keyring.json', ring], ['report-private.pem', privatePem], ['report-public.pem', publicPem]]);
      const env = { NODE_ENV: 'production', OBJECT_STORE: 'filesystem', OBJECT_STORE_PATH: objects, SECRET_KEYRING_PATH: path.join(keys, 'keyring.json'), REPORT_SIGNING_KEY_PATH: path.join(keys, 'report-private.pem'), REPORT_SIGNING_PUBLIC_KEY_PATH: path.join(keys, 'report-public.pem') };
      for (let index = 0; index < keyNames.length; index++)
          env[inputNames[index]] = inputBytes.get(keyNames[index]).toString('base64');
      const overrides = new Map();
      const permissionApi = { inspect(target, stat) {
              const relative = path.relative(root, target).split(path.sep).join('/');
              const base = relative === '' ? { uid: 0, gid: 0, mode: 0o755 } : { uid: 1000, gid: 1000, mode: stat.isDirectory() ? 0o700 : 0o600 };
              return { ...base, ...(overrides.get(relative) ?? {}), nlink: stat.nlink };
          } };
      const options = { root, env, permissionApi, identity: () => ({ uid: 1000, gid: 1000 }), verifyMount: async (target) => assert.equal(target, root), syncDir: async () => { } };
      return { root, objects, keys, env, pair, inputBytes, overrides, permissionApi, options };
  }
  
  function freshEnv(f, inputs = true) {
      const env = { NODE_ENV: 'production', OBJECT_STORE: 'filesystem', OBJECT_STORE_PATH: f.objects, SECRET_KEYRING_PATH: path.join(f.keys, 'keyring.json'), REPORT_SIGNING_KEY_PATH: path.join(f.keys, 'report-private.pem'), REPORT_SIGNING_PUBLIC_KEY_PATH: path.join(f.keys, 'report-public.pem') };
      if (inputs)
          for (let index = 0; index < keyNames.length; index++)
              env[inputNames[index]] = f.inputBytes.get(keyNames[index]).toString('base64');
      return env;
  }
  
  test('materializes a valid synthetic AES keyring and matching Ed25519 pair as private create-only files', async (t) => {
      const f = await fixture(t);
      assert.deepEqual(await prepareHostedPrivateRuntime(f.options), { status: 'HOSTED_PRIVATE_RUNTIME_READY' });
      for (const name of keyNames) {
          const file = path.join(f.keys, name);
          assert.ok((await fs.stat(file)).isFile());
          assert.equal((await fs.stat(file)).nlink, 1);
          assert.equal(Object.hasOwn(f.env, inputNames[keyNames.indexOf(name)]), false);
      }
      assert.equal(f.env.SECRET_KEYRING_PATH, path.join(f.keys, 'keyring.json'));
      assert.equal(f.env.REPORT_SIGNING_KEY_PATH, path.join(f.keys, 'report-private.pem'));
      assert.equal(f.env.REPORT_SIGNING_PUBLIC_KEY_PATH, path.join(f.keys, 'report-public.pem'));
      assert.equal(f.env.OBJECT_STORE_PATH, f.objects);
  });
  
  test('identical input retries and validated pre-provisioned files are idempotent', async (t) => {
      const f = await fixture(t);
      await prepareHostedPrivateRuntime(f.options);
      const retry = { ...f.options, env: freshEnv(f) };
      assert.deepEqual(await prepareHostedPrivateRuntime(retry), { status: 'HOSTED_PRIVATE_RUNTIME_READY' });
      const preprovisioned = { ...f.options, env: freshEnv(f, false) };
      assert.deepEqual(await prepareHostedPrivateRuntime(preprovisioned), { status: 'HOSTED_PRIVATE_RUNTIME_READY' });
  });
  
  test('complete crash-leftover temporary secret files recover only with the identical sealed bundle', async (t) => {
      const f = await fixture(t), temporary = path.join(f.keys, '.faultline-secret-keyring.json.tmp');
      await fs.writeFile(temporary, f.inputBytes.get('keyring.json'), { mode: 0o600 });
      assert.deepEqual(await prepareHostedPrivateRuntime(f.options), { status: 'HOSTED_PRIVATE_RUNTIME_READY' });
      assert.deepEqual((await fs.readdir(f.keys)).sort(), [...keyNames].sort());
      assert.deepEqual(await fs.readFile(path.join(f.keys, 'keyring.json')), f.inputBytes.get('keyring.json'));
  });
  
  test('post-link crash state is recovered only for the same private inode and bytes', async (t) => {
      const f = await fixture(t), temporary = path.join(f.keys, '.faultline-secret-keyring.json.tmp'), target = path.join(f.keys, 'keyring.json');
      await fs.writeFile(temporary, f.inputBytes.get('keyring.json'), { mode: 0o600 });
      await fs.link(temporary, target);
      assert.equal((await fs.stat(target)).nlink, 2);
      assert.deepEqual(await prepareHostedPrivateRuntime(f.options), { status: 'HOSTED_PRIVATE_RUNTIME_READY' });
      assert.equal((await fs.stat(target)).nlink, 1);
      await assert.rejects(fs.stat(temporary), error => error.code === 'ENOENT');
      assert.deepEqual((await fs.readdir(f.keys)).sort(), [...keyNames].sort());
  });
  
  test('post-link crash state with different bytes remains untouched and fails closed', async (t) => {
      const f = await fixture(t), temporary = path.join(f.keys, '.faultline-secret-keyring.json.tmp'), target = path.join(f.keys, 'keyring.json'), marker = Buffer.from('SYNTHETIC-POST-LINK-MARKER');
      await fs.writeFile(temporary, marker, { mode: 0o600 });
      await fs.link(temporary, target);
      await assert.rejects(prepareHostedPrivateRuntime(f.options), error => error.code === 'HOSTED_SECRET_TEMPORARY_CONFLICT' && !error.message.includes(marker.toString()));
      assert.equal((await fs.stat(target)).nlink, 2);
      assert.equal((await fs.stat(temporary)).nlink, 2);
      assert.deepEqual((await fs.readFile(target)), marker);
      assert.deepEqual((await fs.readFile(temporary)), marker);
  });
  
  test('conflicting crash-leftover temporary data is preserved and startup fails closed', async (t) => {
      const f = await fixture(t), temporary = path.join(f.keys, '.faultline-secret-keyring.json.tmp'), marker = Buffer.from('SYNTHETIC-STALE-MARKER');
      await fs.writeFile(temporary, marker, { mode: 0o600 });
      await assert.rejects(prepareHostedPrivateRuntime(f.options), error => error.code === 'HOSTED_SECRET_TEMPORARY_CONFLICT' && !error.message.includes(marker.toString()));
      assert.deepEqual(await fs.readdir(f.keys), ['.faultline-secret-keyring.json.tmp']);
      assert.deepEqual(await fs.readFile(temporary), marker);
  });
  
  test('conflicting input never overwrites an existing key file', async (t) => {
      const f = await fixture(t);
      await prepareHostedPrivateRuntime(f.options);
      const before = await fs.readFile(path.join(f.keys, 'keyring.json'));
      const changed = Buffer.from(JSON.stringify({ active: 'test-v2', keys: { 'test-v2': Buffer.alloc(32, 0x6b).toString('base64') } }));
      const conflictEnv = freshEnv(f);
      conflictEnv[inputNames[0]] = changed.toString('base64');
      await assert.rejects(prepareHostedPrivateRuntime({ ...f.options, env: conflictEnv }), error => error.code === 'HOSTED_SECRET_FILE_CONFLICT' && !error.message.includes(changed.toString('base64')));
      assert.deepEqual(await fs.readFile(path.join(f.keys, 'keyring.json')), before);
  });
  
  test('partial, malformed, oversized and mismatched sealed bundles reject and clear raw payloads', async (t) => {
      const cases = [
          { name: 'partial', mutate: f => { delete f.env[inputNames[2]]; }, code: 'HOSTED_SEALED_INPUTS_INCOMPLETE' },
          { name: 'invalid base64', mutate: f => { f.env[inputNames[0]] = 'not-base64-SYNTHETIC-MARKER'; }, code: 'HOSTED_SEALED_INPUT_INVALID' },
          { name: 'oversized input', mutate: f => { f.env[inputNames[0]] = 'A'.repeat(40000); }, code: 'HOSTED_SEALED_INPUT_INVALID' },
          { name: 'malformed keyring', mutate: f => { f.env[inputNames[0]] = Buffer.from('{"active":"x","keys":[]}').toString('base64'); }, code: 'HOSTED_KEYRING_INVALID' },
          { name: 'mismatched public signer', mutate: f => { f.env[inputNames[2]] = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' })).toString('base64'); }, code: 'HOSTED_SIGNING_KEY_MISMATCH' },
      ];
      for (const item of cases)
          await t.test(item.name, async (sub) => {
              const f = await fixture(sub);
              item.mutate(f);
              const raw = f.env[inputNames[0]];
              await assert.rejects(prepareHostedPrivateRuntime(f.options), error => error.code === item.code && !error.message.includes('SYNTHETIC-MARKER') && (!raw || !error.message.includes(raw)));
              for (const name of inputNames)
                  assert.equal(Object.hasOwn(f.env, name), false);
              assert.deepEqual(await fs.readdir(f.keys), []);
          });
  });
  
  test('refuses migration and backup-wrap operator inputs without echoing them', async (t) => {
      for (const name of ['MIGRATION_DATABASE_URL', 'BACKUP_WRAP_KEY_PATH', 'BACKUP_WRAP_KEY_BASE64'])
          await t.test(name, async (sub) => {
              const f = await fixture(sub), marker = `SYNTHETIC-OPERATOR-MARKER-${name}`;
              f.env[name] = marker;
              await assert.rejects(prepareHostedPrivateRuntime(f.options), error => error.code === 'HOSTED_OPERATOR_INPUT_REFUSED' && !error.message.includes(marker));
              for (const input of inputNames)
                  assert.equal(Object.hasOwn(f.env, input), false);
              assert.deepEqual(await fs.readdir(f.keys), []);
          });
  });
  
  test('runtime helper refuses root fallback and unsafe mounted-root permissions', async (t) => {
      const rootCase = await fixture(t);
      rootCase.overrides.set('', { uid: 0, gid: 0, mode: 0o777 });
      await assert.rejects(prepareHostedPrivateRuntime(rootCase.options), error => error.code === 'HOSTED_VOLUME_ROOT_UNSAFE');
      assert.deepEqual(await fs.readdir(rootCase.keys), []);
      const identityCase = await fixture(t), rootOptions = { ...identityCase.options, identity: () => ({ uid: 0, gid: 0 }) };
      await assert.rejects(prepareHostedPrivateRuntime(rootOptions), error => error.code === 'HOSTED_RUNTIME_IDENTITY_UNSAFE');
      assert.deepEqual(await fs.readdir(identityCase.keys), []);
  });
  
  test('rejects path overrides, symlinks, unsafe owner/mode, and unexpected secret-directory entries', async (t) => {
      const pathCase = await fixture(t);
      pathCase.env.SECRET_KEYRING_PATH = path.join(pathCase.root, '..', 'escape.json');
      await assert.rejects(prepareHostedPrivateRuntime(pathCase.options), error => error.code === 'HOSTED_PRIVATE_PATH_CONFIGURATION_INVALID');
      const symlinkCase = await fixture(t);
      await fs.rm(symlinkCase.objects, { recursive: true });
      const outside = path.join(symlinkCase.root, 'outside');
      await fs.mkdir(outside);
      await fs.symlink(outside, symlinkCase.objects, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(prepareHostedPrivateRuntime(symlinkCase.options), error => error.code === 'HOSTED_PRIVATE_SYMLINK_REFUSED');
      const ownerCase = await fixture(t);
      ownerCase.overrides.set('objects', { uid: 0, gid: 0 });
      await assert.rejects(prepareHostedPrivateRuntime(ownerCase.options), error => error.code === 'HOSTED_PRIVATE_DIRECTORY_UNSAFE');
      const modeCase = await fixture(t);
      modeCase.overrides.set('keys', { uid: 1000, gid: 1000, mode: 0o755 });
      await assert.rejects(prepareHostedPrivateRuntime(modeCase.options), error => error.code === 'HOSTED_PRIVATE_DIRECTORY_UNSAFE');
      const unexpectedCase = await fixture(t);
      await fs.writeFile(path.join(unexpectedCase.keys, 'backup-wrap.key'), 'SYNTHETIC-OPERATOR-MARKER');
      await assert.rejects(prepareHostedPrivateRuntime(unexpectedCase.options), error => error.code === 'HOSTED_PRIVATE_UNEXPECTED_ENTRY' && !error.message.includes('SYNTHETIC-OPERATOR-MARKER'));
  });
  
  test('rejects hardlinked secret files before reading their bytes', async (t) => {
      const f = await fixture(t);
      const keyring = path.join(f.keys, 'keyring.json'), external = path.join(f.root, 'synthetic-link');
      await fs.writeFile(keyring, 'SYNTHETIC-KEY-MARKER');
      await fs.link(keyring, external);
      const env = freshEnv(f, false), options = { ...f.options, env };
      await assert.rejects(prepareHostedPrivateRuntime(options), error => error.code === 'HOSTED_PRIVATE_FILE_UNSAFE' && !error.message.includes('SYNTHETIC-KEY-MARKER'));
  });
  
  test('atomic publication failure leaves no partial file and a same-input retry succeeds', async (t) => {
      const f = await fixture(t);
      let links = 0;
      const injectedFs = new Proxy(fs, { get(target, property) { if (property === 'link')
              return async (...args) => { links++; if (links === 2) {
                  const error = new Error('synthetic injected failure');
                  error.code = 'EIO';
                  throw error;
              } return target.link(...args); }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
      const options = { ...f.options, fsApi: injectedFs };
      await assert.rejects(prepareHostedPrivateRuntime(options), error => error.code === 'HOSTED_SECRET_PUBLISH_FAILED' && !error.message.includes('synthetic injected failure'));
      const afterFailure = await fs.readdir(f.keys);
      assert.deepEqual(afterFailure, ['keyring.json']);
      const retry = { ...f.options, env: freshEnv(f) };
      assert.deepEqual(await prepareHostedPrivateRuntime(retry), { status: 'HOSTED_PRIVATE_RUNTIME_READY' });
      assert.deepEqual((await fs.readdir(f.keys)).sort(), [...keyNames].sort());
  });
});

describe("hosted supervisor", async () => {
  const target = 'http://127.0.0.1:3600/health/ready';
  
  const specs = [{ role: 'api', entry: 'api.js' }, { role: 'worker', entry: 'worker.js' }];
  
  class Child extends EventEmitter {
      constructor(role, { ignoreTerm = false, ignoreKill = false, pid = 100 } = {}) { super(); this.role = role; this.ignoreTerm = ignoreTerm; this.ignoreKill = ignoreKill; this.pid = pid; this.kills = []; this.exited = false; }
      kill(signal) { this.kills.push(signal); if (signal === 'SIGTERM' && this.ignoreTerm || signal === 'SIGKILL' && this.ignoreKill)
          return true; setImmediate(() => { if (!this.exited) {
          this.exited = true;
          this.emit('exit', signal === 'SIGTERM' ? 0 : null, signal === 'SIGKILL' ? 'SIGKILL' : null);
      } }); return true; }
      exit(code = 0) { if (!this.exited) {
          this.exited = true;
          this.emit('exit', code, null);
      } }
  }
  
  function harness({ childOptions = {}, probeReady = async () => true, spawnFailureAt = null, startupTimeoutMs = 100, probeIntervalMs = 5, shutdownTimeoutMs = 30, forcedStopTimeoutMs = 30 } = {}) {
      const children = [], calls = [], signals = new EventEmitter();
      let spawnCount = 0;
      const spawnProcess = (executable, args, options) => {
          calls.push({ executable, args, options });
          spawnCount++;
          if (spawnFailureAt === spawnCount)
              throw new Error('synthetic spawn failure');
          const role = options.env.PROCESS_ROLE, child = new Child(role, childOptions[role]);
          children.push(child);
          return child;
      };
      const running = superviseHosted({ children: specs, readinessUrl: target, env: { NO_SECRET_LOGGING: 'synthetic' }, spawnProcess, probeReady, signalSource: signals, startupTimeoutMs, probeIntervalMs, shutdownTimeoutMs, forcedStopTimeoutMs });
      return { running, children, calls, signals };
  }
  
  async function until(predicate) {
      const deadline = Date.now() + 500;
      while (!predicate() && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 1));
      assert.ok(predicate(), 'condition did not become true within the synthetic test bound');
  }
  
  test('spawns exactly API and worker without a shell, requires the ready health contract, and shuts down idempotently', async () => {
      let probes = 0;
      const h = harness({ probeReady: async (url) => { probes++; assert.equal(url, target); return true; } });
      await until(() => probes > 0);
      h.signals.emit('SIGTERM');
      h.signals.emit('SIGTERM');
      const result = await h.running;
      assert.deepEqual(result, { exitCode: 0, reason: 'SHUTDOWN_SIGNAL' });
      assert.equal(h.children.length, 2);
      assert.deepEqual(h.children.map(x => x.role), ['api', 'worker']);
      assert.ok(h.calls.every(x => x.executable === process.execPath && x.options.shell === false && x.options.stdio === 'inherit'));
      assert.deepEqual(h.calls.map(x => x.options.env.PROCESS_ROLE), ['api', 'worker']);
      assert.ok(h.children.every(x => x.kills.filter(signal => signal === 'SIGTERM').length === 1));
  });
  
  test('503 and failed readiness probes time out and stop both children', async () => {
      let probes = 0;
      const h = harness({ startupTimeoutMs: 30, probeIntervalMs: 4, probeReady: async () => { probes++; throw new Error('synthetic probe failure'); } });
      const result = await h.running;
      assert.deepEqual(result, { exitCode: 1, reason: 'READINESS_TIMEOUT' });
      assert.ok(probes > 0);
      assert.ok(h.children.every(x => x.exited));
  });
  
  test('a worker exit with code zero before readiness is an unexpected failure and stops the API sibling', async () => {
      let probeCount = 0;
      const h = harness({ probeReady: async () => { probeCount++; return false; } });
      await until(() => h.children.length === 2);
      h.children.find(child => child.role === 'worker').exit(0);
      const result = await h.running;
      assert.deepEqual(result, { exitCode: 1, reason: 'CHILD_EXITED_UNEXPECTEDLY' });
      assert.ok(probeCount < 10);
      assert.deepEqual(h.children.find(child => child.role === 'api').kills, ['SIGTERM']);
  });
  
  for (const exitCode of [0, 2])
      test(`an observed worker exit(${exitCode}) stays failed when SIGTERM races the first readiness probe`, async () => {
          let h, emitted = false;
          h = harness({ probeReady: async () => {
                  if (!emitted) {
                      emitted = true;
                      h.children.find(child => child.role === 'worker').exit(exitCode);
                      h.signals.emit('SIGTERM');
                  }
                  return false;
              } });
          const result = await h.running;
          assert.deepEqual(result, { exitCode: 1, reason: 'CHILD_EXITED_UNEXPECTEDLY' });
          assert.equal(emitted, true);
          assert.ok(h.children.every(child => child.exited));
      });
  
  test('a failed child remains a nonzero supervisor result when sibling shutdown is graceful', async () => {
      const h = harness();
      await until(() => h.children.length === 2);
      h.children.find(child => child.role === 'worker').exit(2);
      const result = await h.running;
      assert.deepEqual(result, { exitCode: 1, reason: 'CHILD_EXITED_UNEXPECTEDLY' });
      assert.deepEqual(h.children.find(child => child.role === 'api').kills, ['SIGTERM']);
      assert.equal(h.children.every(child => child.exited), true);
  });
  
  test('child process errors fail closed and stop its sibling', async () => {
      const h = harness();
      await until(() => h.children.length === 2);
      h.children.find(child => child.role === 'worker').emit('error', new Error('synthetic process error'));
      const result = await h.running;
      assert.deepEqual(result, { exitCode: 1, reason: 'CHILD_PROCESS_ERROR' });
      assert.ok(h.children.every(child => child.exited));
  });
  
  test('synchronous spawn failure stops an already-started sibling', async () => {
      const h = harness({ spawnFailureAt: 2 });
      const result = await h.running;
      assert.deepEqual(result, { exitCode: 1, reason: 'CHILD_SPAWN_FAILED' });
      assert.equal(h.children.length, 1);
      assert.deepEqual(h.children[0].kills, ['SIGTERM']);
      assert.equal(h.children[0].exited, true);
  });
  
  test('shutdown deadline sends a force-stop to both stuck children', async () => {
      let probes = 0;
      const h = harness({ probeReady: async () => { probes++; return true; }, childOptions: { api: { ignoreTerm: true }, worker: { ignoreTerm: true } }, shutdownTimeoutMs: 12, forcedStopTimeoutMs: 30 });
      await until(() => probes > 0);
      h.signals.emit('SIGINT');
      const result = await h.running;
      assert.deepEqual(result, { exitCode: 1, reason: 'CHILDREN_FORCE_STOPPED', trigger: 'SHUTDOWN_SIGNAL' });
      assert.ok(h.children.every(child => child.exited && child.kills[0] === 'SIGTERM' && child.kills[1] === 'SIGKILL'));
  });
  
  test('failure to stop even after the forced-stop deadline is reported as a failed shutdown', async () => {
      const h = harness({ probeReady: async () => true, childOptions: { api: { ignoreTerm: true, ignoreKill: true }, worker: { ignoreTerm: true, ignoreKill: true } }, shutdownTimeoutMs: 8, forcedStopTimeoutMs: 8 });
      await until(() => h.children.length === 2);
      h.signals.emit('SIGTERM');
      assert.deepEqual(await h.running, { exitCode: 1, reason: 'CHILD_FORCE_STOP_TIMEOUT' });
      assert.ok(h.children.every(child => child.kills.includes('SIGKILL')));
  });
  
  test('readiness probe accepts only 200 with database, storage, and fresh-worker readiness', async () => {
      let requested;
      const fetchImpl = async (url, options) => { requested = { url, options }; return { status: 200, json: async () => ({ status: 'ready', components: { database: 'ready', storage: 'ready', worker: 'ready' } }) }; };
      assert.equal(await probeHostedReadiness(target, fetchImpl), true);
      assert.equal(requested.url, target);
      assert.equal(requested.options.redirect, 'error');
      assert.equal(await probeHostedReadiness('https://example.com/health/ready', fetchImpl), false);
      assert.equal(await probeHostedReadiness(target, async () => ({ status: 200, json: async () => ({ status: 'ready', components: { database: 'ready', storage: 'ready', worker: 'stale' } }) })), false);
  });
});

describe("private volume policy", async () => {
  const rootPermissions = { uid: 0, gid: 0, mode: 0o755 };
  
  const rootSnapshot = { root: PRIVATE_VOLUME_ROOT, rootPermissions, rootDevice: 41, entries: [] };
  
  const safeDirectory = name => ({ name, symlink: false, directory: true, device: 41, uid: 0, gid: 0, mode: 0o755, children: [] });
  
  const safeSystemDirectory = (overrides = {}) => ({ name: 'lost+found', symlink: false, directory: true, device: 41, uid: 0, gid: 0, mode: 0o700, nlink: 2, children: [], ...overrides });
  
  function virtualVolume({ rootEntries = [], raceAtMkdir, swapAtOpen, failChown } = {}) {
      const nodes = new Map(), calls = [];
      let nextInode = 2;
      const key = target => path.resolve(target).toLowerCase();
      const addDirectory = (target, { uid = 0, gid = 0, mode = 0o755, dev = 41, ino = nextInode++, nlink = 2, directory = true, symlink = false, children = [] } = {}) => {
          const item = { uid, gid, mode, dev, ino, nlink, directory, symlink, children: [...children] };
          nodes.set(key(target), item);
          return item;
      };
      const normalizedRootEntries = rootEntries.map(entry => typeof entry === 'string' ? { name: entry } : entry);
      const root = addDirectory(PRIVATE_VOLUME_ROOT, { ino: 1, children: normalizedRootEntries.map(entry => entry.name) });
      for (const entry of normalizedRootEntries)
          addDirectory(path.join(PRIVATE_VOLUME_ROOT, entry.name), entry);
      const statFor = item => ({ dev: item.dev, ino: item.ino, uid: item.uid, gid: item.gid, mode: item.mode, nlink: item.nlink, isSymbolicLink: () => item.symlink, isDirectory: () => item.directory, isFile: () => !item.directory && !item.symlink });
      const get = target => nodes.get(key(target));
      const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
      const fsApi = {
          async lstat(target) { const item = get(target); if (!item)
              throw missing(); return statFor(item); },
          async realpath(target) { if (!get(target))
              throw missing(); return path.resolve(target); },
          async readdir(target) { const item = get(target); if (!item || !item.directory)
              throw missing(); return [...item.children]; },
          async mkdir(target) {
              calls.push(['mkdir', path.basename(target)]);
              if (get(target))
                  throw Object.assign(new Error('exists'), { code: 'EEXIST' });
              const parent = get(path.dirname(target));
              if (!parent)
                  throw missing();
              const name = path.basename(target);
              parent.children.push(name);
              addDirectory(target);
              if (name === raceAtMkdir)
                  throw Object.assign(new Error('raced create'), { code: 'EEXIST' });
          },
          async open(target) {
              const item = get(target);
              if (!item)
                  throw missing();
              const name = path.basename(target);
              calls.push(['open', name]);
              const opened = statFor(item);
              if (name === swapAtOpen)
                  opened.ino += 1;
              return {
                  async stat() { return opened; },
                  async chown(uid, gid) { calls.push(['chown', name]); if (name === failChown)
                      throw Object.assign(new Error('denied'), { code: 'EPERM' }); item.uid = uid; item.gid = gid; },
                  async chmod(mode) { calls.push(['chmod', name]); item.mode = mode; },
                  async sync() { calls.push(['sync', name]); },
                  async close() { calls.push(['close', name]); },
              };
          },
      };
      return { fsApi, calls, root, nodes, key, get };
  }
  
  const runVirtualInitializer = (volume, options = {}) => initializePrivateVolume({
      fsApi: volume.fsApi,
      identity: () => ({ uid: 0 }),
      permissionApi: { inspect: (_target, stat) => ({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }) },
      verifyMount: async (root) => assert.equal(root, PRIVATE_VOLUME_ROOT),
      ...options,
  });
  
  test('initializer mount parser accepts only an exact mounted path, including escaped spaces', () => {
      const info = '34 25 0:32 / / rw,relatime - overlay overlay rw\n35 34 0:88 / /data rw,nosuid,nodev - ext4 /dev/volume rw\n36 34 0:91 / /some\\040mount rw - ext4 /dev/other rw\n';
      assert.equal(mountInfoHasExactPath(info, '/data'), true);
      assert.equal(mountInfoHasExactPath(info, '/database'), false);
      assert.equal(mountInfoHasExactPath(info, '/some mount'), true);
      assert.equal(mountInfoHasExactPath(info, 'data'), false);
  });
  
  test('finite plan creates only empty objects/keys directories with the fixed node identity', () => {
      assert.deepEqual(planPrivateVolumeInitialization(rootSnapshot), [
          { kind: 'create_and_assign', name: 'objects', uid: 1000, gid: 1000, mode: 0o700 },
          { kind: 'create_and_assign', name: 'keys', uid: 1000, gid: 1000, mode: 0o700 },
      ]);
  });
  
  test('finite plan preserves an exact empty ext lost+found directory without adding an action', () => {
      assert.deepEqual(planPrivateVolumeInitialization({ ...rootSnapshot, entries: [safeSystemDirectory()] }), [
          { kind: 'create_and_assign', name: 'objects', uid: 1000, gid: 1000, mode: 0o700 },
          { kind: 'create_and_assign', name: 'keys', uid: 1000, gid: 1000, mode: 0o700 },
      ]);
  });
  
  test('only empty root-owned directories or already-private empty directories may be initialized', () => {
      assert.deepEqual(planPrivateVolumeInitialization({ ...rootSnapshot, entries: [safeDirectory('objects'), safeDirectory('keys')] }).map(action => action.kind), ['assign_empty_root_directory', 'assign_empty_root_directory']);
      const privateDirectory = name => ({ ...safeDirectory(name), uid: 1000, gid: 1000, mode: 0o700 });
      assert.deepEqual(planPrivateVolumeInitialization({ ...rootSnapshot, entries: [privateDirectory('objects'), privateDirectory('keys')] }).map(action => action.kind), ['verify_only', 'verify_only']);
  });
  
  test('unsafe mount owners/modes, symlinks, hard-to-trust existing data and extra files are refused', async (t) => {
      const cases = [
          ['wrong mount owner', { ...rootSnapshot, rootPermissions: { uid: 7, gid: 0, mode: 0o755 } }, 'PRIVATE_VOLUME_ROOT_UNSAFE'],
          ['world writable mount', { ...rootSnapshot, rootPermissions: { uid: 0, gid: 0, mode: 0o777 } }, 'PRIVATE_VOLUME_ROOT_UNSAFE'],
          ['non-traversable mount', { ...rootSnapshot, rootPermissions: { uid: 0, gid: 0, mode: 0o700 } }, 'PRIVATE_VOLUME_ROOT_UNSAFE'],
          ['unexpected root entry', { ...rootSnapshot, entries: [{ name: 'existing.db' }] }, 'PRIVATE_VOLUME_UNEXPECTED_ENTRY'],
          ['nonempty lost+found', { ...rootSnapshot, entries: [safeSystemDirectory({ children: ['recovered-file'] })] }, 'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
          ['wrong lost+found owner', { ...rootSnapshot, entries: [safeSystemDirectory({ uid: 1000 })] }, 'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
          ['wrong lost+found mode', { ...rootSnapshot, entries: [safeSystemDirectory({ mode: 0o755 })] }, 'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
          ['unexpected lost+found links', { ...rootSnapshot, entries: [safeSystemDirectory({ nlink: 3 })] }, 'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
          ['lost+found symlink', { ...rootSnapshot, entries: [safeSystemDirectory({ symlink: true })] }, 'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
          ['lost+found on another device', { ...rootSnapshot, entries: [safeSystemDirectory({ device: 42 })] }, 'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
          ['symlink directory', { ...rootSnapshot, entries: [{ ...safeDirectory('objects'), symlink: true }] }, 'PRIVATE_VOLUME_EXISTING_DATA_REFUSED'],
          ['unexpected existing files', { ...rootSnapshot, entries: [{ ...safeDirectory('keys'), children: ['synthetic.key'] }] }, 'PRIVATE_VOLUME_EXISTING_DATA_REFUSED'],
          ['foreign owner', { ...rootSnapshot, entries: [{ ...safeDirectory('objects'), uid: 55 }] }, 'PRIVATE_VOLUME_EXISTING_OWNER_REFUSED'],
          ['unsafe mode', { ...rootSnapshot, entries: [{ ...safeDirectory('keys'), mode: 0o770 }] }, 'PRIVATE_VOLUME_EXISTING_MODE_REFUSED'],
          ['path on another device', { ...rootSnapshot, entries: [{ ...safeDirectory('keys'), device: 42 }] }, 'PRIVATE_VOLUME_EXISTING_DATA_REFUSED'],
      ];
      for (const [name, snapshot, code] of cases)
          await t.test(name, () => assert.throws(() => planPrivateVolumeInitialization(snapshot), error => error.code === code));
  });
  
  test('mutating initializer uses only the injected filesystem and assigns the two empty directories', async () => {
      const volume = virtualVolume({ rootEntries: [safeSystemDirectory()] });
      assert.equal(await runVirtualInitializer(volume), 'PRIVATE_VOLUME_READY');
      for (const name of ['objects', 'keys']) {
          const directory = volume.get(path.join(PRIVATE_VOLUME_ROOT, name));
          assert.deepEqual({ uid: directory.uid, gid: directory.gid, mode: directory.mode, children: directory.children }, { uid: 1000, gid: 1000, mode: 0o700, children: [] });
      }
      assert.deepEqual(volume.calls.filter(([operation]) => operation === 'chown').map(([, name]) => name), ['objects', 'keys']);
      assert.equal(volume.calls.filter(([operation]) => operation === 'chmod').length, 2);
      assert.equal(volume.calls.some(([operation, name]) => (operation === 'chown' || operation === 'chmod' || operation === 'open') && name === 'lost+found'), false);
  });
  
  test('mutating initializer refuses an unexpected root entry before changing ownership', async () => {
      const volume = virtualVolume({ rootEntries: ['synthetic-user-data.db'] });
      await assert.rejects(runVirtualInitializer(volume), error => error.code === 'PRIVATE_VOLUME_UNEXPECTED_ENTRY');
      assert.equal(volume.calls.some(([operation]) => operation === 'chown' || operation === 'chmod'), false);
  });
  
  test('mutating initializer fails closed on a concurrent create or changed directory inode', async (t) => {
      await t.test('concurrent create', async () => {
          const volume = virtualVolume({ raceAtMkdir: 'objects' });
          await assert.rejects(runVirtualInitializer(volume), error => error.code === 'PRIVATE_VOLUME_CREATE_RACE');
          assert.equal(volume.calls.some(([operation]) => operation === 'chown' || operation === 'chmod'), false);
      });
      await t.test('directory replaced between lstat and open', async () => {
          const volume = virtualVolume({ swapAtOpen: 'objects' });
          await assert.rejects(runVirtualInitializer(volume), error => error.code === 'PRIVATE_VOLUME_SYMLINK_REFUSED');
          assert.equal(volume.calls.some(([operation]) => operation === 'chown' || operation === 'chmod'), false);
      });
  });
  
  test('mutating initializer stops if ownership assignment fails', async () => {
      const volume = virtualVolume({ failChown: 'objects' });
      await assert.rejects(runVirtualInitializer(volume), error => error.code === 'PRIVATE_VOLUME_PERMISSION_SET_FAILED');
      const objects = volume.get(path.join(PRIVATE_VOLUME_ROOT, 'objects'));
      assert.deepEqual({ uid: objects.uid, gid: objects.gid, mode: objects.mode }, { uid: 0, gid: 0, mode: 0o755 });
      assert.equal(volume.calls.some(([operation, name]) => operation === 'chmod' && name === 'objects'), false);
  });
});
