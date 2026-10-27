import {createHmac,timingSafeEqual} from 'node:crypto';
import {config} from '../config.js';
import {hash} from '../canonical.js';
import {demand} from '../errors.js';
type Position={created_at:string;id:string};
export function encodeCursor(scope:unknown,position:Position){
 const body=Buffer.from(JSON.stringify({version:1,scope:hash(scope),...position})).toString('base64url');
 const signature=createHmac('sha256',config.authSecret).update('cursor:'+body).digest('base64url');return body+'.'+signature;
}
export function decodeCursor(cursor:string|undefined,scope:unknown):Position|null{
 if(!cursor)return null;demand(cursor.length<=1000,'INVALID_CURSOR','Invalid cursor.',400);
 const [body,sig,...rest]=cursor.split('.');demand(body&&sig&&!rest.length,'INVALID_CURSOR','Invalid cursor.',400);
 const expected=createHmac('sha256',config.authSecret).update('cursor:'+body).digest('base64url'),a=Buffer.from(sig),b=Buffer.from(expected);
 demand(a.length===b.length&&timingSafeEqual(a,b),'INVALID_CURSOR','Cursor signature invalid.',400);
 let value;try{value=JSON.parse(Buffer.from(body,'base64url').toString());}catch{demand(false,'INVALID_CURSOR','Invalid cursor.',400);}
 demand(value.version===1&&value.scope===hash(scope)&&typeof value.created_at==='string'&&Number.isFinite(Date.parse(value.created_at))&&/^[a-f0-9-]{36}$/i.test(value.id),'INVALID_CURSOR','Cursor does not match this workspace/filter.',400);return {id:value.id,created_at:value.created_at};
}

