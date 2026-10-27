import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {deploymentCommands, resolveVercelCli} from './deploy-vercel.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';
import {allowedSource, prepareVercelSupabase} from './prepare-vercel-supabase.mjs';
import {createFreshHostingSettings, missingSettingsPlan, hostingTarget, supabaseRequired} from '../ops/hosting/vercel-supabase/settings.mjs';
import {createHostedBuildContext, inspectHostedImportClosure} from './package-hosted-context.mjs';
import {createRunnerBuildContext} from './package-runner-context.mjs';

describe("deploy vercel", async () => {
  test('one command uploads source for a combined remote deployment without local build or automatic live-domain replacement', () => {
      const commands = deploymentCommands('/synthetic/context');
      assert.equal(commands.length, 2);
      assert.ok(commands.every(c => c.cwd === '/synthetic/context'));
      assert.equal(commands[0].args[0], 'link');
      const deploy = commands[1].args;
      assert.equal(deploy[0], 'deploy');
      assert.ok(deploy.includes('--prod'));
      assert.ok(deploy.includes('--skip-domain'));
      assert.ok(!deploy.includes('--prebuilt'));
      assert.ok(!commands.some(c => c.args.includes('build')));
      const dry = deploymentCommands('/synthetic/context', { dry: true })[1].args;
      assert.ok(dry.includes('--dry'));
      assert.ok(!dry.includes('--prod'));
  });
  
  test('missing CLI fails explicitly instead of installing software or changing authentication', async () => {
      await assert.rejects(resolveVercelCli({ PATH: '' }), /Install and authenticate/);
  });
});

describe("prepare vercel supabase", async () => {
  test('private and test paths are excluded while required source remains eligible', () => {
      for (const name of ['.env.local', 'apps/api/src/.env', 'apps/api/src/credentials.json', 'packages/core/src/secrets/owner.ts', 'apps/web/src/node_modules/x.ts', 'apps/api/src/auth.test.ts', 'reports/private.ts'])
          assert.equal(allowedSource(name), false, name);
      assert.equal(allowedSource('packages/core/src/secrets/keyring.ts'), true);
      assert.equal(allowedSource('apps/web/src/features/reports/Report.tsx'), true);
      assert.equal(allowedSource('apps/api/src/vercel.ts'), true);
  });
  
  test('active deployment keeps API routing, worker configuration and private Docker context aligned',async()=>{
    const config=JSON.parse(await fs.readFile('vercel.json','utf8'));
    assert.deepEqual(config,JSON.parse(await fs.readFile('ops/hosting/vercel-supabase/vercel.json','utf8')));
    assert.deepEqual(config.routes.slice(0,2),[{src:'^/api(?:/.*)?$',dest:'/api/index'},{src:'^/health/.*$',dest:'/api/index'}]);
    assert.deepEqual(config.routes[2],{handle:'filesystem'});assert.equal(config.routes.at(-1).dest,'/index.html');
    assert.equal(config.daemons.worker.entrypoint,'Dockerfile');
    assert.deepEqual(await fs.readFile('Dockerfile'),await fs.readFile('ops/hosting/vercel-supabase/Dockerfile'));
    const ignored=await fs.readFile('.dockerignore','utf8');assert.match(ignored,/^\.runtime$/m);assert.match(ignored,/^\.env\*$/m);
    assert.equal(ignored,await fs.readFile('ops/hosting/vercel-supabase/.dockerignore','utf8'));
  });

  test('context is allowlisted, hashes exact inputs, and refuses overwrite', async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-vercel-test-'));
      const destination = path.join(parent, 'context');
      try {
          const result = await prepareVercelSupabase({ destination });
          assert.ok(result.fileCount > 50);
          const names = result.manifest.map(item => item.path);
          assert.ok(names.includes('apps/api/src/vercel.ts'));
          assert.ok(names.includes('scripts/initialize-vercel-runtime.mjs'));
          assert.ok(names.includes('config/certs/supabase-root-ca.crt'));
          assert.ok(names.includes('scripts/start-vercel-worker.mjs'));
          assert.ok(names.includes('packages/core/src/secrets/keyring.ts'));
          assert.ok(names.includes('packages/core/src/secrets/replacements.ts'));
          assert.ok(names.every(name => !name.includes('node_modules') && !name.includes('.test.') && !name.startsWith('.env') && !name.startsWith('reports/')));
          const config = JSON.parse(await fs.readFile(path.join(destination, 'vercel.json'), 'utf8'));
          assert.match(config.installCommand, /--prod=false/, 'production runtime settings must not omit build tools');
          assert.equal(config.functions['api/index.ts'].maxDuration, 60);
          assert.equal(config.rewrites, undefined, 'named rewrite captures must not enter strict API query schemas');
          assert.equal(config.routes[0].src, '^/api(?:/.*)?$');
          assert.equal(config.routes[0].dest, '/api/index');
          assert.deepEqual(config.routes[2], { handle: 'filesystem' });
          assert.equal(await fs.readFile(path.join(destination, 'api/index.ts'), 'utf8'), "export {default} from '../apps/api/src/vercel.js';\n");
          assert.equal(config.daemons.worker.instances.iad1, 1);
          assert.ok(['Dockerfile', 'Containerfile'].includes(path.posix.basename(config.daemons.worker.entrypoint)));
          assert.ok((await fs.stat(path.join(destination, config.daemons.worker.root, config.daemons.worker.entrypoint))).isFile());
          assert.ok((await fs.stat(path.join(destination, path.posix.dirname(config.daemons.worker.entrypoint), 'package.json'))).isFile());
          assert.ok(!JSON.stringify(config).includes('railway.app'));
          assert.equal(await fs.readFile(path.join(destination, 'package.json'), 'utf8'), await fs.readFile('package.json', 'utf8'));
          await assert.rejects(prepareVercelSupabase({ destination }), /DESTINATION_EXISTS/);
          await assert.rejects(prepareVercelSupabase({ destination: path.join(process.cwd(), 'artifacts', 'unsafe') }), /DESTINATION_MUST_BE_DISJOINT|ENOENT/);
          const manifest = JSON.parse(await fs.readFile(path.join(destination, 'vercel-context-manifest.json'), 'utf8'));
          assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
          for (const file of manifest.files)
              assert.equal(createHash('sha256').update(await fs.readFile(path.join(destination, file.path))).digest('hex'), file.sha256, file.path);
          // Treat the first generated context as an isolated synthetic source tree.
          await fs.writeFile(path.join(destination, '.env.local'), 'PRIVATE_SENTINEL');
          await fs.writeFile(path.join(destination, 'apps/api/src/credentials.json'), 'PRIVATE_SENTINEL');
          await fs.writeFile(path.join(destination, 'apps/api/src/negative.test.ts'), 'PRIVATE_SENTINEL');
          await fs.writeFile(path.join(destination, 'unrelated.txt'), 'PRIVATE_SENTINEL');
          const second = await prepareVercelSupabase({ sourceRoot: destination, destination: path.join(parent, 'second') });
          for (const privateFile of ['.env.local', 'apps/api/src/credentials.json', 'apps/api/src/negative.test.ts', 'unrelated.txt'])
              await assert.rejects(fs.stat(path.join(second.destination, privateFile)), { code: 'ENOENT' });
          const outside = path.join(parent, 'private-outside');
          await fs.mkdir(outside);
          await fs.writeFile(path.join(outside, 'leak.ts'), 'PRIVATE_SENTINEL');
          await fs.symlink(outside, path.join(destination, 'apps/api/src/junction'), process.platform === 'win32' ? 'junction' : 'dir');
          await assert.rejects(prepareVercelSupabase({ sourceRoot: destination, destination: path.join(parent, 'third') }), /SYMLINK_REFUSED/);
      }
      finally {
          await fs.rm(parent, { recursive: true, force: true });
      }
  });
});

describe("settings", async () => {
  test('fresh hosting keys are independent, internally valid and stay server-side', () => {
      const a = createFreshHostingSettings(), b = createFreshHostingSettings();
      assert.notEqual(a.AUTH_SECRET, b.AUTH_SECRET);
      assert.ok(a.AUTH_SECRET.length >= 32);
      const ring = JSON.parse(Buffer.from(a.FAULTLINE_SEALED_SECRET_KEYRING_JSON_B64, 'base64'));
      assert.equal(Buffer.from(ring.keys[ring.active], 'base64').length, 32);
      const privateKey = createPrivateKey(Buffer.from(a.FAULTLINE_SEALED_REPORT_SIGNING_PRIVATE_PEM_B64, 'base64')), publicKey = createPublicKey(Buffer.from(a.FAULTLINE_SEALED_REPORT_SIGNING_PUBLIC_PEM_B64, 'base64'));
      assert.equal(verify(null, Buffer.from('independent synthetic receipt'), publicKey, sign(null, Buffer.from('independent synthetic receipt'), privateKey)), true);
      assert.equal(a.APP_ORIGIN, hostingTarget.origin);
      assert.equal(a.PUBLIC_SIGNUP_ENABLED, 'true');
      assert.equal(a.RUNNER_MODE, 'disabled');
      assert.ok(Object.keys(a).every(k => !k.startsWith('VITE_') && !supabaseRequired.includes(k)));
  });
  
  test('resuming preparation never replaces existing production credentials or settings', () => {
      const settings = createFreshHostingSettings(), existing = Object.keys(settings).map(key => ({ key, target: ['production'], value: 'must not inspect or replace' }));
      assert.deepEqual(missingSettingsPlan(settings, existing), []);
      const plan = missingSettingsPlan(settings, [{ key: 'AUTH_SECRET', target: ['production'] }]);
      assert.ok(!plan.some(r => r.key === 'AUTH_SECRET'));
      assert.ok(plan.find(r => r.key === 'FAULTLINE_SEALED_SECRET_KEYRING_JSON_B64').secret);
  });
  
  test('configuration refuses another origin and refuses injecting Supabase credentials or browser secrets', () => {
      const s = createFreshHostingSettings();
      assert.throws(() => missingSettingsPlan({ ...s, APP_ORIGIN: 'https://elsewhere.example' }, []), /TARGET_MISMATCH/);
      for (const key of ['VITE_SECRET', 'DATABASE_URL', 'SUPABASE_STORAGE_SERVICE_KEY'])
          assert.throws(() => missingSettingsPlan({ ...s, [key]: 'synthetic' }, []), /SCOPE_REFUSED/);
  });
});

describe("package hosted context", async () => {
  const controls = ['api.routes.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'];
  
  const explicit = ['ops/images/Dockerfile', 'scripts/generate-contracts.mjs', 'scripts/generate-runtime-migrations.mjs', 'scripts/hosted-private-runtime.mjs', 'scripts/hosted-supervisor.mjs', 'scripts/initialize-private-volume.mjs', 'scripts/package-hosted-context.mjs', 'scripts/start-hosted.mjs'];
  
  const featureFiles = ['apps/api/package.json', 'apps/api/src/investigation-routes.ts', 'apps/api/src/main.ts', 'apps/web/index.html', 'apps/web/package.json', 'apps/web/src/features/providers/CredentialReplacement.tsx', 'apps/web/src/features/providers/ModelProfiles.tsx', 'apps/web/src/features/providers/Sources.tsx', 'apps/web/src/main.tsx', 'apps/web/src/theme.css', 'apps/web/src/theme-colors.css', 'apps/web/src/theme-icon.svg', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts', 'config/defaults.json', 'contracts/capture.schema.json', 'fixtures/checkout-site/server.mjs', 'packages/core/package.json', 'packages/core/src/api-bind.ts', 'packages/core/src/reports/render.ts', 'packages/core/src/reports/service.ts', 'packages/core/src/reports/zip.ts', 'packages/core/src/secrets/keyring.ts', 'packages/core/src/secrets/replacements.ts', 'packages/core/src/service.ts', 'packages/database/package.json', 'packages/database/src/runtime-migrations.ts', 'tools/ops/migrate.ts'];
  
  const migrationNames = ['0001-foundation', '0002-enrollment', '0003-authority', '0004-pending-idempotency', '0005-data', '0006-runtime', '0007-lease-recovery', '0008-investigation', '0009-integrity', '0010-report-bindings', '0011-runtime-controls', '0012-verification', '0013-provider-services', '0014-privacy-retention', '0015-account-source-controls', '0016-command-case-association', '0017-cleanup-account-receipts', '0018-legacy-case-receipts', '0019-approved-scoped-purge', '0020-policy-retention', '0021-scoped-purge-audit-columns', '0022-readonly-preflight-capacity', '0023-frozen-redaction-previews', '0024-staging-catalog', '0025-model-budget-extensions', '0026-managed-demo-cases', '0027-secret-replacements', '0028-scoped-purge-current-content'];
  
  async function fixture(t) {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-hosting-fixture-'));
      t.after(() => fs.rm(base, { recursive: true, force: true }));
      const source = path.join(base, 'source'), destination = path.join(base, 'context');
      await fs.mkdir(source);
      const put = async (relative, body = 'synthetic source') => { const file = path.join(source, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); };
      const migrations = migrationNames.map(name => `packages/database/migrations/${name}.sql`);
      const files = [...controls, ...explicit, ...featureFiles, ...migrations].sort((a, b) => a.localeCompare(b));
      for (const file of files)
          await put(file, file.endsWith('.sql') ? 'synthetic reviewed migration' : 'synthetic source');
      await put('ops/staging/hosted-build-inputs.json', JSON.stringify({ schemaVersion: 1, files }));
      return { base, source, destination, files, put };
  }
  
  async function listFiles(directory, root = directory, result = []) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory())
              await listFiles(file, root, result);
          else
              result.push(path.relative(root, file).split(path.sep).join('/'));
      }
      return result.sort();
  }
  
  test('clean context copies only the exact manifest, all 29 SQL migrations, and no unlisted private markers', async (t) => {
      const f = await fixture(t);
      for (const file of ['apps/web/.envrc', 'config/session-token.txt', 'apps/unrelated-worktree/private.txt', 'apps/web/src/Unlisted.tsx', 'unrelated-root/local.txt', 'packages/core/src/secrets/credentials.ts', 'packages/core/src/secrets/unreviewed.ts', 'packages/core/src/reports/unreviewed.ts'])
          await f.put(file, 'SYNTHETIC-SECRET-MARKER');
      const result = await createHostedBuildContext({ sourceRoot: f.source, destination: f.destination }), files = await listFiles(f.destination);
      assert.deepEqual(files, result.files);
      assert.deepEqual(result.files, f.files);
      for (const file of [...controls, ...explicit, ...featureFiles])
          assert.ok(files.includes(file), `expected allowlisted file ${file}`);
      assert.deepEqual(files.filter(file => /^packages\/database\/migrations\/\d{4}-.*\.sql$/.test(file)), migrationNames.map(name => `packages/database/migrations/${name}.sql`));
      for (const marker of ['apps/web/.envrc', 'config/session-token.txt', 'apps/unrelated-worktree/private.txt', 'apps/web/src/Unlisted.tsx', 'unrelated-root/local.txt', 'packages/core/src/secrets/credentials.ts', 'packages/core/src/secrets/unreviewed.ts', 'packages/core/src/reports/unreviewed.ts'])
          assert.ok(!files.includes(marker), `unexpected copied path ${marker}`);
      for (const file of files)
          assert.ok(!(await fs.readFile(path.join(f.destination, ...file.split('/')))).includes('SYNTHETIC-SECRET-MARKER'));
  });
  
  test('manifest cannot authorize .envrc, token files, unrelated worktrees, report data or test files', async (t) => {
      const f = await fixture(t), unsafe = ['apps/web/.envrc', 'config/session-token.txt', 'apps/unrelated-worktree/private.txt', 'apps/web/src/Unlisted.test.tsx', 'packages/core/src/secrets/credentials.ts', 'packages/core/src/secrets/unreviewed.ts', 'packages/core/src/reports/unreviewed.ts'].sort((a, b) => a.localeCompare(b));
      for (const file of unsafe)
          await f.put(file, 'SYNTHETIC-SECRET-MARKER');
      await f.put('ops/staging/hosted-build-inputs.json', JSON.stringify({ schemaVersion: 1, files: [...f.files, ...unsafe].sort((a, b) => a.localeCompare(b)) }));
      await assert.rejects(createHostedBuildContext({ sourceRoot: f.source, destination: f.destination }), /HOSTED_CONTEXT_INPUT_NOT_ALLOWLISTED/);
      await assert.rejects(fs.lstat(f.destination), error => error.code === 'ENOENT');
  });
  
  test('a symlink in a listed source path fails before any build context is published', async (t) => {
      const f = await fixture(t), outside = path.join(f.base, 'outside');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'main.ts'), 'SYNTHETIC-SECRET-MARKER');
      const listedDir = path.join(f.source, 'apps/api/src');
      await fs.rm(listedDir, { recursive: true, force: true });
      await fs.symlink(outside, listedDir, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(createHostedBuildContext({ sourceRoot: f.source, destination: f.destination }), /HOSTED_CONTEXT_SYMLINK_REFUSED/);
      await assert.rejects(fs.lstat(f.destination), error => error.code === 'ENOENT');
  });
  
  test('existing and source-contained destinations fail closed', async (t) => {
      const f = await fixture(t);
      await fs.mkdir(f.destination);
      await assert.rejects(createHostedBuildContext({ sourceRoot: f.source, destination: f.destination }), /HOSTED_CONTEXT_DESTINATION_EXISTS/);
      await assert.rejects(createHostedBuildContext({ sourceRoot: f.source, destination: path.join(f.source, 'context') }), /HOSTED_CONTEXT_DESTINATION_MUST_BE_DISJOINT/);
  });
  
  test('local relative import closure covers reviewed exceptions and classifies generated dist outputs', async (t) => {
      const f = await fixture(t);
      await f.put('apps/api/src/investigation-routes.ts', "import {buildReport} from '../../../packages/core/src/reports/service.js';\n");
      await f.put('apps/web/src/features/providers/ModelProfiles.tsx', "import {CredentialReplacement} from './CredentialReplacement';\n");
      await f.put('apps/web/src/features/providers/Sources.tsx', "export {CredentialReplacement} from './CredentialReplacement';\n");
      await f.put('apps/web/src/main.tsx', "import './theme.css';\n");
      await f.put('apps/web/src/theme.css', "@import './theme-colors.css';\n.brand { background-image: url('./theme-icon.svg'); }\n");
      await f.put('apps/web/src/theme-colors.css', 'body { color: #123; }');
      await f.put('apps/web/src/theme-icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
      await f.put('scripts/start-hosted.mjs', "await import('../dist/server/packages/core/src/api-bind.js');\nawait import('../dist/server/apps/api/src/main.js');\n");
      const closure = await inspectHostedImportClosure({ sourceRoot: f.source, files: f.files });
      assert.deepEqual(closure.missingFromManifest, []);
      assert.deepEqual(closure.notAllowlisted, []);
      assert.deepEqual(closure.unresolvedImports, []);
      assert.deepEqual(closure.generatedServerOutputs, ['dist/server/apps/api/src/main.js', 'dist/server/packages/core/src/api-bind.js']);
      const result = await createHostedBuildContext({ sourceRoot: f.source, destination: f.destination });
      const files = await listFiles(f.destination);
      assert.deepEqual(files, result.files);
      assert.ok(files.includes('packages/core/src/reports/service.ts'));
      assert.ok(files.includes('apps/web/src/features/providers/CredentialReplacement.tsx'));
      assert.ok(!files.some(file => file.startsWith('dist/')));
  });
  
  test('missing source import target is an independent closure failure', async (t) => {
      const f = await fixture(t);
      await f.put('apps/api/src/main.ts', "import './missing-module.js';\n");
      const closure = await inspectHostedImportClosure({ sourceRoot: f.source, files: f.files });
      assert.deepEqual(closure.unresolvedImports, ["apps/api/src/main.ts -> ./missing-module.js"]);
      await assert.rejects(createHostedBuildContext({ sourceRoot: f.source, destination: f.destination }), /HOSTED_CONTEXT_IMPORT_TARGET_MISSING/);
      await assert.rejects(fs.lstat(f.destination), error => error.code === 'ENOENT');
  });
  
  test('existing allowed relative imports must be explicitly present in the manifest', async (t) => {
      const f = await fixture(t);
      await f.put('apps/api/src/main.ts', "import './unlisted-module.js';\n");
      await f.put('apps/api/src/unlisted-module.ts', 'export const sourceOnly=true;');
      const closure = await inspectHostedImportClosure({ sourceRoot: f.source, files: f.files });
      assert.deepEqual(closure.missingFromManifest, ['apps/api/src/unlisted-module.ts']);
      await assert.rejects(createHostedBuildContext({ sourceRoot: f.source, destination: f.destination }), /HOSTED_CONTEXT_IMPORT_NOT_IN_MANIFEST/);
      await assert.rejects(fs.lstat(f.destination), error => error.code === 'ENOENT');
  });
});

describe("runner context", async () => {
  test('runner deployment context is allowlisted and selects only the external controller entry point', async (t) => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-runner-context-test-'));
      t.after(() => fs.rm(parent, { recursive: true, force: true }));
      const destination = path.join(parent, 'context');
      const result = await createRunnerBuildContext({ sourceRoot: process.cwd(), destination });
      const config = JSON.parse(await fs.readFile(path.join(destination, 'railway.json'), 'utf8'));
      assert.equal(config.build.dockerfilePath, 'ops/images/Runner.Dockerfile');
      assert.equal(config.deploy.startCommand, 'node --max-old-space-size=128 dist/server/apps/runner/src/external-main.js');
      assert.equal(config.deploy.healthcheckPath, '/health/ready');
      assert.ok(result.files.includes('apps/runner/src/railway-sandbox.ts'));
      assert.ok(result.files.includes('ops/images/Runner.Dockerfile'));
      assert.ok(!result.files.some(file => file.startsWith('reports/') || file.startsWith('.runtime/') || file.includes('.env')));
  });
});
