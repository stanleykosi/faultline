export interface PoolSnapshot {
 totalCount:number;
 idleCount:number;
 waitingCount:number;
 options?:{max?:number};
}

type FailureClass='pool_acquire_timeout'|'connection_transport'|'postgres_sqlstate'|'unknown';
const maxMetric=2_147_483_647;
// Exact messages from the installed pg-pool 3.14.0 acquisition paths.
const poolTimeoutMessages=new Set([
 'timeout exceeded when trying to connect',
 'Connection terminated due to connection timeout',
]);
const transportCodes=new Set([
 'ECONNREFUSED','ECONNRESET','ECONNABORTED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH',
 'ENETDOWN','EHOSTDOWN','EAI_AGAIN','ENOTFOUND','EPIPE','EPROTO','ERR_SOCKET_CLOSED',
 'ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
 'SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const sqlstateClasses=new Set([
 '00','01','02','03','08','09','0A','0B','0F','0L','0P','0Z','10','20','21','22','23',
 '24','25','26','27','28','2B','2D','2F','34','38','39','3B','3D','3F','40','42','44',
 '53','54','55','57','58','F0','HV','P0','XX',
]);

function property(value:unknown,key:string):unknown {
 if((typeof value!=='object'||value===null)&&typeof value!=='function')return undefined;
 try{return (value as Record<string,unknown>)[key];}catch{return undefined;}
}

function metric(value:unknown):number {
 return typeof value==='number'&&!Number.isNaN(value)?Math.min(maxMetric,Math.max(0,Math.floor(value))):0;
}

function snapshot(pool:PoolSnapshot|null|undefined) {
 if(pool==null)return null;
 const maximum=property(property(pool,'options'),'max');
 return {
  totalCount:metric(property(pool,'totalCount')),
  idleCount:metric(property(pool,'idleCount')),
  waitingCount:metric(property(pool,'waitingCount')),
  max:typeof maximum==='number'?metric(maximum):null,
 };
}

/** A log-safe projection. Error objects and pool options never enter the result. */
export function serviceFailureDiagnostic(
 error:unknown,
 pools:{domain?:PoolSnapshot|null;auth?:PoolSnapshot|null},
 context:{request_id:string;route:string;elapsed_ms:number},
) {
 const code=property(error,'code');
 const message=property(error,'message');
 let failure_class:FailureClass='unknown';
 let pg_code:string|undefined;
 if(typeof message==='string'&&poolTimeoutMessages.has(message))failure_class='pool_acquire_timeout';
 else if(typeof code==='string'&&transportCodes.has(code))failure_class='connection_transport';
 else if(typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)&&sqlstateClasses.has(code.slice(0,2))){
  failure_class='postgres_sqlstate';pg_code=code;
 }
 return {
  diagnostic:'request_service_failure' as const,
  request_id:context.request_id.slice(0,128),
  route:context.route.slice(0,256),
  elapsed_ms:metric(context.elapsed_ms),
  failure_class,
  ...(pg_code===undefined?{}:{pg_code}),
  pools:{domain:snapshot(pools.domain),auth:snapshot(pools.auth)},
 };
}
