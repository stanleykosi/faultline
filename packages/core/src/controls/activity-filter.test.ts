import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityFilters,activityScope,activityQuery} from './activity-filter.js';
import {encodeCursor,decodeCursor} from '../cases/cursor.js';

const cid='70217a64-adac-42a9-a838-34a63792641a', other='4dc4a8f8-d42d-421a-9c85-ea0c622aabf7', actor='Aa1_'.repeat(8);
const fails=(action:()=>unknown,code:string)=>assert.throws(action,(error:unknown)=>error instanceof Error && 'code' in error && error.code===code);

test('audit case filter is an exact bound JSON case identity, with no unrelated rows clause',()=>{
  const q=activityQuery('workspace','owner',true,activityFilters({case_id:cid},true),null);
  assert.equal(q.text,'SELECT * FROM faultline.audit WHERE workspace_id=$1 AND details->>\'case_id\'=$2::text ORDER BY created_at,id LIMIT $3');
  assert.deepEqual(q.values,['workspace',cid,51]);
  const absent=activityQuery('workspace','owner',true,activityFilters({case_id:other},true),null);
  assert.equal(absent.values[1],other); assert.notDeepEqual(absent.values,q.values);
});
test('notification case filter always retains exact workspace and current principal',()=>{
  const q=activityQuery('workspace','viewer',false,activityFilters({case_id:cid,limit:1},false),null);
  assert.equal(q.text,'SELECT * FROM faultline.notifications WHERE workspace_id=$1 AND user_id=$2 AND case_id=$3::uuid ORDER BY created_at,id LIMIT $4');
  assert.deepEqual(q.values,['workspace','viewer',cid,2]);
  const noFilter=activityQuery('workspace','viewer',false,activityFilters({},false),null);
  assert.match(noFilter.text,/workspace_id=\$1 AND user_id=\$2/);
});
test('owner actor filter preserves opaque case-sensitive identity with case/action/half-open time',()=>{
  const filters=activityFilters({case_id:cid,actor_id:actor,action:'case.close',from:'2026-10-13T09:00:00Z',to:'2026-10-14T09:00:00Z',limit:1},true);
  assert.equal(filters.actor_id,actor);
  const q=activityQuery('workspace','owner',true,filters,null);
  assert.equal(q.text,'SELECT * FROM faultline.audit WHERE workspace_id=$1 AND details->>\'case_id\'=$2::text AND actor_id=$3::text AND operation=$4::text AND created_at>=$5::timestamptz AND created_at<$6::timestamptz ORDER BY created_at,id LIMIT $7');
  assert.deepEqual(q.values,['workspace',cid,actor,'case.close','2026-10-13T09:00:00.000000Z','2026-10-14T09:00:00.000000Z',2]);
  assert.ok(!q.text.includes(actor));
});
test('invalid actor IDs are denied and personal activity cannot request or bind any actor selector',()=>{
  for(const value of ['',"x' OR true",actor+'!', 'x'.repeat(129),null,[]]) fails(()=>activityFilters({actor_id:value as string},true),'INVALID_ACTOR_ID');
  fails(()=>activityFilters({actor_id:actor},false),'INVALID_QUERY');
  fails(()=>activityFilters({actor_id:undefined},false),'INVALID_QUERY');
  fails(()=>activityQuery('workspace','viewer',false,activityFilters({actor_id:actor},true),null),'INVALID_QUERY');
});
test('declared action and retained operation alias have identical canonical cursor scope',()=>{
  const a=activityFilters({action:'case.close'},true),b=activityFilters({operation:'case.close'},true);
  assert.deepEqual(a,b); assert.deepEqual(activityScope('w','p',true,a),activityScope('w','p',true,b));
  assert.equal(activityFilters({action:'case.close',operation:'case.close'},true).action,'case.close');
  fails(()=>activityFilters({action:'case.close',operation:'case.reopen'},true),'CONFLICTING_FILTERS');
});
test('audit time filters normalize offsets without losing microseconds and use half-open boundaries',()=>{
  const filters=activityFilters({from:'2026-10-13T10:00:00.000001+01:00',to:'2026-10-13T10:00:00.000002+01:00',action:"x' OR true --"},true);
  assert.equal(filters.from,'2026-10-13T09:00:00.000001Z');
  assert.equal(filters.to,'2026-10-13T09:00:00.000002Z');
  const q=activityQuery('w','p',true,filters,{created_at:'2026-10-13T09:00:00.000001Z',id:cid});
  assert.match(q.text,/operation=\$2::text AND created_at>=\$3::timestamptz AND created_at<\$4::timestamptz AND \(created_at,id\)>\(\$5::timestamptz,\$6::uuid\)/);
  assert.ok(!q.text.includes("x' OR true")); assert.equal(q.values[1],"x' OR true --");
});
test('invalid identifiers, calendar dates, unsupported precision and reversed intervals fail before query',()=>{
  for(const value of ['',"x' OR true",cid+'tail',null,[]]) fails(()=>activityFilters({case_id:value as string},true),'INVALID_CASE_ID');
  for(const value of ['2026-02-30T00:00:00Z','2026-10-13T09:00:00','2026-10-13T09:00:00-00:00','2026-10-13T09:00:00.0000001Z']) fails(()=>activityFilters({from:value},true),'INVALID_INTERVAL');
  for(const to of ['2026-10-13T09:00:00Z','2026-10-13T08:00:00Z']) fails(()=>activityFilters({from:'2026-10-13T09:00:00Z',to},true),'INVALID_INTERVAL');
});
test('undeclared activity filters, repeated/nonstring values and invalid limits cannot silently disappear',()=>{
  fails(()=>activityFilters({action:'case.close'},false),'INVALID_QUERY');
  fails(()=>activityFilters({from:'2026-10-13T09:00:00Z'},false),'INVALID_QUERY');
  fails(()=>activityFilters({arbitrary:'value'} as never,true),'INVALID_QUERY');
  fails(()=>activityFilters({action:['case.close'] as never},true),'INVALID_ACTION');
  for(const limit of [0,201,1.5,NaN,'1']) fails(()=>activityFilters({limit:limit as number},true),'INVALID_LIMIT');
});
test('signed pagination cursor rejects changed case, actor, action, interval, principal, workspace and authority',()=>{
  const filters=activityFilters({case_id:cid,actor_id:actor,action:'case.close',from:'2026-10-13T09:00:00Z'},true),scope=activityScope('w','p',true,filters);
  const token=encodeCursor(scope,{created_at:'2026-10-13T09:00:00.000001Z',id:cid});
  assert.equal(decodeCursor(token,scope)?.id,cid);
  for(const changed of [{...scope,case_id:other},{...scope,actor_id:other},{...scope,actor_id:null},{...scope,action:'case.reopen'},{...scope,from:'2026-10-13T08:00:00.000000Z'},{...scope,pid:'other'},{...scope,wid:'other'},{...scope,ownerAudit:false}]) fails(()=>decodeCursor(token,changed),'INVALID_CURSOR');
  const equivalent=activityScope('w','p',true,activityFilters({case_id:cid.toUpperCase(),actor_id:actor,operation:'case.close',from:'2026-10-13T10:00:00+01:00',limit:10},true));
  assert.equal(decodeCursor(token,equivalent)?.id,cid);
  const changedCase=activityScope('w','p',true,activityFilters({case_id:cid,actor_id:actor.toUpperCase(),action:'case.close',from:'2026-10-13T09:00:00Z'},true));
  assert.notEqual(changedCase.actor_id,actor);
  fails(()=>decodeCursor(token,changedCase),'INVALID_CURSOR');
});
