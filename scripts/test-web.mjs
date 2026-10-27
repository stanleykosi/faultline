import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const files=[];
async function walk(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await walk(file);else if(/\.test\.tsx?$/.test(entry.name))files.push(file);}}
await walk('apps/web/src');files.sort();if(!files.length)throw Error('No real web tests found.');
const child=spawn(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit',windowsHide:true,env:{...process.env,TSX_TSCONFIG_PATH:path.resolve('apps/web/tsconfig.json')}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
