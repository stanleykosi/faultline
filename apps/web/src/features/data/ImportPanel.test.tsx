import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError, casePath, type Investigation} from '../../api';
import {ImportPanel, canDiscardImport, pinImportDiscardReview, submitImportDiscard} from './ImportPanel';
import type {ImportRecord} from './types';
import type {CommandIdentity} from '../../command-key';

const investigation:Investigation={id:'case',workspace_id:'workspace',title:'Synthetic',question:'Review',affected_flow:'checkout',active_revision_id:'revision',lifecycle:'open',archived:false,revision:7,created_at:'2026-10-13T12:00:00Z',updated_at:'2026-10-13T12:00:00Z'};
const base=casePath('workspace','case'), record:ImportRecord={id:'staged-import',source_id:'source',record_kind:'analytics',stage:'blocked'};
test('discard review rejects accepted/queued or linked work and wrong parent authority',()=>{
  for(const stage of ['staged','mapped','review_ready','blocked']) assert.equal(canDiscardImport({...record,stage}),true);
  for(const changed of [{stage:'accepted'},{stage:'queued'},{stage:'discarded'},{snapshot_id:'snapshot'},{job_id:'job'}])assert.equal(canDiscardImport({...record,...changed}),false);
  assert.throws(()=>pinImportDiscardReview(casePath('other','case'),record,investigation));
  assert.throws(()=>pinImportDiscardReview(base,record,{...investigation,lifecycle:'closed'}));
  assert.throws(()=>pinImportDiscardReview(base,record,{...investigation,archived:true}));
});
test('discard issues no request without acknowledgment or after staged state changes',async()=>{
  const review=pinImportDiscardReview(base,record,investigation), original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:204});};
  try {
    await assert.rejects(submitImportDiscard(review,record,'csrf',false,{current:null}),/Review the exact/);
    await assert.rejects(submitImportDiscard(review,{...record,job_id:'queued-job'},'csrf',true,{current:null}),error=>error instanceof ApiError&&error.status===409);
    assert.equal(calls,0);
  }finally{globalThis.fetch=original;}
});
test('actual empty discard response uses exact reviewed parent revision and failed stale response retains command identity',async()=>{
  const review=pinImportDiscardReview(base,record,investigation), original=globalThis.fetch, identity:{current:CommandIdentity}={current:null};
  let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(url,base+'/imports/staged-import');assert.equal(options?.method,'DELETE');assert.equal(options?.body,undefined);
    const headers=new Headers(options?.headers);assert.equal(headers.get('X-Faultline-Revision'),calls===1?'7':'8');assert.equal(headers.get('X-CSRF-Token'),'csrf');assert.ok(headers.get('Idempotency-Key'));
    return calls===1?new Response(JSON.stringify({error:{code:'STALE_INPUTS',message:'Parent case changed.'}}),{status:409,headers:{'Content-Type':'application/json'}}):new Response(null,{status:204});
  };
  try {
    await assert.rejects(submitImportDiscard(review,record,'csrf',true,identity),error=>error instanceof ApiError&&error.status===409);assert.ok(identity.current);
    const fresh=pinImportDiscardReview(base,record,{...investigation,revision:8});
    await submitImportDiscard(fresh,record,'csrf',true,identity);assert.equal(identity.current,null);
  }finally{globalThis.fetch=original;}
});
test('accepted import has no discard UI; staged import exposes review only when parent callback permits it',()=>{
  const props={base,csrf:'',snapshots:[],savedMappingId:'',onImport:()=>{},onJob:()=>{}};
  assert.doesNotMatch(renderToStaticMarkup(<ImportPanel {...props} current={{...record,stage:'accepted',snapshot_id:'snapshot'}} onDiscard={()=>{}}/>),/Review discard/);
  assert.doesNotMatch(renderToStaticMarkup(<ImportPanel {...props} current={record}/>),/Review discard/);
  assert.match(renderToStaticMarkup(<ImportPanel {...props} current={record} onDiscard={()=>{}}/>),/Review discard/);
});

test('a staged or newly mapped import has no preview yet; actual blocked preview retains its issues and cannot be saved',()=>{
 const props={base,csrf:'',snapshots:[],savedMappingId:'',onImport:()=>{},onJob:()=>{}};
 for(const stage of ['staged','mapped']){
  const html=renderToStaticMarkup(<ImportPanel {...props} current={{...record,stage,can_finalize:false}}/>);
  assert.match(html,/Preview not run/);assert.doesNotMatch(html,/Preview is blocked|Resolve the recorded invalid fields|Save snapshot/);
 }
 const html=renderToStaticMarkup(<ImportPanel {...props} current={{...record,stage:'blocked',can_finalize:false,counts:{input:2,rejected:1},issues:[{code:'CONFLICTING_EVENT_ID',message:'Conflicting event identity.'}]}}/>);
 assert.match(html,/Preview is blocked/);assert.match(html,/CONFLICTING_EVENT_ID/);assert.match(html,/Conflicting event identity/);assert.match(html,/Resolve the recorded invalid fields/);assert.doesNotMatch(html,/Save snapshot/);
});
