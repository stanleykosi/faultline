process.env.PROCESS_ROLE='api';
const {buildServer}=await import('./server.js');
const {config}=await import('../../../packages/core/src/config.js');
const {warmApiPools,closeRuntimePools,requireDatabase}=await import('../../../packages/database/src/client.js');
const {verifyRuntimeSchema}=await import('../../../packages/database/src/runtime-schema.js');
const {DomainError}=await import('../../../packages/core/src/errors.js');
const app=await buildServer();
try{await warmApiPools();await verifyRuntimeSchema(requireDatabase());}catch(error){
 await app.close();
 await closeRuntimePools();
 console.error('Faultline API startup blocked: '+(error instanceof DomainError?error.code:'DEPENDENCY_UNAVAILABLE'));
 process.exit(1);
}
await app.listen({port:config.port,host:config.apiBindHost});
console.log('Faultline API: '+config.origin);
let shutdown:Promise<void>|null=null;
const stop=()=>{
 if(shutdown)return shutdown;
 shutdown=(async()=>{try{await app.close();}finally{await closeRuntimePools();}})().catch(()=>{process.exitCode=1;});
 return shutdown;
};
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,stop);

