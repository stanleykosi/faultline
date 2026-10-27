import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {createFreshHostingSettings,missingSettingsPlan,hostingTarget,supabaseRequired} from './settings.mjs';
test('fresh hosting keys are independent, internally valid and stay server-side',()=>{
 const a=createFreshHostingSettings(),b=createFreshHostingSettings();assert.notEqual(a.AUTH_SECRET,b.AUTH_SECRET);assert.ok(a.AUTH_SECRET.length>=32);
 const ring=JSON.parse(Buffer.from(a.FAULTLINE_SEALED_SECRET_KEYRING_JSON_B64,'base64'));assert.equal(Buffer.from(ring.keys[ring.active],'base64').length,32);
 const privateKey=createPrivateKey(Buffer.from(a.FAULTLINE_SEALED_REPORT_SIGNING_PRIVATE_PEM_B64,'base64')),publicKey=createPublicKey(Buffer.from(a.FAULTLINE_SEALED_REPORT_SIGNING_PUBLIC_PEM_B64,'base64'));
 assert.equal(verify(null,Buffer.from('independent synthetic receipt'),publicKey,sign(null,Buffer.from('independent synthetic receipt'),privateKey)),true);
 assert.equal(a.APP_ORIGIN,hostingTarget.origin);assert.equal(a.PUBLIC_SIGNUP_ENABLED,'true');assert.equal(a.RUNNER_MODE,'disabled');
 assert.ok(Object.keys(a).every(k=>!k.startsWith('VITE_')&&!supabaseRequired.includes(k)));
});
test('resuming preparation never replaces existing production credentials or settings',()=>{
 const settings=createFreshHostingSettings(),existing=Object.keys(settings).map(key=>({key,target:['production'],value:'must not inspect or replace'}));
 assert.deepEqual(missingSettingsPlan(settings,existing),[]);
 const plan=missingSettingsPlan(settings,[{key:'AUTH_SECRET',target:['production']}]);assert.ok(!plan.some(r=>r.key==='AUTH_SECRET'));assert.ok(plan.find(r=>r.key==='FAULTLINE_SEALED_SECRET_KEYRING_JSON_B64').secret);
});
test('configuration refuses another origin and refuses injecting Supabase credentials or browser secrets',()=>{
 const s=createFreshHostingSettings();assert.throws(()=>missingSettingsPlan({...s,APP_ORIGIN:'https://elsewhere.example'},[]),/TARGET_MISMATCH/);
 for(const key of ['VITE_SECRET','DATABASE_URL','SUPABASE_STORAGE_SERVICE_KEY'])assert.throws(()=>missingSettingsPlan({...s,[key]:'synthetic'},[]),/SCOPE_REFUSED/);
});
