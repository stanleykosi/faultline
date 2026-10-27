import {createVercelHandler} from './vercel-handler.js';

type Server = Awaited<ReturnType<typeof import('./server.js')['buildServer']>>;
async function initialize():Promise<Server>{
 process.env.PROCESS_ROLE='api';
 process.env.FAULTLINE_HOSTING_PROFILE='vercel-supabase';
 // Kept outside the product dependency graph: this entrypoint alone materializes ephemeral keys.
 // @ts-expect-error the native .mjs operator has runtime tests rather than TypeScript declarations.
 const {initializeVercelRuntime}=await import('../../../scripts/initialize-vercel-runtime.mjs');
 await initializeVercelRuntime();
 const [{buildServer},{pool,authPool,requireDatabase},{attachDatabasePool},{verifyRuntimeSchema}]=await Promise.all([import('./server.js'),import('../../../packages/database/src/client.js'),import('@vercel/functions'),import('../../../packages/database/src/runtime-schema.js')]);
 for(const connection of [pool,authPool])if(connection)attachDatabasePool(connection);
 await verifyRuntimeSchema(requireDatabase());const app=await buildServer();await app.ready();return app;
}
/** Vercel owns the HTTP listener and invocation lifecycle. */
export default createVercelHandler(initialize);
