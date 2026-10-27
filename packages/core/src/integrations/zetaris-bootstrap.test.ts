import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerZetarisRestAdapters} from './zetaris-bootstrap.js';
import {ZetarisRuntimeRegistry,type ZetarisRuntimeSourceConfig} from './zetaris-runtime.js';

const binding={adapter_id:'zetaris-rest-v1',approved_origin:'https://zetaris.example.com',contract_hash:'a'.repeat(64),organisation_id:7};
const env=(entries:unknown=[binding]):NodeJS.ProcessEnv=>({ZETARIS_REST_ADAPTERS:JSON.stringify(entries),CONNECTOR_ALLOWED_ORIGINS:JSON.stringify([binding.approved_origin])});

test('startup installs the real REST implementation without network calls or fabricated availability',async()=>{
  const registry=new ZetarisRuntimeRegistry();
  assert.equal(registerZetarisRestAdapters({},registry),0);
  assert.equal(registerZetarisRestAdapters(env(),registry),1);
  assert.equal(registerZetarisRestAdapters(env(),registry),0,'Repeated API construction must not register duplicates');
  const source:ZetarisRuntimeSourceConfig={schema_version:1,protocol:'faultline-zetaris-v1',adapter_id:binding.adapter_id,approved_origin:binding.approved_origin,contract_hash:binding.contract_hash,approved_account_scope:'zetaris:org:7',workspace_id:'workspace',source_id:'source',approved_views:[{id:'events',role:'sessions',identifier:'demo.events',columns:{record_id:'id'}}],approved_view_ids:['events']};
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>registry.probe(source,'test-only-not-a-real-key',{signal:controller.signal}),{name:'AbortError'},'An aborted registered adapter must reject before a socket opens; an absent adapter would return blocked');
});

test('startup rejects unapproved, ambiguous, secret-bearing and changed organisation bindings',()=>{
  for(const value of ['not-json',JSON.stringify({}),JSON.stringify([{...binding,token:'never-configure-keys-here'}]),JSON.stringify([{...binding,organisation_id:0}]),JSON.stringify([{...binding,approved_origin:'http://127.0.0.1:8888'}])]){
    assert.throws(()=>registerZetarisRestAdapters({...env(),ZETARIS_REST_ADAPTERS:value},new ZetarisRuntimeRegistry()));
  }
  assert.throws(()=>registerZetarisRestAdapters({...env(),CONNECTOR_ALLOWED_ORIGINS:'[]'},new ZetarisRuntimeRegistry()));
  assert.throws(()=>registerZetarisRestAdapters(env([binding,binding]),new ZetarisRuntimeRegistry()));
  const registry=new ZetarisRuntimeRegistry();registerZetarisRestAdapters(env(),registry);
  assert.throws(()=>registerZetarisRestAdapters(env([{...binding,organisation_id:8}]),registry),/Restart/);
});
