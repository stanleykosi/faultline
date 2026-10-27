import {demand} from '../errors.js';
const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Buffer){let c=0xffffffff;for(const v of bytes)c=table[(c^v)&255]!^(c>>>8);return(c^0xffffffff)>>>0;}
export function zipStored(files:{path:string;bytes:Buffer}[]){
 demand(files.length<=100&&files.every(f=>/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(f.path)&&!f.path.split('/').includes('..')),'INVALID_ARCHIVE','Invalid bounded archive path.');
 const locals:Buffer[]=[],directories:Buffer[]=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.path),crc=crc32(file.bytes),local=Buffer.alloc(30),central=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(file.bytes.length,18);local.writeUInt32LE(file.bytes.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(file.bytes.length,20);central.writeUInt32LE(file.bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,name,file.bytes);directories.push(central,name);offset+=local.length+name.length+file.bytes.length;
 }
 const directory=Buffer.concat(directories),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
