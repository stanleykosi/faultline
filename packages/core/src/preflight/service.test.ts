import test from 'node:test';import assert from 'node:assert/strict';
import {operationSelection} from './service.js';
const id='00000000-0000-4000-8000-000000000001';
test('operation selectors remain finite and plan preparation cannot borrow execution or foreign selectors',()=>{
 assert.deepEqual(operationSelection({}),{});assert.deepEqual(operationSelection({operation:'analytic',analytic_plan_id:id}),{operation:'analytic',analytic_plan_id:id});
 assert.deepEqual(operationSelection({operation:'browser_plan',objective:'correction',candidate_id:id}),{operation:'browser_plan',objective:'correction',candidate_id:id});
 for(const request of [{operation:['analytic','browser_run']},{operation:'analytic',target:'https://example.com'},{operation:'analytic',plan_id:id},{operation:'browser_plan',grant_id:id},{operation:'browser_run',analytic_plan_id:id},{operation:'browser_plan',objective:'mechanism',candidate_id:id},{hypothesis_id:id},{operation:'analytic',hypothesis_id:'../private'},null])assert.throws(()=>operationSelection(request));
});
