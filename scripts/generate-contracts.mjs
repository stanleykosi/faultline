import fs from 'node:fs/promises';
import path from 'node:path';
import {compile} from 'json-schema-to-typescript';
const dir=path.resolve('contracts'),output=path.resolve('packages/contracts/src');
await fs.mkdir(output,{recursive:true});
const files=(await fs.readdir(dir)).filter(f=>f.endsWith('.schema.json')).sort();
const blocks=[];
for(const f of files){
 const schema=JSON.parse(await fs.readFile(path.join(dir,f),'utf8'));
 const name=f.replace('.schema.json','').split('-').map(x=>x[0].toUpperCase()+x.slice(1)).join('');
 blocks.push(await compile(schema,name,{cwd:dir,bannerComment:'/* Generated from contracts/'+f+'; do not edit. */',declareExternallyReferenced:true,$refOptions:{resolve:{http:false}}}));
}
await fs.writeFile(path.join(output,'generated.ts'),blocks.join('\n'));
console.log('Generated '+files.length+' canonical contract types');

