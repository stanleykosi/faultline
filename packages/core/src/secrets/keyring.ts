import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import {demand} from '../errors.js';
export type Keyring={active:string;keys:Record<string,string>};
export async function loadKeyring(file=process.env.SECRET_KEYRING_PATH){
 demand(file,'KEYRING_UNAVAILABLE','Configure a private SECRET_KEYRING_PATH.',503);
 const keyring=JSON.parse(await fs.readFile(file,'utf8')) as Keyring;
 demand(keyring.active&&keyring.keys?.[keyring.active],'KEYRING_UNAVAILABLE','Active key missing.',503);return keyring;
}
export function seal(value:string,aad:string,keyring:Keyring){
 const key=Buffer.from(keyring.keys[keyring.active]??'','base64');demand(key.length===32,'KEYRING_UNAVAILABLE','Invalid encryption key.',503);
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
 const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return JSON.stringify({version:1,key_version:keyring.active,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
}
export function open(value:string,aad:string,keyring:Keyring){
 const sealed=JSON.parse(value);demand(sealed.version===1&&keyring.keys[sealed.key_version],'KEYRING_UNAVAILABLE','Unknown encryption key version.',503);
 const cipher=createDecipheriv('aes-256-gcm',Buffer.from(keyring.keys[sealed.key_version]!,'base64'),Buffer.from(sealed.iv,'base64'));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(Buffer.from(sealed.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext,'base64')),cipher.final()]).toString('utf8');
}

