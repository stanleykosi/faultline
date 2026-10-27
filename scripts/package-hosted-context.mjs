import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {fileURLToPath} from 'node:url';

const manifestPath='ops/staging/hosted-build-inputs.json';
const exactFiles=new Set([
 'api.routes.json','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json',
 'apps/api/package.json','apps/worker/package.json','apps/web/package.json','apps/web/tsconfig.json','apps/web/vite.config.ts','apps/web/index.html',
 'packages/core/package.json','packages/contracts/package.json','packages/database/package.json',
 'config/defaults.json',
 'ops/images/Dockerfile','ops/images/Runner.Dockerfile','ops/staging/railway-runner.json.example',
 'scripts/build-runner-program.mjs','scripts/generate-contracts.mjs','scripts/generate-runtime-migrations.mjs','scripts/hosted-private-runtime.mjs','scripts/hosted-supervisor.mjs','scripts/initialize-private-volume.mjs','scripts/package-hosted-context.mjs','scripts/package-runner-context.mjs','scripts/start-hosted.mjs',
 'fixtures/checkout-site/candidate.js','fixtures/checkout-site/candidate.patch','fixtures/checkout-site/incident.js','fixtures/checkout-site/known_good.js','fixtures/checkout-site/README.md','fixtures/checkout-site/server.mjs',
]);
const codeRoots=[
 ['apps/api/src/','.ts'],['apps/worker/src/','.ts'],['apps/runner/src/','.ts'],
 ['apps/web/src/','.ts','.tsx','.css','.svg','.png','.webp','.woff2'],
 ['packages/core/src/','.ts'],['packages/contracts/src/','.ts'],['packages/database/src/','.ts'],
 ['packages/database/migrations/','.sql'],['tools/ops/','.ts'],
];
const privateSegments=new Set(['.agents','.codex','.git','.runtime','artifacts','backups','credentials','logs','node_modules','reports','test-results']);
const privateExtensions=new Set(['.bak','.backup','.cer','.crt','.db','.dump','.jks','.key','.keystore','.log','.p12','.p7b','.p8','.pem','.ppk','.pfx','.sqlite','.sqlite3','.tar','.tgz','.zip']);
const approvedSecretSourceFiles=new Set(['packages/core/src/secrets/keyring.ts','packages/core/src/secrets/replacements.ts']);
const reviewedPrivateSourceExceptions=new Set([
 ...approvedSecretSourceFiles,
 'packages/core/src/reports/render.ts',
 'packages/core/src/reports/analytic-findings.ts',
 'packages/core/src/reports/service.ts',
 'packages/core/src/reports/zip.ts',
 'apps/web/src/features/providers/CredentialReplacement.tsx',
]);
const sourceScriptExtensions=new Set(['.cjs','.cts','.js','.jsx','.mjs','.mts','.ts','.tsx']);
const sourceModuleExtensions=['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.json','.css','.svg','.png','.webp','.woff2'];
const generatedServerOutputPrefix='dist/server/';

function isWithin(parent,child){const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function privatePath(relative){
 const segments=relative.split('/'),base=segments.at(-1).toLowerCase();
 const hasUnapprovedSecretsDirectory=segments.some(segment=>segment.toLowerCase()==='secrets')&&!approvedSecretSourceFiles.has(relative);
 const restricted=segments.some(segment=>{const name=segment.toLowerCase();return name.startsWith('.env')||privateSegments.has(name);})||hasUnapprovedSecretsDirectory||privateExtensions.has(path.posix.extname(base))||base.endsWith('.sql.gz')||base.endsWith('.tar.gz')||/^(credentials?|secrets?|session-token|id_rsa|id_ed25519)(\.|$)/i.test(base);
 return restricted&&!reviewedPrivateSourceExceptions.has(relative);
}
function approvedBuildInput(relative){
 if(typeof relative!=='string'||relative.length===0||relative.includes('\\')||relative.startsWith('/')||relative.split('/').some(part=>part===''||part==='.'||part==='..')||privatePath(relative))return false;
 if(exactFiles.has(relative))return true;
 if(/^contracts\/[a-z0-9-]+\.schema\.json$/.test(relative))return true;
 if(/^apps\/web\/public\/[^/]+\.(svg|png|webp|ico|woff2)$/.test(relative))return true;
 for(const [prefix,...extensions] of codeRoots){
  if(!relative.startsWith(prefix))continue;
  const basename=relative.slice(prefix.length).split('/').at(-1);
  if(basename.includes('.test.'))return false;
  return extensions.includes(path.posix.extname(basename).toLowerCase());
 }
 return false;
}

async function assertRegularSource(root,relative){
 const file=path.resolve(root,...relative.split('/'));
 if(!isWithin(root,file)||file===root)throw new Error('HOSTED_CONTEXT_PATH_INVALID');
 const segments=relative.split('/');let current=root;
 for(let index=0;index<segments.length;index++){
  current=path.join(current,segments[index]);
  const stat=await fs.lstat(current);
  if(stat.isSymbolicLink())throw new Error('HOSTED_CONTEXT_SYMLINK_REFUSED: '+relative);
  const final=index===segments.length-1;
  if(final?!stat.isFile():!stat.isDirectory())throw new Error('HOSTED_CONTEXT_SOURCE_TYPE_INVALID: '+relative);
 }
 return file;
}

async function loadInputs(root,relativeManifest){
 if(!approvedBuildInput(relativeManifest)&&relativeManifest!==manifestPath)throw new Error('HOSTED_CONTEXT_MANIFEST_PATH_INVALID');
 const file=await assertRegularSource(root,relativeManifest),value=JSON.parse(await fs.readFile(file,'utf8'));
 if(value?.schemaVersion!==1||!Array.isArray(value.files)||value.files.length===0||!value.files.every(item=>typeof item==='string'))throw new Error('HOSTED_CONTEXT_MANIFEST_INVALID');
 const sorted=[...value.files].sort((a,b)=>a.localeCompare(b));
 if(new Set(value.files).size!==value.files.length||value.files.some((item,index)=>item!==sorted[index]))throw new Error('HOSTED_CONTEXT_MANIFEST_ORDER_INVALID');
 for(const relative of value.files)if(!approvedBuildInput(relative))throw new Error('HOSTED_CONTEXT_INPUT_NOT_ALLOWLISTED: '+relative);
 return value.files;
}

function importScriptKind(relative){
 const extension=path.posix.extname(relative).toLowerCase();
 if(extension==='.tsx')return ts.ScriptKind.TSX;
 if(extension==='.jsx')return ts.ScriptKind.JSX;
 if(['.js','.jsx','.mjs','.cjs'].includes(extension))return ts.ScriptKind.JS;
 return ts.ScriptKind.TS;
}

function sourceModuleSpecifiers(relative,source){
 if(path.posix.extname(relative).toLowerCase()==='.css'){
  const found=[];
  for(const match of source.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?/gi))found.push(match[2]);
  for(const match of source.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi))found.push(match[2]);
  return [...new Set(found)].filter(specifier=>specifier&&!/^(?:[a-z][a-z\d+.-]*:|\/|#|\/\/)/i.test(specifier));
 }
 const sourceFile=ts.createSourceFile(relative,source,ts.ScriptTarget.Latest,false,importScriptKind(relative)),found=[];
 const literalText=node=>node&&(ts.isStringLiteral(node)||node.kind===ts.SyntaxKind.NoSubstitutionTemplateLiteral)?node.text:null;
 const visit=node=>{
  if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)){
   const specifier=literalText(node.moduleSpecifier);if(specifier)found.push(specifier);
  }else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)){
   const specifier=literalText(node.moduleReference.expression);if(specifier)found.push(specifier);
  }else if(ts.isCallExpression(node)){
   const expression=node.expression,isDynamicImport=expression.kind===ts.SyntaxKind.ImportKeyword,isRequire=ts.isIdentifier(expression)&&expression.text==='require';
   if(isDynamicImport||isRequire){const specifier=literalText(node.arguments[0]);if(specifier)found.push(specifier);}
  }
  ts.forEachChild(node,visit);
 };
 visit(sourceFile);
 return [...new Set(found)];
}

function moduleCandidates(relative){
 const extension=path.posix.extname(relative).toLowerCase();
 if(extension==='.js'){const stem=relative.slice(0,-extension.length);return [`${stem}.ts`,`${stem}.tsx`,`${stem}.d.ts`,relative];}
 if(extension==='.jsx'){const stem=relative.slice(0,-extension.length);return [`${stem}.tsx`,`${stem}.ts`,relative];}
 if(extension==='.mjs'){const stem=relative.slice(0,-extension.length);return [`${stem}.mts`,`${stem}.d.mts`,relative];}
 if(extension==='.cjs'){const stem=relative.slice(0,-extension.length);return [`${stem}.cts`,`${stem}.d.cts`,relative];}
 if(extension)return [relative];
 return [...sourceModuleExtensions.map(item=>`${relative}${item}`),...sourceModuleExtensions.map(item=>`${relative}/index${item}`)];
}

function normalizeModulePath(importer,specifier){
 const request=specifier.split(/[?#]/,1)[0];
 if(!request.startsWith('./')&&!request.startsWith('../'))return null;
 const relative=path.posix.normalize(path.posix.join(path.posix.dirname(importer),request));
 if(relative==='..'||relative.startsWith('../')||path.posix.isAbsolute(relative))throw new Error('HOSTED_CONTEXT_IMPORT_OUTSIDE_ROOT: '+importer+' -> '+specifier);
 return relative;
}

async function existingCandidate(root,candidates){
 for(const relative of candidates){
  const absolute=path.resolve(root,...relative.split('/'));
  if(!isWithin(root,absolute)||absolute===root)throw new Error('HOSTED_CONTEXT_IMPORT_OUTSIDE_ROOT: '+relative);
  try{
   const stat=await fs.lstat(absolute);
   if(stat.isSymbolicLink())throw new Error('HOSTED_CONTEXT_SYMLINK_REFUSED: '+relative);
   if(stat.isFile())return relative;
   if(stat.isDirectory())continue;
  }catch(error){if(error?.code!=='ENOENT')throw error;}
 }
 return null;
}

/** Check every local relative source import reachable from the frozen input set without copying discovered files. */
export async function inspectHostedImportClosure({sourceRoot=process.cwd(),files}={}){
 if(!Array.isArray(files))throw new Error('HOSTED_CONTEXT_IMPORT_MANIFEST_INVALID');
 const root=await fs.realpath(sourceRoot),included=new Set(files),visited=new Set(),queue=[...files],notIncluded=new Set(),notAllowlisted=new Set(),unresolved=new Set(),generatedOutputs=new Set();
 while(queue.length){
  const importer=queue.shift();if(visited.has(importer))continue;visited.add(importer);
  const extension=path.posix.extname(importer).toLowerCase();if(!sourceScriptExtensions.has(extension)&&extension!=='.css')continue;
  if(!approvedBuildInput(importer)){notAllowlisted.add(importer);continue;}
  const importerPath=await assertRegularSource(root,importer),source=await fs.readFile(importerPath,'utf8');
  for(const specifier of sourceModuleSpecifiers(importer,source)){
   const requested=normalizeModulePath(importer,specifier);if(!requested)continue;
   if(requested.startsWith(generatedServerOutputPrefix)){
    const generatedSource=requested.slice(generatedServerOutputPrefix.length),sourcePath=await existingCandidate(root,moduleCandidates(generatedSource));
    if(!sourcePath){unresolved.add(`${importer} -> ${specifier} (generated output has no source module)`);continue;}
    generatedOutputs.add(requested);
    if(!approvedBuildInput(sourcePath))notAllowlisted.add(`${importer} -> ${sourcePath}`);
    else{if(!included.has(sourcePath))notIncluded.add(sourcePath);queue.push(sourcePath);}
    continue;
   }
   const resolved=await existingCandidate(root,moduleCandidates(requested));
   if(!resolved){unresolved.add(`${importer} -> ${specifier}`);continue;}
   if(!approvedBuildInput(resolved)){notAllowlisted.add(`${importer} -> ${resolved}`);continue;}
   if(!included.has(resolved))notIncluded.add(resolved);
   queue.push(resolved);
  }
 }
 return {
  scannedSourceFiles:visited.size,
  missingFromManifest:[...notIncluded].sort(),
  notAllowlisted:[...notAllowlisted].sort(),
  unresolvedImports:[...unresolved].sort(),
  generatedServerOutputs:[...generatedOutputs].sort(),
 };
}

/** Copy only exact paths in the reviewed file manifest. Unlisted files and directories are never traversed or read. */
export async function createHostedBuildContext({sourceRoot=process.cwd(),destination,inputManifest=manifestPath}={}){
 if(typeof destination!=='string'||!destination)throw new Error('HOSTED_CONTEXT_DESTINATION_REQUIRED');
 const root=await fs.realpath(sourceRoot),candidate=path.resolve(destination),parent=await fs.realpath(path.dirname(candidate)),target=path.join(parent,path.basename(candidate));
 if(isWithin(root,target)||isWithin(target,root))throw new Error('HOSTED_CONTEXT_DESTINATION_MUST_BE_DISJOINT');
 const files=await loadInputs(root,inputManifest);
 for(const relative of files)await assertRegularSource(root,relative);
 const closure=await inspectHostedImportClosure({sourceRoot:root,files});
 if(closure.unresolvedImports.length)throw new Error('HOSTED_CONTEXT_IMPORT_TARGET_MISSING: '+closure.unresolvedImports.join('; '));
 if(closure.notAllowlisted.length)throw new Error('HOSTED_CONTEXT_IMPORT_NOT_ALLOWLISTED: '+closure.notAllowlisted.join('; '));
 if(closure.missingFromManifest.length)throw new Error('HOSTED_CONTEXT_IMPORT_NOT_IN_MANIFEST: '+closure.missingFromManifest.join('; '));
 try{await fs.lstat(target);throw new Error('HOSTED_CONTEXT_DESTINATION_EXISTS');}catch(error){if(error?.code!=='ENOENT')throw error;}
 const staging=await fs.mkdtemp(path.join(parent,'.faultline-hosted-stage-'));
 try{
  for(const relative of files){
   const source=await assertRegularSource(root,relative),output=path.resolve(staging,...relative.split('/'));
   if(!isWithin(staging,output)||output===staging)throw new Error('HOSTED_CONTEXT_PATH_INVALID');
   await fs.mkdir(path.dirname(output),{recursive:true,mode:0o755});
   await fs.writeFile(output,await fs.readFile(source),{flag:'wx',mode:0o644});
  }
  await fs.rename(staging,target);
 }catch(error){
  await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
  throw error;
 }
 return {destination:target,files};
}

async function main(){
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-hosted-context-'));
 const destination=path.join(parent,'context'),result=await createHostedBuildContext({sourceRoot:process.cwd(),destination});
 console.log(JSON.stringify({status:'clean_allowlisted_context_created',destination:result.destination,file_count:result.files.length,allowlist_version:1}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'HOSTED_CONTEXT_FAILED');process.exitCode=1;});
