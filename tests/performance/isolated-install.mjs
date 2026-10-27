import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export function isolatedInstallId(value) {
  assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return value;
}
export function isolatedInstallArgument(arguments_) {
  const selected=arguments_.filter(value=>value==='--isolated-install'||value.startsWith('--isolated-install='));
  assert.ok(selected.length<=1,'Only one explicit isolated installation selector is permitted.');
  if (!selected.length) return null;
  assert.ok(selected[0].startsWith('--isolated-install='),'The isolated installation selector requires an explicit UUID.');
  return isolatedInstallId(selected[0].slice('--isolated-install='.length));
}
export function isolatedRuntimeScope(id, environment, originalPort) {
  try {
  isolatedInstallId(id);
  const roles = {DATABASE_URL:'faultline_api',AUTH_DATABASE_URL:'faultline_auth',QUEUE_DATABASE_URL:'faultline_queue',DISPATCHER_DATABASE_URL:'faultline_dispatcher'};
  let database;
  for (const [key, role] of Object.entries(roles)) {
    const url = new URL(environment[key]);
    assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, String(originalPort)); assert.equal(decodeURIComponent(url.username), role);
    assert.ok(url.password); assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.match(url.pathname, new RegExp('^/faultline_clean_[0-9]{13}_' + id.slice(0,8) + '$'));
    database ??= url.pathname.slice(1); assert.equal(url.pathname.slice(1), database);
  }
  assert.equal(environment.APP_ORIGIN, 'http://localhost:3500');
  assert.equal(environment.PORT, '3500'); assert.equal(environment.RUNNER_MODE, 'disabled');
  assert.equal(environment.MODEL_PROVIDER, 'none');
  return {database, origin:environment.APP_ORIGIN, installation_id:id};
  } catch {throw new Error('Isolated installation configuration is invalid.');}
}
export async function loadIsolatedInstall(root, id, environment, originalPort) {
  const scope = isolatedRuntimeScope(id, environment, originalPort);
  const directory = path.resolve(root,'.runtime','clean-install',id);
  // The existing private rehearsal is reused; no database, role or credential is created.
  for (const folder of ['.runtime', '.runtime/clean-install', '.runtime/clean-install/'+id]) {
    const stat = await fs.lstat(path.resolve(root,folder)); assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
    assert.equal(await fs.realpath(path.resolve(root,folder)),path.resolve(root,folder));
  }
  const file = path.join(directory,'credentials.json'),stat=await fs.lstat(file);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=8192);
  assert.equal(await fs.realpath(file),file);
  let credentials;
  try {
    credentials=JSON.parse(await fs.readFile(file,'utf8'));
    assert.deepEqual(Object.keys(credentials).sort(),['email','password']);
    assert.ok(typeof credentials.email==='string'&&credentials.email.length>3&&typeof credentials.password==='string'&&credentials.password.length>=16);
  } catch {throw new Error('Isolated installation credentials are invalid or unavailable.');}
  return {scope,ownerEmail:credentials.email,ownerPassword:credentials.password};
}
