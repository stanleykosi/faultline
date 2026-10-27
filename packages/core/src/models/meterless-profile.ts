/** Pure profile parsing, also used by the browser before a connect key crosses HTTP. */
export const METERLESS_BASE_URL='http://127.0.0.1:8088/v1';
export function validMeterlessToken(value:unknown):value is string {
 return typeof value==='string'&&value.length>0&&value.length<=2000&&value!=='rt-local'&&!/[\s\x00-\x1f\x7f]/.test(value);
}
export function normalizeMeterlessProfile(value:string,token?:string):{base_url:string;token?:string} {
 let url:URL;
 try{const input=value.trim();url=new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input)?input:'http://'+input);}catch{throw new Error('Use a supported Meterless Runtime URL.');}
 const pathname=url.pathname.replace(/\/+$/,'')||'/';
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||!['/','/v1','/v1/chat/completions','/v1/models','/healthz','/connect'].includes(pathname))throw new Error('Use a supported Meterless Runtime URL without credentials or query parameters.');
 if(url.hash){
  const fragment=new URLSearchParams(url.hash.slice(1));
  if(pathname!=='/connect'||fragment.size!==1||!fragment.has('k')||!validMeterlessToken(fragment.get('k')))throw new Error('Use a valid Meterless connect link.');
  const key=fragment.get('k')!;
  if(token&&token!==key)throw new Error('The pasted connect key and token differ.');
  token=key;
 }else if(pathname==='/connect')throw new Error('The Meterless connect link is missing its key.');
 if(token!==undefined&&!validMeterlessToken(token))throw new Error('Paste the real Meterless Runtime token; the placeholder rt-local is not accepted.');
 return {base_url:url.origin+'/v1',...(token!==undefined?{token}:{})};
}
