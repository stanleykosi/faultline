import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ReplacementActivationReview,CredentialRevocationReview,replacementCanActivate,type Replacement} from './CredentialReplacement';

const credential={secret_id:'secret-id',active_version:1,revision:3,hint:'masked',revoked:false},clock=Date.parse('2026-10-14T12:00:00.000Z');
const replacement:Replacement={id:'replacement-id',secret_id:'secret-id',version:2,base_secret_revision:3,revision:3,status:'probed',resource_kind:'source',resource_id:'source-id',resource_revision:4,resource_binding:{config:{repo:'<script>untrusted</script>'},declaration:{id:'declaration-id',hash:'b'.repeat(64)}},resource_binding_hash:'a'.repeat(64),probe_binding_hash:'c'.repeat(64),probe_expires_at:'2026-10-14T12:10:00.000Z',capabilities:{status:'available'},active_version:1,secret_revision:3,revoked:false};
test('activation visibility requires an available unexpired probe and actual matching secret revision',()=>{
 assert.equal(replacementCanActivate(replacement,credential,clock),true);
 for(const change of [{status:'staged' as const},{status:'failed' as const},{capabilities:{status:'unauthorized'}},{probe_binding_hash:null},{probe_expires_at:'2026-10-14T11:59:00.000Z'},{secret_revision:4},{revoked:true}])assert.equal(replacementCanActivate({...replacement,...change},credential,clock),false);
 for(const change of [{revision:undefined},{revision:4},{revoked:true},{secret_id:'different-secret'}])assert.equal(replacementCanActivate(replacement,{...credential,...change},clock),false);
});
test('activation review shows exact candidate and immutable declaration/probe review scope without a secret field',()=>{
 const html=renderToStaticMarkup(<ReplacementActivationReview replacement={replacement}/>);
 for(const text of ['candidate version 2','source-id','replacement-id','resource revision 4','declaration-id','successful probe binding','previous version','evidence is retained'])assert.ok(html.toLowerCase().includes(text.toLowerCase()),text);
 assert.ok(html.includes('c'.repeat(64)));assert.ok(html.includes('&lt;script&gt;'));assert.doesNotMatch(html,/<script>|type="password"|name="value"/);
});
test('revocation review distinguishes cancellation boundaries from evidence deletion',()=>{
 const html=renderToStaticMarkup(<CredentialRevocationReview credential={credential}/>);
 for(const text of ['secret-id','active version 1','secret revision 3','cancellation requests','cannot publish a complete result','snapshots','are retained'])assert.ok(html.includes(text),text);
});
