import {demand} from '../errors.js';
import {normalizeEventTime, eventMicros} from '../imports/time.js';

export type ActivityQuery = {case_id?:string; actor_id?:string; cursor?:string; limit?:number; action?:string; operation?:string; from?:string; to?:string};
export type ActivityFilters = {case_id:string|null; actor_id:string|null; action:string|null; from:string|null; to:string|null; limit:number; cursor:string|undefined};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Better Auth principal IDs are opaque, case-sensitive strings; do not assume UUIDs.
const principalId = /^[A-Za-z0-9_-]{1,128}$/;

/** Declared audit action and the existing operation alias describe one filter. */
export function activityFilters(query:ActivityQuery, ownerAudit:boolean):ActivityFilters {
  const allowed = ownerAudit ? ['case_id','actor_id','cursor','limit','action','operation','from','to'] : ['case_id','cursor','limit'];
  demand(query && typeof query === 'object' && !Array.isArray(query) && Object.keys(query).every(key => allowed.includes(key)), 'INVALID_QUERY', 'Choose declared activity filters.', 400);
  const limit = query.limit ?? 50;
  demand(Number.isInteger(limit) && limit > 0 && limit <= 200, 'INVALID_LIMIT', 'Choose 1..200 records.', 400);
  demand(query.cursor === undefined || typeof query.cursor === 'string' && query.cursor.length > 0 && query.cursor.length <= 1000, 'INVALID_CURSOR', 'Choose a finite cursor.', 400);
  demand(query.case_id === undefined || typeof query.case_id === 'string' && uuid.test(query.case_id), 'INVALID_CASE_ID', 'Choose an exact case UUID.', 400);
  demand(query.actor_id === undefined || typeof query.actor_id === 'string' && principalId.test(query.actor_id), 'INVALID_ACTOR_ID', 'Choose an exact actor identity.', 400);
  for (const name of ['action','operation'] as const) demand(query[name] === undefined || typeof query[name] === 'string' && query[name]!.length > 0 && query[name]!.length <= 200 && !/[\u0000-\u001f\u007f]/.test(query[name]!), 'INVALID_ACTION', 'Choose an exact finite audit action.', 400);
  demand(query.action === undefined || query.operation === undefined || query.action === query.operation, 'CONFLICTING_FILTERS', 'Action and operation must identify the same audit action.', 400);
  function instant(value:unknown):string|null {
    if (value === undefined) return null;
    try {return normalizeEventTime(value);} catch {demand(false, 'INVALID_INTERVAL', 'Audit time boundaries require valid ISO instants with known timezones.', 400);}
  }
  const from = instant(query.from), to = instant(query.to);
  demand(from === null || to === null || eventMicros(from) < eventMicros(to), 'INVALID_INTERVAL', 'Audit from must precede to.', 400);
  return {case_id:query.case_id?.toLowerCase() ?? null, actor_id:query.actor_id ?? null, action:query.action ?? query.operation ?? null, from, to, limit, cursor:query.cursor};
}

export function activityScope(wid:string,pid:string,ownerAudit:boolean,filters:ActivityFilters) {
  return {wid,pid,ownerAudit,case_id:filters.case_id,actor_id:filters.actor_id,action:filters.action,from:filters.from,to:filters.to};
}

/** Only validated values enter parameters; filter text never enters SQL. */
export function activityQuery(wid:string,pid:string,ownerAudit:boolean,filters:ActivityFilters,position:{created_at:string;id:string}|null) {
  demand(ownerAudit || filters.actor_id === null, 'INVALID_QUERY', 'Personal activity cannot select another actor.', 400);
  const values:unknown[] = [wid], clauses = ['workspace_id=$1'];
  const bind = (value:unknown) => {values.push(value); return '$' + values.length;};
  if (!ownerAudit) clauses.push(`user_id=${bind(pid)}`);
  if (filters.case_id !== null) clauses.push(ownerAudit ? `details->>'case_id'=${bind(filters.case_id)}::text` : `case_id=${bind(filters.case_id)}::uuid`);
  if (ownerAudit && filters.actor_id !== null) clauses.push(`actor_id=${bind(filters.actor_id)}::text`);
  if (filters.action !== null) clauses.push(`operation=${bind(filters.action)}::text`);
  if (filters.from !== null) clauses.push(`created_at>=${bind(filters.from)}::timestamptz`);
  if (filters.to !== null) clauses.push(`created_at<${bind(filters.to)}::timestamptz`);
  if (position) clauses.push(`(created_at,id)>(${bind(position.created_at)}::timestamptz,${bind(position.id)}::uuid)`);
  return {text:`SELECT * FROM faultline.${ownerAudit?'audit':'notifications'} WHERE ${clauses.join(' AND ')} ORDER BY created_at,id LIMIT ${bind(filters.limit+1)}`, values};
}
