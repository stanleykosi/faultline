import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {BudgetExtensions,ModelCallAllowanceView,pinBudgetExtension,type ModelCallAllowance} from './BudgetExtensions';
import type {Investigation} from '../../api';

const item:Investigation={id:'case',workspace_id:'workspace',title:'Synthetic',question:'Question',affected_flow:'checkout',active_revision_id:'current-input',lifecycle:'open',archived:false,revision:9,created_at:'2026-10-13T12:00:00Z',updated_at:'2026-10-13T12:00:00Z'};
const allowance:ModelCallAllowance={automatic_calls:4,owner_granted_calls:2,total_calls:6,maximum_owner_granted_calls:4,token_allowance_increased:false};
const facts=()=>({case_id:'case',revision_id:'current-input',limits:{model:{...allowance}}});
test('review allows the remaining exact revision calls without raising token allowance',()=>{
  const review=pinBudgetExtension(item,facts(),2,'  Investigate a competing explanation.  ');
  assert.equal(review.additional_calls,2);assert.equal(review.case_revision,9);assert.equal(review.revision_id,'current-input');assert.equal(review.reason,'Investigate a competing explanation.');
  assert.equal(review.allowance.token_allowance_increased,false);assert.equal(review.allowance.total_calls,6);
  for(const calls of [0,3,4,5,1.5,NaN])assert.throws(()=>pinBudgetExtension(item,facts(),calls,'Reason'));
  for(const reason of ['   ','x'.repeat(2001)])assert.throws(()=>pinBudgetExtension(item,facts(),1,reason));
});
test('historical or inactive revisions and incoherent/unknown allowance fail review',()=>{
  for(const current of [{...item,archived:true},{...item,lifecycle:'closed'},{...item,active_revision_id:'changed-input'},{...item,revision:0}])assert.throws(()=>pinBudgetExtension(current,facts(),1,'Reason'));
  for(const model of [{...allowance,total_calls:7},{...allowance,owner_granted_calls:5},{...allowance,maximum_owner_granted_calls:5},{...allowance,automatic_calls:NaN}])assert.throws(()=>pinBudgetExtension(item,{...facts(),limits:{model}},1,'Reason'));
  assert.throws(()=>pinBudgetExtension(item,{...facts(),case_id:'other-case'},1,'Reason'));
});
test('unknown model call metadata is not rendered as zero allowance',()=>{
  const missing=renderToStaticMarkup(<ModelCallAllowanceView allowance={null}/>);assert.match(missing,/Call limit unknown/);assert.doesNotMatch(missing,/>0</);
  const actual=renderToStaticMarkup(<ModelCallAllowanceView allowance={allowance}/>);
  for(const label of ['Included agent calls','Extra calls added','Total calls','Maximum extra calls','Token limit changed'])assert.ok(actual.includes(label));
  assert.match(actual,/>No</);assert.match(actual,/>6</);
});
test('analyst allowances are read-only and viewer receives no grant/inventory controls',()=>{
  const workspace={id:'workspace',name:'Synthetic',created_at:'2026-10-13T12:00:00Z',revision:1};
  const analyst=renderToStaticMarkup(<BudgetExtensions workspace={{...workspace,role:'analyst'}} csrf=""/>);
  assert.match(analyst,/Only an owner can add calls/);assert.match(analyst,/Previous changes/);assert.doesNotMatch(analyst,/Reason|Review extra calls/);
  const viewer=renderToStaticMarkup(<BudgetExtensions workspace={{...workspace,role:'viewer'}} csrf=""/>);
  assert.match(viewer,/Owner or analyst access required/);assert.doesNotMatch(viewer,/Investigation|Previous changes|Add calls/);
});
