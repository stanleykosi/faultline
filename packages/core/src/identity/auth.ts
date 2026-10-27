import {AsyncLocalStorage} from 'node:async_hooks';
import {betterAuth,type User} from 'better-auth';
import {APIError} from 'better-auth/api';
import {authPool} from '../../../database/src/client.js';
import {config} from '../config.js';
export const enrollmentContext=new AsyncLocalStorage<{hash:string,email:string}>();
export function makeAuth(database=authPool){
 if(!database)return null;
 return betterAuth({
  database,baseURL:config.origin,basePath:'/api/auth',secret:config.authSecret,trustedOrigins:[config.origin],
  emailAndPassword:{enabled:true,minPasswordLength:12,autoSignIn:true},
  user:{additionalFields:{enrollmentHash:{type:'string',required:false,input:false,returned:false}}},
  session:{expiresIn:60*60*24*7,updateAge:60*60*24,cookieCache:{enabled:false}},
  advanced:{
   database:{joins:true},
   useSecureCookies:config.production,
   defaultCookieAttributes:{httpOnly:true,sameSite:'lax',path:'/'},
   ...(config.production?{ipAddress:{ipAddressHeaders:['x-vercel-forwarded-for','x-real-ip']}}:{}),
  },
  databaseHooks:{user:{create:{before:async (user:User)=>{
   const permission=enrollmentContext.getStore();
   if(!permission||permission.email.toLowerCase()!==user.email.toLowerCase())throw new APIError('FORBIDDEN',{message:'A valid signup, operator bootstrap, or active invitation is required.'});
   return {data:{...user,enrollmentHash:permission.hash}};
  }}}}
 });
}
export const auth=makeAuth();

