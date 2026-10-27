import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';

const directory=path.resolve('dist/runner');await fs.mkdir(directory,{recursive:true});
const outputs=[];
for(const [entry,name] of [['apps/runner/src/external-program.ts','external-program.mjs'],['apps/runner/src/capability-program.ts','capability-program.mjs']]){
 const output=path.join(directory,name);
 await build({absWorkingDir:process.cwd(),entryPoints:[path.resolve(entry)],outfile:output,bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',external:['playwright'],sourcemap:false,minify:false,legalComments:'none'});
 const stat=await fs.stat(output);if(!stat.isFile()||stat.size<1||stat.size>4*1024*1024)throw new Error('RUNNER_PROGRAM_BUILD_INVALID');outputs.push({path:output,size_bytes:stat.size});
}
console.log(JSON.stringify({status:'runner_programs_built',outputs}));
