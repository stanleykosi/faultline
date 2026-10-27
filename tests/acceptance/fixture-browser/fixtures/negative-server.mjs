// Finite FIRST-PARTY acceptance server, separate from the supplied production
// fixture catalog. No caller script, code, URL, origin or port is accepted.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function startUnfixedCandidateFixture(){
 if(process.env.NODE_ENV==='production'||process.env.FAULTLINE_ACCEPTANCE_NEGATIVE_FIXTURE!=='explicit_test_harness_only')throw new Error('ACCEPTANCE_FIXTURE_FORBIDDEN');
 const original=readFileSync(new URL('../../../../fixtures/checkout-site/server.mjs',import.meta.url),'utf8');
 const html=/^const html='([^']+)';$/m.exec(original)?.[1];if(!html)throw new Error('PINNED_HTML_UNAVAILABLE');
 const behavior=readFileSync(new URL('./unfixed-candidate.js',import.meta.url),'utf8'),serverBytes=readFileSync(new URL('./negative-server.mjs',import.meta.url),'utf8');
 const digest=hash(html+'\n'+behavior+'\n'+original+'\n'+serverBytes),receipts=new Map();
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
 const server=createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000},async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&url.pathname==='/'&&!Object.keys(Object.fromEntries(url.searchParams)).some(key=>key!=='attempt_id')){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",'cache-control':'no-store'});res.end(html);return;}
  if(req.method==='GET'&&url.pathname==='/behavior.js'&&!url.search){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(behavior);return;}
  if(req.method==='GET'&&url.pathname==='/__faultline/build'&&!url.search){json(res,200,{arm:'candidate',build_digest:digest,scope:'explicit_unfixed_candidate_acceptance_only'});return;}
  if(req.method==='GET'&&url.pathname.startsWith('/__faultline/receipts/')&&!url.search){const id=url.pathname.split('/').at(-1);if(!/^[A-Za-z0-9_-]{8,100}$/.test(id)){json(res,400,{error:'INVALID_ATTEMPT'});return;}json(res,200,receipts.get(id)??{completed:false,order_count:0,error_code:null});return;}
  if(req.method==='POST'&&['/api/sandbox/order','/api/sandbox/failure'].includes(url.pathname)&&!url.search){
   const expected='http://127.0.0.1:'+server.address().port;if(req.headers.origin&&req.headers.origin!==expected){json(res,403,{error:'ORIGIN_DENIED'});return;}
   try{const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>4096)throw Error('BODY_LIMIT');chunks.push(chunk);}const data=JSON.parse(Buffer.concat(chunks,length).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data)||!/^[A-Za-z0-9_-]{8,100}$/.test(data.attempt_id))throw Error('INVALID_ATTEMPT');
    const keys=Object.keys(data).sort().join(',');if(url.pathname==='/api/sandbox/order'?keys!=='attempt_id':keys!=='attempt_id,error_code'||data.error_code!=='PAY_BUTTON_HANDLER_MISSING')throw Error('INVALID_FIELDS');if(!receipts.has(data.attempt_id)&&receipts.size>=30)throw Error('RECEIPT_LIMIT');
    const previous=receipts.get(data.attempt_id),receipt=url.pathname==='/api/sandbox/order'?(previous?.completed?previous:{completed:true,order_count:1,error_code:null}):(previous?.completed?previous:{completed:false,order_count:0,error_code:'PAY_BUTTON_HANDLER_MISSING'});receipts.set(data.attempt_id,receipt);json(res,200,receipt);
   }catch{json(res,400,{error:'INVALID_FINITE_FIXTURE_REQUEST'});}return;
  }json(res,404,{error:'NOT_FOUND'});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {server,origin:'http://127.0.0.1:'+server.address().port,arm:'candidate',build_digest:digest,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
