import type {ConstructorOptions,SendOptions} from 'pg-boss';

/** Longer than the 660-second authenticated external-runner request ceiling. */
export const FAULTLINE_DELIVERY_EXPIRY_SECONDS=720;

export function createPgBossOptions(connectionString:string,instanceName:string|undefined):ConstructorOptions {
 return {
  connectionString,
  schema:'pgboss',
  max:4,
  migrate:false,
  supervise:true,
  ...(instanceName===undefined?{}:{instanceName}),
 };
}

export function createPgBossSendOptions(id:string):SendOptions {
 return {id,retryLimit:2,expireInSeconds:FAULTLINE_DELIVERY_EXPIRY_SECONDS};
}
