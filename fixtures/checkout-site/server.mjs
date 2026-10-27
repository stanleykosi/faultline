// First-party local sandbox fixture. Never use as an actual payment service.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const directory=new URL('./',import.meta.url);
const hash=s=>createHash('sha256').update(s).digest('hex');
const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Faultline sandbox checkout</title><style>body{font:18px system-ui;max-width:36rem;margin:4rem auto;padding:1.5rem;color:#182431}button{font:inherit;padding:1rem 2rem;background:#183a57;color:white;border:0;border-radius:.4rem}aside{padding:1rem;background:#f2eee0}#status{min-height:3rem}</style><main><h1>Sandbox checkout</h1><aside>First-party Faultline fixture. One test item. No money, real payment network, or customer information.</aside><p>Test item — $0.00</p><button data-testid="pay" id="pay-desktop">Complete test checkout</button><p id="status" data-testid="checkout-status" aria-live="polite">Ready</p></main><script src="/behavior.js"></script></html>';
export async function startFixture({arm='incident',port=0}={}) {
 if(!['known_good','incident','candidate'].includes(arm))throw new Error('Unsupported fixture arm');
 const behavior=readFileSync(new URL(arm+'.js',directory),'utf8');
 const serverBytes=readFileSync(new URL('server.mjs',directory),'utf8');
 const digest=hash(html+'\n'+behavior+'\n'+serverBytes);
 const receipts=new Map();
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",'cache-control':'no-store'});res.end(html);return;}
  if(req.method==='GET'&&url.pathname==='/behavior.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(behavior);return;}
  if(req.method==='GET'&&url.pathname==='/__faultline/build'){json(res,200,{arm,build_digest:digest,scope:'trusted_local_fixture'});return;}
  if(req.method==='GET'&&url.pathname.startsWith('/__faultline/receipts/')){
   const id=url.pathname.split('/').at(-1);if(!/^[A-Za-z0-9_-]{8,100}$/.test(id)){json(res,400,{error:'INVALID_ATTEMPT'});return;}
   json(res,200,receipts.get(id)??{completed:false,order_count:0,error_code:null});return;
  }
  if(req.method==='POST'&&['/api/sandbox/order','/api/sandbox/failure'].includes(url.pathname)){
   const expected='http://127.0.0.1:'+server.address().port;
   if(req.headers.origin&&req.headers.origin!==expected){json(res,403,{error:'ORIGIN_DENIED'});return;}
   let body='';try{for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096)throw new Error('TOO_LARGE');}
    const data=JSON.parse(body);if(!/^[A-Za-z0-9_-]{8,100}$/.test(data.attempt_id??''))throw new Error('INVALID_ATTEMPT');
    if(receipts.size>=1000&&!receipts.has(data.attempt_id)){json(res,429,{error:'FIXTURE_CAPACITY'});return;}
    const previous=receipts.get(data.attempt_id);
    if(url.pathname.endsWith('/order')){const receipt={completed:true,order_count:1,error_code:null};receipts.set(data.attempt_id,receipt);json(res,200,receipt);}
    else {if(data.error_code!=='PAY_BUTTON_HANDLER_MISSING')throw new Error('INVALID_ERROR');const receipt=previous?.completed?previous:{completed:false,order_count:0,error_code:data.error_code};receipts.set(data.attempt_id,receipt);json(res,200,receipt);}
   }catch(error){json(res,400,{error:error.message==='TOO_LARGE'?'BODY_TOO_LARGE':'INVALID_REQUEST'});}return;
  }
  json(res,404,{error:'NOT_FOUND'});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {server,origin:'http://127.0.0.1:'+server.address().port,arm,build_digest:digest,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
 const instance=await startFixture({arm:arg('--arm')??'incident',port:Number(arg('--port')??4302)});
 console.log(JSON.stringify({origin:instance.origin,arm:instance.arm,build_digest:instance.build_digest,scope:'Local sandbox fixture, not Faultline application'}));
 process.on('SIGINT',async()=>{await instance.close();process.exit(0);});
}
