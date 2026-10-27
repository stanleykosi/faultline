import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {validateOperatorRegistration,stagingOrigin} from './operator-profile.js';
const wid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sha='a'.repeat(64),clock=Date.parse('2026-10-13T00:00:00.000Z');
function registration<T extends object>(kind:string,profile:T){return {schema_version:1,workspace_id:wid,kind,id:kind+'-one',profile};}
const network={origins:['https://staging.example.org'],path_prefixes:['/checkout','/sandbox'],credential_refs:[],deny_private_addresses:true,max_response_bytes:4096};
const runner={endpoint:'https://runner.example.org',implementation_digest:sha,transport_ca_sha256:sha,peer_certificate_sha256:sha,network_profile_id:'network-one',isolation:'gvisor',isolation_evidence_hash:null};
test('operator metadata has exact scoped fields, no capability claims, owns its immutable input copy',()=>{
 const source=registration('network',network),value=validateOperatorRegistration(source,clock);assert.deepEqual(value,source);(value.profile.origins as string[]).push('https://other.example.org');assert.equal(source.profile.origins.length,1);
 assert.deepEqual(validateOperatorRegistration(registration('runner',runner),clock).profile,runner);
 const environment={runner_id:'runner-one',engine:'chromium',engine_version:'1.2.3',viewports:{mobile:{width:390,height:844},desktop:{width:1280,height:800}},timezone:'UTC',locale:'en-US',feature_flags:[]};assert.deepEqual(validateOperatorRegistration(registration('environment',environment),clock).profile,environment);
 for(const value of [{...source,capabilities:{status:'available'}},{...source,workspace_id:'not-a-workspace'},registration('grant',network),registration('network',{...network,deny_private_addresses:false}),registration('network',{...network,max_response_bytes:65537}),registration('network',{...network,origins:[...network.origins,...network.origins]}),registration('runner',{...runner,isolation:'docker'}),registration('runner',{...runner,implementation_digest:'latest'})])assert.throws(()=>validateOperatorRegistration(value,clock));
});
test('exact staging authority rejects credentials, paths, protocols, IP and local origin tricks before any network access',()=>{
 assert.equal(stagingOrigin('https://staging.example.org'),'https://staging.example.org');
 for(const origin of ['http://staging.example.org','https://staging.example.org/','https://staging.example.org/path','https://staging.example.org?x=1','https://user:password@staging.example.org','https://127.0.0.1','https://localhost','https://x.localhost','https://staging.example.org:8443'])assert.throws(()=>stagingOrigin(origin));
 for(const path of ['//evil.example','/../private','/sandbox?query=1','/sandbox/{script}','/sandbox%2fprivate'])assert.throws(()=>validateOperatorRegistration(registration('network',{...network,path_prefixes:[path]}),clock));
});
test('operator attester accepts only current scoped Ed25519 public keys and external deployment-system metadata',()=>{
 const keys=generateKeyPairSync('ed25519'),publicPem=keys.publicKey.export({type:'spki',format:'pem'}).toString(),privatePem=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const profile={key_id:'deploy-key-one',public_key_pem:publicPem,deployment_scopes:[{deployment_id:'deploy-one',origin:'https://staging.example.org',repository_id:'repo-one',environment_id:'environment-one'}],valid_from:'2026-10-12T00:00:00.000Z',expires_at:'2026-10-14T00:00:00.000Z',purposes:['build','deployment'],observer:{adapter_id:'operator-observer',adapter_version:'1',configuration_hash:sha,independence:'deployment_system'}};
 assert.deepEqual(validateOperatorRegistration(registration('attester',profile),clock).profile,profile);
 const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();
 for(const value of [{...profile,public_key_pem:privatePem},{...profile,public_key_pem:ec},{...profile,valid_from:'2026-10-14T00:00:00.000Z'},{...profile,expires_at:'2026-10-13T00:00:00.000Z'},{...profile,expires_at:'2026-02-30T00:00:00.000Z'},{...profile,observer:{...profile.observer,independence:'candidate_header'}},{...profile,deployment_scopes:[...profile.deployment_scopes,...profile.deployment_scopes]}])assert.throws(()=>validateOperatorRegistration(registration('attester',value),clock));
});
