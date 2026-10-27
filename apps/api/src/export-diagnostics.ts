import type {FastifyInstance} from 'fastify';
export function installExportMetadataDiagnostics(app:FastifyInstance,enabled=process.env.FAULTLINE_EXPORT_METADATA_TRACE==='1',sink:(value:object)=>void=value=>console.info('FAULTLINE_EXPORT_METADATA '+JSON.stringify(value))):void{
 if(!enabled)return;
 const exportRoute=(template:string|undefined)=>template?.endsWith('/exports/:exportId')===true;
 const attempt=(request:{headers:Record<string,unknown>})=>{const value=request.headers['x-faultline-download-attempt'];return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value:null;};
 app.addHook('onSend',async(request,reply,payload)=>{
  if(exportRoute(request.routeOptions.url)){
   reply.header('x-request-id',request.id);
   sink({phase:'prepared_response',at:new Date().toISOString(),request_id:request.id,download_attempt:attempt(request),route:request.routeOptions.url,status:reply.statusCode,content_type:reply.getHeader('content-type')??null,byte_length:Buffer.isBuffer(payload)?payload.length:typeof payload==='string'?Buffer.byteLength(payload):null});
  }
  return payload;
 });
 app.addHook('onResponse',async(request,reply)=>{
  if(exportRoute(request.routeOptions.url))sink({phase:'response_finished',at:new Date().toISOString(),request_id:request.id,download_attempt:attempt(request),route:request.routeOptions.url,status:reply.statusCode,content_type:reply.getHeader('content-type')??null,content_length:reply.getHeader('content-length')??null});
 });
}
