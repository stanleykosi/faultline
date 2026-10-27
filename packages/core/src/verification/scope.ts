import {AsyncLocalStorage} from 'node:async_hooks';

type VerificationScope={active:boolean;readers:Map<object,Map<string,Promise<void>>>};
const scopes=new AsyncLocalStorage<VerificationScope>();

/** Each transaction invocation needs its own scope, even when its client is reused. */
export async function withVerificationScope<T>(fn:()=>Promise<T>):Promise<T>{
 const scope:VerificationScope={active:true,readers:new Map()};
 return scopes.run(scope,async()=>{
  try{return await fn();}
  finally{scope.active=false;scope.readers.clear();}
 });
}

/** Internal byte-verification dedup only; callers must still execute every access/freshness gate. */
export function verifyOnceInScope(reader:object,binding:()=>string,verify:()=>Promise<void>):Promise<void>{
 const scope=scopes.getStore();
 if(!scope?.active)return verify();
 let key:string;
 // An uncacheable runtime value must retain the original verification behavior.
 try{key=binding();}catch{return verify();}
 let checks=scope.readers.get(reader);
 if(!checks){checks=new Map();scope.readers.set(reader,checks);}
 const existing=checks.get(key);
 if(existing)return existing;
 const entries=checks;
 const pending=Promise.resolve().then(verify).then(()=>{
  // Mutable inputs must not leave a successful result under their earlier binding.
  let unchanged=false;
  try{unchanged=scope.active&&binding()===key;}catch{}
  if(!unchanged)entries.delete(key);
 },error=>{entries.delete(key);throw error;});
 entries.set(key,pending);
 return pending;
}
