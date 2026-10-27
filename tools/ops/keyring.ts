import fs from 'node:fs/promises';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
const directory='.runtime/keys';await fs.mkdir(directory,{recursive:true,mode:0o700});
const keyring=directory+'/keyring.json';
await fs.writeFile(keyring,JSON.stringify({active:'v1',keys:{v1:randomBytes(32).toString('base64')}}),{flag:'wx',mode:0o600});
const keys=generateKeyPairSync('ed25519');
await fs.writeFile(directory+'/report-private.pem',keys.privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});
await fs.writeFile(directory+'/report-public.pem',keys.publicKey.export({format:'pem',type:'spki'}),{flag:'wx',mode:0o600});
console.log('Private encryption/signing keys generated; existing files are never overwritten.');

