import test from 'node:test';
import assert from 'node:assert/strict';
import {operationBody} from '../../../contracts/src/transport.js';
import {AGENT_PROMPT_VERSION,CONTINUE_INVESTIGATION,investigationObjective,investigationMission,optionalAgentContext,investigationHistory} from './mission.js';
import {buildAgentPrompt} from './service.js';
import {hash} from '../canonical.js';

test('start and continue transport need no user prompt but retain explicit model and revision',()=>{
 for(const [op,field] of [['createAgentSession','objective'],['createAgentTurn','message']]){
  const ids={profile_id:'profile',revision_id:'revision'};
  assert.deepEqual(operationBody(op!,ids),ids);
  assert.doesNotThrow(()=>operationBody(op!,{...ids,[field!]:''}));
  assert.throws(()=>operationBody(op!,{...ids,[field!]:false}));
  assert.throws(()=>operationBody(op!,{revision_id:'revision'}));
 }
});

test('server derives a bounded mission from the saved case and preserves optional business context',()=>{
 const saved={title:'Checkout investigation',question:'Why did completed checkout fall?',affected_flow:'Web checkout'};
 const purpose=investigationObjective(saved);
 assert.match(purpose,/Why did completed checkout fall/);assert.match(purpose,/Web checkout/);
 assert.equal(investigationObjective(saved,'Check mobile eligibility.'),'Check mobile eligibility.');
 assert.ok(investigationObjective({question:'x'.repeat(5000)}).length<=2000);
 for(const blank of [undefined,'','  '])assert.equal(optionalAgentContext(blank,2000,'INVALID_AGENT_OBJECTIVE'),undefined);
 for(const invalid of [null,false,{},'x'.repeat(2001)])assert.throws(()=>optionalAgentContext(invalid,2000,'INVALID_AGENT_OBJECTIVE'),{code:'INVALID_AGENT_OBJECTIVE'});
 assert.match(CONTINUE_INVESTIGATION,/current saved evidence/);
});

test('built-in planner covers missing data, measurement, analysis and approved result reflection without user instructions',()=>{
 const make=(stage:Parameters<typeof investigationMission>[0])=>buildAgentPrompt({revision_id:'revision',stage,objective:investigationObjective({question:'Investigate checkout.'}),message:CONTINUE_INVESTIGATION,case_context:{},readiness:[],calculated_facts:{},prior_conversation:[],evidence:[]});
 for(const stage of ['setup','measure','explain','test','report','follow_up'] as const){
  const prompt=make(stage),system=prompt.messages[0]!.content;
  assert.ok(system.includes(investigationMission(stage)));assert.match(system,/User conversation is optional/);assert.match(system,/After an approved tool result/);assert.match(system,/explicit review/);
  assert.equal(JSON.parse(prompt.messages[1]!.content).prompt_version,AGENT_PROMPT_VERSION);
 }
 assert.match(make('setup').messages[0]!.content,/do not invent findings/);
 assert.match(make('measure').messages[0]!.content,/Do not infer business definitions/);
 assert.match(make('explain').messages[0]!.content,/cohort composition/);
 assert.match(make('test').messages[0]!.content,/failed, cancelled and stale/);
 for(const stage of ['report','follow_up'] as const)assert.match(make(stage).messages[0]!.content,/analysis.hypotheses to an empty array/);
 assert.match(make('report').messages[0]!.content,/no repeat drafting action/);
});

test('planning history uses only immutable bounded proposal kinds and observed outcomes',()=>{
 const rows=[{response:{actions:[{kind:'generate_hypotheses',secret:'never send'}]}},{message_kind:'tool',user_message:'Approved tool result: '+JSON.stringify({kind:'generate_hypotheses',status:'failed',secret:'never send'})},{message_kind:'tool',user_message:'Approved tool result: truncated'}];
 assert.deepEqual(investigationHistory(rows),[{kind:'generate_hypotheses',status:'previously_proposed'},{kind:'generate_hypotheses',status:'failed'}]);
 assert.equal(investigationHistory(Array.from({length:40},()=>rows[0]!)).length,20);
});

test('every tool reflection keeps current truth and exact tool result without repeating preceding model prose',()=>{
 for(const stage of ['setup','measure','explain','test','report','follow_up'] as const){
 const input={revision_id:'revision',stage,objective:'Investigate checkout.',message:'Approved tool result: saved draft',message_kind:'tool' as const,case_context:{question:'Investigate checkout.'},readiness:[{key:'report',status:'ready'}],calculated_facts:{causal_effect:'not_established'},prior_conversation:[{role:'agent',message:'Earlier draft discussion'}],action_history:[{kind:'draft_report',status:'succeeded'}],evidence:[]};
 const reflection=JSON.parse(buildAgentPrompt(input).messages[1]!.content);
 assert.deepEqual(reflection.prior_conversation,[]);assert.equal(reflection.conversation_scope,'saved_state_and_current_tool');
 assert.deepEqual(reflection.current_input,{kind:'tool',message:input.message});assert.deepEqual(reflection.action_history,input.action_history);
 if(['explain','report','follow_up'].includes(stage)){assert.equal(reflection.source_context_hash,hash({calculated_facts:input.calculated_facts,test_results:[],readiness:input.readiness}));assert.equal(reflection.deterministic_facts.causal_effect,'not_established');}else assert.deepEqual(reflection.deterministic_facts,input.calculated_facts);
 const user=JSON.parse(buildAgentPrompt({...input,message_kind:'user'}).messages[1]!.content);
 if(['report','follow_up'].includes(stage)){assert.deepEqual(user.prior_conversation,[]);assert.equal(user.conversation_scope,'saved_state_handoff');assert.equal(user.conversation_hash,hash(input.prior_conversation));const changed=buildAgentPrompt({...input,message_kind:'user',prior_conversation:[{role:'agent',message:'Changed saved discussion'}]});assert.notEqual(changed.input_hash,user.input_hash);const context=[{role:'user',message:'Only checkout data is in scope.'},{role:'user',message:input.objective},{role:'user',message:CONTINUE_INVESTIGATION},{role:'agent',message:'Prior model prose'}];assert.deepEqual(JSON.parse(buildAgentPrompt({...input,message_kind:'user',prior_conversation:context}).messages[1]!.content).prior_conversation,[context[0]]);}else assert.deepEqual(user.prior_conversation,input.prior_conversation);
 }
});
