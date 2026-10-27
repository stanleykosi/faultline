import {randomBytes,generateKeyPairSync} from 'node:crypto';

export const hostingTarget=Object.freeze({project:process.env.FAULTLINE_VERCEL_PROJECT_ID??'YOUR_VERCEL_PROJECT_ID',scope:process.env.FAULTLINE_VERCEL_TEAM_ID??'YOUR_VERCEL_TEAM_ID',origin:process.env.FAULTLINE_VERCEL_ORIGIN??'https://faultline.example'});
export const supabaseRequired=Object.freeze(['DATABASE_URL','AUTH_DATABASE_URL','QUEUE_DATABASE_URL','DISPATCHER_DATABASE_URL','SUPABASE_URL','SUPABASE_STORAGE_SERVICE_KEY']);
export function createFreshHostingSettings(){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const keyring={active:'vercel-v1',keys:{'vercel-v1':randomBytes(32).toString('base64')}};
 return {
  NODE_ENV:'production',FAULTLINE_HOSTING_PROFILE:'vercel-supabase',APP_ORIGIN:hostingTarget.origin,
  AUTH_SECRET:randomBytes(48).toString('base64url'),PUBLIC_SIGNUP_ENABLED:'true',AUTH_DATABASE_SCHEMA:'faultline_identity',
  OBJECT_STORE:'supabase',SUPABASE_STORAGE_BUCKET:'faultline-private',SUPABASE_UPLOAD_BUCKET:'faultline-uploads',
  MODEL_PROVIDER:'none',MODEL_ALLOWED_ORIGINS:JSON.stringify(['https://openrouter.ai']),RUNNER_MODE:'disabled',ALLOW_FIXTURE_ADAPTERS:'false',DOMAIN_POOL_MAX:'1',AUTH_POOL_MAX:'1',
  FAULTLINE_SEALED_SECRET_KEYRING_JSON_B64:Buffer.from(JSON.stringify(keyring)).toString('base64'),
  FAULTLINE_SEALED_REPORT_SIGNING_PRIVATE_PEM_B64:Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'),
  FAULTLINE_SEALED_REPORT_SIGNING_PUBLIC_PEM_B64:Buffer.from(publicKey.export({type:'spki',format:'pem'})).toString('base64'),
 };
}
export function missingSettingsPlan(settings,existing){
 if(settings.APP_ORIGIN!==hostingTarget.origin||settings.AUTH_DATABASE_SCHEMA!=='faultline_identity'||settings.OBJECT_STORE!=='supabase')throw new Error('HOSTING_SETTINGS_TARGET_MISMATCH');
 if(Object.keys(settings).some(key=>key.startsWith('VITE_')||supabaseRequired.includes(key)))throw new Error('HOSTING_SETTINGS_SCOPE_REFUSED');
 const present=new Set(existing.filter(row=>row.target?.includes('production')).map(row=>row.key));
 // Existing settings, particularly keys, are never replaced by this preparation step.
 return Object.entries(settings).filter(([key])=>!present.has(key)).map(([key,value])=>({key,value,secret:key==='AUTH_SECRET'||key.startsWith('FAULTLINE_SEALED_')}));
}
