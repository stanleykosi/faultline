import {hash} from '../canonical.js';
import {ConnectorError,requireWire} from '../connectors/wire.js';
import {exactOrigin} from './transport.js';
import {createZetarisRestAdapter,type ZetarisRestAdapterConfig} from './zetaris-http.js';
import {zetarisRuntimeRegistry,type ZetarisRuntimeRegistry} from './zetaris-runtime.js';

const installed=new WeakMap<ZetarisRuntimeRegistry,Map<string,string>>();

/** Installs reviewed HTTP implementations; registration performs no provider call.
 * Credentials remain in the versioned workspace secret store, never this JSON.
 */
export function registerZetarisRestAdapters(
  env:NodeJS.ProcessEnv=process.env,
  registry:ZetarisRuntimeRegistry=zetarisRuntimeRegistry,
):number {
  const raw=env.ZETARIS_REST_ADAPTERS?.trim();
  if(!raw)return 0;
  requireWire(Buffer.byteLength(raw)<=65536,'INVALID_ZETARIS_ADAPTER_CONFIG','Zetaris adapter configuration exceeds its finite byte limit.');
  let value:unknown,origins:unknown;
  try{value=JSON.parse(raw);origins=JSON.parse(env.CONNECTOR_ALLOWED_ORIGINS??'[]');}
  catch{throw new ConnectorError('INVALID_ZETARIS_ADAPTER_CONFIG','Use finite JSON arrays for the Zetaris bindings and approved connector origins.');}
  requireWire(Array.isArray(value)&&value.length<=10,'INVALID_ZETARIS_ADAPTER_CONFIG','Configure at most ten reviewed Zetaris REST bindings.');
  requireWire(Array.isArray(origins)&&origins.length<=30&&origins.every(item=>typeof item==='string'),'INVALID_ZETARIS_ADAPTER_CONFIG','Register exact connector origins before configuring Zetaris.');
  const allowed=(origins as string[]).map(exactOrigin);
  const prepared=value.map(item=>{
    requireWire(Boolean(item)&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).sort().join(',')==='adapter_id,approved_origin,contract_hash,organisation_id','INVALID_ZETARIS_ADAPTER_CONFIG','Zetaris bindings contain only adapter identity, origin, contract hash and organisation ID.');
    const config=item as ZetarisRestAdapterConfig;
    requireWire(typeof config.approved_origin==='string'&&allowed.includes(config.approved_origin),'PROVIDER_ORIGIN_NOT_APPROVED','Register this exact Zetaris origin in CONNECTOR_ALLOWED_ORIGINS.');
    return {config,factory:createZetarisRestAdapter(config),key:hash({adapter_id:config.adapter_id,approved_origin:config.approved_origin,contract_hash:config.contract_hash}),binding:hash(config)};
  });
  requireWire(new Set(prepared.map(item=>item.key)).size===prepared.length,'INVALID_ZETARIS_ADAPTER_CONFIG','Zetaris bindings must be unique.');
  const current=installed.get(registry)??new Map<string,string>();
  for(const item of prepared)requireWire(!current.has(item.key)||current.get(item.key)===item.binding,'ZETARIS_ADAPTER_BINDING_CHANGED','Restart the service to change an installed Zetaris organisation binding.');
  let count=0;
  for(const item of prepared){if(current.has(item.key))continue;registry.register(item.factory);current.set(item.key,item.binding);count++;}
  installed.set(registry,current);
  return count;
}
