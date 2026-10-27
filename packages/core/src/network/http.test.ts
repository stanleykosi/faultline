import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkedUrl, publicAddress} from './http.js';
import {createServer} from 'node:http';
import {PinnedHttpTransport, publicAddress as transportPublicAddress} from '../integrations/transport.js';

// http
test("public model transport rejects private addresses and unapproved URL components", () => {
 // public transport rejects private, mapped loopback and multicast addresses
 {
  for(const ip of ['127.0.0.1','0.0.0.0','10.0.0.1','172.16.0.1','192.168.1.2','169.254.169.254','100.64.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);assert.equal(publicAddress('1.1.1.1'),true);
 }
 // provider URL must remain within exact operator origins and exclude credentials/ports/fragments
 {
  const origins=['https://api.github.com'];assert.equal(checkedUrl('https://api.github.com/repos/a/b',origins).origin,origins[0]);for(const url of ['http://api.github.com','https://api.github.com.evil.test','https://user:secret@api.github.com','https://api.github.com:8443','https://api.github.com/#token','https://127.0.0.1','https://localhost'])assert.throws(()=>checkedUrl(url,origins));
 }
});

// transport
test('actual local transport fixture enforces origin/IP/redirect/byte/deadline boundaries',async()=>{
 const requests:string[]=[],server=createServer((req,res)=>{requests.push(req.url!);if(req.url==='/redirect'){res.writeHead(302,{Location:'/must-not-follow'});res.end();}else if(req.url==='/large')res.end('x'.repeat(100));else if(req.url==='/slow')setTimeout(()=>res.end('late'),100);else res.end('fixture-only');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
 try{const transport=new PinnedHttpTransport({origins:[origin],trustedLocalOrigins:[origin],timeoutMs:1000});assert.equal((await transport.get(origin+'/ok')).body.toString(),'fixture-only');assert.equal((await transport.get(origin+'/redirect')).status,302);assert(!requests.includes('/must-not-follow'));
 await assert.rejects(()=>transport.get(origin+'/large',{maxBytes:32}),/cap|exceeded/);await assert.rejects(()=>new PinnedHttpTransport({origins:[origin]}).get(origin),/loopback/);await assert.rejects(()=>transport.get('http://127.0.0.1:1/'),/scope/);
 await assert.rejects(()=>new PinnedHttpTransport({origins:['https://fixture.invalid'],resolve:async()=>[{address:'127.0.0.1',family:4}]}).get('https://fixture.invalid/read'),/DNS/);
 await assert.rejects(()=>new PinnedHttpTransport({origins:[origin],trustedLocalOrigins:[origin],timeoutMs:20}).get(origin+'/slow'),/deadline/);
 let permitted=true;const checked=new PinnedHttpTransport({origins:[origin],trustedLocalOrigins:[origin],beforeRequest:async()=>{if(!permitted)throw Error('Source authority revoked before wire request');}});permitted=false;const before=requests.length;await assert.rejects(()=>checked.get(origin+'/revoked-first-ref'),/authority revoked/);assert.equal(requests.length,before,'Revoked source must emit zero requests, including its first ref lookup');
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.2','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1'])assert.equal(transportPublicAddress(ip),false,ip);assert.equal(transportPublicAddress('8.8.8.8'),true);assert.equal(transportPublicAddress('2606:4700:4700::1111'),true);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
