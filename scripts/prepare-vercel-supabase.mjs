import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const exact = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'api.routes.json',
  'apps/api/package.json', 'apps/worker/package.json', 'apps/web/package.json',
  'apps/web/tsconfig.json', 'apps/web/vite.config.ts', 'apps/web/index.html',
  'packages/core/package.json', 'packages/contracts/package.json', 'packages/database/package.json',
  'config/defaults.json', 'config/certs/supabase-root-ca.crt', 'scripts/generate-contracts.mjs', 'scripts/generate-runtime-migrations.mjs',
  'scripts/hosted-private-runtime.mjs', 'scripts/start-vercel-worker.mjs', 'scripts/build-runner-program.mjs',
];
const roots = new Map([
  ['apps/api/src', ['.ts']], ['apps/worker/src', ['.ts']], ['apps/runner/src', ['.ts']],
  ['apps/web/src', ['.ts','.tsx','.css','.svg','.png','.webp','.woff2']],
  ['apps/web/public', ['.svg','.png','.webp','.ico','.woff2']],
  ['packages/core/src', ['.ts']], ['packages/contracts/src', ['.ts']],
  ['packages/database/src', ['.ts']], ['packages/database/migrations', ['.sql']],
  ['tools/ops', ['.ts']], ['contracts', ['.json']],
]);
const runtimeScripts = ['scripts/initialize-vercel-runtime.mjs'];
const reviewedSecretSources = new Set(['packages/core/src/secrets/keyring.ts','packages/core/src/secrets/replacements.ts']);
const denied = new Set(['node_modules','.git','.vercel','.agents','.codex','.runtime','artifacts','backups','credentials','logs','test-results']);
const isWithin = (parent,child) => {const relative=path.relative(parent,child);return !relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
export function allowedSource(relative) {
  const segments=relative.split('/');
  if (segments[0]==='reports'||segments.some(s=>s.startsWith('.env')||denied.has(s)||s==='secrets'&&!reviewedSecretSources.has(relative))) return false;
  const base=segments.at(-1);
  return !base.includes('.test.')&&!/^(?:credentials?|secrets?|session-token|id_rsa|id_ed25519)(?:\.|$)/i.test(base);
}
async function regular(root,relative) {
  let current=root;
  for(const segment of relative.split('/')) {
    if(!segment||segment==='.'||segment==='..') throw new Error('VERCEL_CONTEXT_PATH_INVALID');
    current=path.join(current,segment);
    const stat=await fs.lstat(current);
    if(stat.isSymbolicLink()) throw new Error('VERCEL_CONTEXT_SYMLINK_REFUSED: '+relative);
  }
  if(!(await fs.stat(current)).isFile()) throw new Error('VERCEL_CONTEXT_FILE_REQUIRED: '+relative);
  return current;
}
async function collect(root,prefix,extensions,files) {
  const directory=path.join(root,...prefix.split('/'));
  let entries;
  try {
    let current=root;
    for(const segment of prefix.split('/')) {
      current=path.join(current,segment);
      const stat=await fs.lstat(current);
      if(stat.isSymbolicLink()) throw new Error('VERCEL_CONTEXT_SYMLINK_REFUSED: '+prefix);
      if(!stat.isDirectory()) throw new Error('VERCEL_CONTEXT_DIRECTORY_REQUIRED: '+prefix);
    }
    entries=await fs.readdir(directory,{withFileTypes:true});
  } catch(error) {if(error.code==='ENOENT'&&prefix==='apps/web/public') return;throw error;}
  for(const entry of entries) {
    const relative=prefix+'/'+entry.name;
    const reviewedSourceDirectory=entry.isDirectory()&&relative==='packages/core/src/secrets';
    if(!reviewedSourceDirectory&&!allowedSource(relative)) continue;
    if(entry.isSymbolicLink()) throw new Error('VERCEL_CONTEXT_SYMLINK_REFUSED: '+relative);
    if(entry.isDirectory()) await collect(root,relative,extensions,files);
    else if(entry.isFile()&&extensions.includes(path.posix.extname(relative))) files.add(relative);
  }
}
/** Produces a new allowlisted context; never edits the source or replaces an existing directory. */
export async function prepareVercelSupabase({sourceRoot=process.cwd(),destination}={}) {
  const root=await fs.realpath(sourceRoot);
  const target=path.resolve(destination??path.join(await fs.mkdtemp(path.join(os.tmpdir(),'faultline-vercel-')),'context'));
  const parent=await fs.realpath(path.dirname(target));
  if(isWithin(root,parent)||isWithin(target,root)) throw new Error('VERCEL_CONTEXT_DESTINATION_MUST_BE_DISJOINT');
  try {await fs.lstat(target);throw new Error('VERCEL_CONTEXT_DESTINATION_EXISTS');} catch(error) {if(error.code!=='ENOENT') throw error;}
  const files=new Set([...exact,...runtimeScripts]);
  for(const [prefix,extensions] of roots) await collect(root,prefix,extensions,files);
  for(const relative of files) await regular(root,relative);
  const moduleFiles=['vercel.json','Dockerfile','.dockerignore'];
  for(const name of moduleFiles) await regular(root,'ops/hosting/vercel-supabase/'+name);
  const stage=await fs.mkdtemp(path.join(parent,'.faultline-vercel-stage-'));
  const manifest=[];
  try {
    for(const relative of [...files].sort()) {
      if(!allowedSource(relative)) throw new Error('VERCEL_CONTEXT_PRIVATE_INPUT_REFUSED');
      const bytes=await fs.readFile(await regular(root,relative));
      const output=path.join(stage,...relative.split('/'));
      await fs.mkdir(path.dirname(output),{recursive:true});
      await fs.writeFile(output,bytes,{flag:'wx'});
      manifest.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    for(const name of moduleFiles) {
      const relative='ops/hosting/vercel-supabase/'+name;
      const bytes=await fs.readFile(await regular(root,relative));
      const output=path.join(stage,...relative.split('/'));
      await fs.mkdir(path.dirname(output),{recursive:true});
      await fs.writeFile(output,bytes,{flag:'wx'});
      manifest.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex')});
      await fs.writeFile(path.join(stage,name),bytes,{flag:'wx'});
    }
    await fs.mkdir(path.join(stage,'api'),{recursive:true});
    await fs.writeFile(path.join(stage,'api','index.ts'),"export {default} from '../apps/api/src/vercel.js';\n",{flag:'wx'});
    await fs.writeFile(path.join(stage,'vercel-context-manifest.json'),JSON.stringify({schemaVersion:1,profile:'vercel-supabase',files:manifest},null,2)+'\n',{flag:'wx'});
    await fs.rename(stage,target);
  } catch(error) {await fs.rm(stage,{recursive:true,force:true});throw error;}
  return {destination:target,fileCount:manifest.length,manifest};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length>1) throw new Error('Usage: node scripts/prepare-vercel-supabase.mjs [new-destination]');
  prepareVercelSupabase({destination:args[0]}).then(result=>console.log(JSON.stringify({status:'context_prepared_not_deployed',destination:result.destination,fileCount:result.fileCount}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
