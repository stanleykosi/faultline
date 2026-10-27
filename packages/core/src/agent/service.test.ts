import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DomainError} from '../errors.js';
import {agentSchema, agentWireSchema, agentOutputAllowance, agentActionDestination, approvedAgentAction, assertAgentExecutionBinding, assertAgentMutationRole, buildAgentPrompt, projectAgentStage, validateAgentResponse, modelDraftHumanReview, type AgentFacts} from './service.js';
import {Ajv2020} from 'ajv/dist/2020.js';
import {operationBody} from '../../../contracts/src/transport.js';
import {CONTINUE_INVESTIGATION, investigationObjective, optionalAgentContext, investigationHistory} from './mission.js';
import {hash} from '../canonical.js';
import {compactHandoffInputs} from './handoff-facts.js';
import {analyticCheckFacts, explanationStateFacts} from './status-facts.js';
import {assertAgentMemoryRecallPlanCurrent, investigationMemoryCatalogHash, type AgentMemoryRecallPlan} from './memory.js';
import {assertZetarisAgentCapturePlanCurrent, type ZetarisAgentCapturePlan} from '../integrations/service.js';

// service
test("planner wire enforces action arguments, prose and immutable response fields", () => {
 // planner wire hints reject observed number words in every shared prose location
 {
  const {$id,...schema}=agentWireSchema('explain'),validate=new Ajv2020({strict:true}).compile(schema);
    for(const prose of ['The two cohorts held steady.','Once reviewed, continue.','Review the affected one.','The FIRST explanation needs evidence.','Review three alternatives.']){
     const writes=[(r:any)=>r.message=prose,(r:any)=>r.analysis.current_belief=prose,(r:any)=>r.analysis.what_changed=prose,(r:any)=>r.analysis.unknowns=[prose],(r:any)=>r.questions=[prose],(r:any)=>r.limitations=[prose],(r:any)=>r.actions[0].title=prose,(r:any)=>r.actions[0].reason=prose];
     for(const write of writes){const value=response({actions:[{kind:'generate_hypotheses',title:'Review explanations',reason:'Inspect supported alternatives.',requires_approval:true,parameters:{}}]});write(value);assert.equal(validate(value),false,prose);}
    }
    const valid=response({actions:[{kind:'generate_hypotheses',title:'Review explanations',reason:'Inspect supported alternatives.',requires_approval:true,parameters:{}}]});
    assert.equal(validate(valid),true);
    const runtimeOnly={...valid,message:'A dozen cohorts changed.'};
    assert.throws(()=>validateAgentResponse(runtimeOnly,rid,inputHash,{[eid]:'hash'},'explain'),{code:'MODEL_NUMERIC_CLAIM_UNSUPPORTED'},'Compact hints do not replace the full runtime numeric policy.');
 }
 // report and follow-up wire contracts reject irrelevant parameters without dropping protected response fields
 {
  for(const stage of ['report','follow_up'] as const){
     const {$id,...schema}=agentWireSchema(stage),validate=new Ajv2020({strict:true}).compile(schema);
     const draft=response({stage,actions:[{kind:'draft_report',title:'Draft report',reason:'Review the supported findings.',requires_approval:true,parameters:{}}]});
     assert.equal(validate(draft),true);assert.doesNotThrow(()=>validateAgentResponse(draft,rid,inputHash,{[eid]:'hash'},stage));
     assert.equal(validate({...draft,actions:[{...draft.actions[0],parameters:{test_kind:'external_browser'}}]}),false);
     assert.equal(validate({...draft,input_hash:'wrong'}),false);
     assert.equal(validate({...draft,actions:[{...draft.actions[0],requires_approval:false}]}),false);
     assert.equal(validate({...draft,actions:[{...draft.actions[0],kind:'gather_related_evidence'}]}),false);
    }
    assert.notEqual(agentWireSchema('explain'),agentSchema);
 }
 // every planning wire action correlates its kind with bounded arguments
 {
  const {$id,...schema}=agentWireSchema('explain'),validate=new Ajv2020({strict:true}).compile(schema);
    const action=(kind:string,parameters:Record<string,string>)=>response({actions:[{kind,title:'Review saved work',reason:'Inspect the recorded evidence.',requires_approval:true,parameters}]});
    for(const kind of ['open_data','review_metric','generate_hypotheses','open_evidence','open_data_checks','open_browser_tests','draft_report','open_follow_up','review_results','schedule_follow_up']){
     assert.equal(validate(action(kind,{})),true,kind);
     assert.equal(validate(action(kind,{test_kind:'data_validation'})),false,kind+' rejects unrelated arguments');
     assert.equal(code(()=>validateAgentResponse(action(kind,{test_kind:'data_validation'}),rid,inputHash,{[eid]:'hash'},'explain')),'MODEL_ACTION_PARAMETERS');
    }
    for(const [kind,parameters]of [
     ['draft_test_plan',{test_kind:'data_validation'}],
     ['recall_prior_investigations',{query:'Checkout behavior'}],
     ['gather_related_evidence',{template_id:'release_exposure',release_id:'reviewed-release'}],
     ['gather_related_evidence',{template_id:'cohort_context',affected_cohort:'mobile',control_cohort:'desktop'}],
     ['gather_related_evidence',{template_id:'contrary_evidence',release_id:'reviewed-release',affected_cohort:'mobile',control_cohort:'desktop'}]
    ]as const){
     assert.equal(validate(action(kind,parameters)),true,kind);
     assert.doesNotThrow(()=>validateAgentResponse(action(kind,parameters),rid,inputHash,{[eid]:'hash'},'explain'));
     assert.equal(validate(action(kind,{})),false,kind+' requires its arguments');
    }
    assert.equal(validate(action('draft_test_plan',{query:'Checkout behavior'})),false);
    assert.equal(validate(action('gather_related_evidence',{template_id:'followup_recheck',release_id:'reviewed-release'})),false);
    assert.equal(validate(action('publish_report',{})),false,'Branch enums retain the finite action allowlist');
    assert.equal(validate(response({analysis:{...response().analysis,hypotheses:[{title:'Duplicate draft'}]}})),false,'Explain handoff leaves competing drafts to the dedicated tool');
    assert.equal(validate(response({message:'Conversion fell 20%.'})),false);
    assert.equal(code(()=>validateAgentResponse(response({message:'Conversion fell twenty percent.'}),rid,inputHash,{[eid]:'hash'},'explain')),'MODEL_NUMERIC_CLAIM_UNSUPPORTED');
    assert.equal(validate(response({stage:'test'})),false);
 }
});

const wid='11111111-1111-4111-8111-111111111111',cid='22222222-2222-4222-8222-222222222222',rid='33333333-3333-4333-8333-333333333333',eid='44444444-4444-4444-8444-444444444444',inputHash='a'.repeat(64);
const empty:AgentFacts={snapshot:false,metric:false,comparison:false,hypotheses:false,test_result:false,test_result_stale:false,report_draft:false,published_report:false,report_stale:false,follow_up:false,follow_up_pending:false,follow_up_stale:false};

test("saved artifacts drive stage projection and require human report review", () => {
 // actual successful bounded model drafts hand off to human review without a paid reflection
 {
  const job={id:cid,kind:'model_proposal',status:'succeeded',input:{kind:'hypotheses'},result:{proposal_id:eid,draft_only:true}};
    assert.equal(modelDraftHumanReview('generate_hypotheses',job),true);
    assert.equal(modelDraftHumanReview('draft_report',{...job,input:{kind:'diagnosis_draft'}}),true);
    for(const status of ['failed','cancelled','waiting_for_input','running'])assert.equal(modelDraftHumanReview('generate_hypotheses',{...job,status}),false);
    for(const result of [null,{}, {proposal_id:eid}, {proposal_id:eid,draft_only:false},{proposal_id:'not-a-proposal',draft_only:true}])assert.equal(modelDraftHumanReview('generate_hypotheses',{...job,result}),false);
    assert.equal(modelDraftHumanReview('draft_report',job),false);
    assert.equal(modelDraftHumanReview('generate_hypotheses',{...job,kind:'source_capture'}),false);
    assert.equal(modelDraftHumanReview('gather_related_evidence',job),false);
 }
 // fresh follow-up observations still require report review before the agent advances past reporting
 {
  const ready={...empty,snapshot:true,metric:true,comparison:true,follow_up:true,report_draft:true};
    assert.equal(projectAgentStage(ready).stage,'report');assert.equal(projectAgentStage(ready).readiness.find(r=>r.key==='follow_up')?.status,'complete');
    assert.equal(projectAgentStage({...ready,published_report:true}).stage,'follow_up');
 }
 // deterministic stage projection follows saved artifacts and keeps incomplete steps explicit
 {
  const setup=projectAgentStage(empty,wid,cid);assert.equal(setup.stage,'setup');assert.deepEqual(setup.readiness.map(item=>item.status),['ready','blocked','blocked','blocked','blocked','blocked']);assert.equal(setup.readiness[0]?.destination,`/w/${wid}/cases/${cid}/data`);
    const measured=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true},wid,cid);assert.equal(measured.stage,'explain');assert.deepEqual(measured.readiness.slice(0,3).map(item=>item.status),['complete','complete','ready']);
    const testing=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true},wid,cid);assert.equal(testing.stage,'test');assert.equal(testing.readiness[3]?.status,'ready');assert.equal(testing.readiness[4]?.status,'ready');
    const reporting=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,test_result:true},wid,cid);assert.equal(reporting.stage,'report');assert.equal(reporting.readiness[3]?.status,'complete');
    const following=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,test_result:true,report_draft:true,published_report:true},wid,cid);assert.equal(following.stage,'follow_up');assert.equal(following.readiness[5]?.status,'ready');
    const stale=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,test_result_stale:true,report_stale:true,follow_up_stale:true},wid,cid);assert.equal(stale.readiness[3]?.status,'stale');assert.equal(stale.readiness[4]?.status,'stale');assert.equal(stale.readiness[5]?.status,'stale');
    const waiting=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,follow_up_pending:true},wid,cid);assert.equal(waiting.readiness[5]?.status,'needs_input');
 }
});

test('structured turn allowance fits a full answer without exceeding remaining revision policy',()=>{
 assert.equal(agentOutputAllowance(8000,0,0),4000);
 assert.equal(agentOutputAllowance(8000,0,2000),4000);
 assert.equal(agentOutputAllowance(8000,1000,6000),1000);
 assert.equal(agentOutputAllowance(1200,100,200),900);
 assert.equal(agentOutputAllowance(8000,2000,7000),0);
 assert.equal(agentOutputAllowance(8000,0,8000),0);
 assert.equal(agentOutputAllowance(64000,0,8000),4000);
 assert.equal(agentOutputAllowance(64000,2000,61000),1000);
 assert.equal(agentOutputAllowance(64000,0,64000),0);
 assert.throws(()=>agentOutputAllowance(NaN,0,0),{code:'MODEL_BUDGET_EXHAUSTED'});
 assert.throws(()=>agentOutputAllowance(8000,0,-1),{code:'MODEL_BUDGET_EXHAUSTED'});
});
function code(fn:()=>unknown){try{fn();assert.fail('Expected a domain error.');}catch(error){assert.ok(error instanceof DomainError);return error.code;}}
function response(overrides:Record<string,unknown>={}){return {schema_version:2,revision_id:rid,input_hash:inputHash,stage:'explain',message:'The recorded comparison supports investigating several explanations.',evidence_ids:[eid],memory_capsule_ids:[],analysis:{current_belief:'The recorded association needs an independent mechanism test.',what_changed:'The comparison is now available.',hypotheses:[],unknowns:['The mechanism has not been reproduced.']},actions:[{kind:'open_evidence',title:'Review evidence',reason:'Check the saved sources and contrary records.',requires_approval:true,parameters:{}}],questions:[],limitations:['This draft does not establish aggregate causation.'],...overrides};}

test("planner prompts project sanitized evidence and independent check truth", () => {
 // agent prompt accepts only sanitized bounded evidence and strips operational artifact fields
 {
  const evidence={id:eid,snapshot_id:null,content_hash:'b'.repeat(64),event_time:{kind:'unknown',raw_description:'Not supplied'},source_kind:'human_note',text:'Reviewed customer wording.',redaction_status:'sanitized',artifact_refs:[{object_key:'private/original'}],private_detail:'must not cross'} as any;
    const prompt=buildAgentPrompt({revision_id:rid,stage:'explain',objective:'Find the regression.',message:'What should I check?',case_context:{question:'Why did conversion fall?'},readiness:[],calculated_facts:{comparison:{quality:'provisional'}},prior_conversation:[],evidence:[evidence]});
    const wire=prompt.messages.map(item=>item.content).join('\n');assert.match(wire,/Reviewed customer wording/);assert.doesNotMatch(wire,/private\/original|must not cross|artifact_refs|redaction_status/);assert.deepEqual(Object.keys(prompt.evidence_hashes),[eid]);
    assert.match(prompt.messages[0]!.content,/strictly number-free/);assert.match(prompt.messages[0]!.content,/empty citation arrays/);assert.match(prompt.messages[0]!.content,/empty parameters objects/);assert.match(prompt.messages[0]!.content,/Equal group rates mean no observed within-group decline/);assert.match(prompt.messages[1]!.content,/faultline-case-agent-v21/);assert.equal(Object.hasOwn(JSON.parse(prompt.messages[1]!.content),'schema'),false,'Provider structured-output wire carries the schema without a duplicate message copy.');
    const shape=JSON.parse(prompt.messages[0]!.content.split('Do not return an alternative object format: ')[1]!);assert.doesNotThrow(()=>validateAgentResponse(shape,rid,prompt.input_hash,prompt.evidence_hashes,'explain'));assert.equal(shape.actions[0].kind,'generate_hypotheses');
    assert.equal(code(()=>validateAgentResponse({...shape,revision_id:cid},rid,prompt.input_hash,prompt.evidence_hashes,'explain')),'MODEL_BINDING_MISMATCH');
    assert.equal(code(()=>buildAgentPrompt({revision_id:rid,stage:'explain',objective:'Find it.',message:'Continue.',case_context:{},readiness:[],calculated_facts:{},prior_conversation:[],evidence:[{...evidence,redaction_status:'restricted'}]})),'MODEL_EVIDENCE_RESTRICTED');
 }
 // planner binds saved explanation state separately from fresh failed, passed and unfinished check outcomes
 {
  const states=[{id:'explanation-saved',status:'proposed'}],checks=['passed','failed','blocked','cancelled','inconclusive','unknown','not_run'].map((outcome,index)=>({id:'check-'+index,hypothesis_id:'explanation-saved',kind:'analytic',test_type:'cohort_change',outcome,freshness:'fresh',result_hash:'b'.repeat(64)}));
    const input={revision_id:rid,stage:'report' as const,objective:'Investigate checkout.',message:'Continue.',case_context:{},readiness:[],calculated_facts:{},prior_conversation:[],evidence:[],hypothesis_states:states,test_results:checks},prompt=buildAgentPrompt(input),body=JSON.parse(prompt.messages[1]!.content),before=JSON.stringify(input);
    assert.deepEqual(body.explanation_states,[{id:'explanation-saved',state:'proposed'}]);assert.deepEqual(body.test_results,checks);
    assert.match(prompt.messages[0]!.content,/Checks never change saved explanation states/);assert.match(prompt.messages[0]!.content,/failed means prediction unsupported/);assert.match(prompt.messages[0]!.content,/Blocked\/cancelled\/inconclusive\/unknown\/not-run never pass/);assert.match(prompt.messages[0]!.content,/groups, explanations, earlier\/later period; agent, never AI/);
    assert.notEqual(buildAgentPrompt({...input,hypothesis_states:[{id:'explanation-saved',status:'accepted'}]}).input_hash,prompt.input_hash);
    assert.notEqual(buildAgentPrompt({...input,test_results:[{...checks[0],outcome:'failed'}]}).input_hash,prompt.input_hash);assert.equal(JSON.stringify(input),before);
    const invalid=response({stage:'report',message:'The hypothesis passed.',actions:[]}),original=JSON.stringify(invalid);
    assert.throws(()=>validateAgentResponse(invalid,rid,inputHash,{[eid]:'hash'},'report'),{code:'INVALID_MODEL_PROPOSAL'});assert.equal(JSON.stringify(invalid),original);
    const valid=response({stage:'report',message:'The check did not support the prediction; the explanation remains proposed.',actions:[]});assert.equal(validateAgentResponse(valid,rid,inputHash,{[eid]:'hash'},'report'),valid);
 }
});

test('agent response rejects unknown citations, actions and changed immutable bindings',()=>{
 assert.equal(validateAgentResponse(response(),rid,inputHash,{[eid]:'evidence-hash'},'explain').message,response().message);
 assert.equal(code(()=>validateAgentResponse(response({evidence_ids:['55555555-5555-4555-8555-555555555555']}),rid,inputHash,{[eid]:'evidence-hash'},'explain')),'MODEL_UNKNOWN_EVIDENCE');
 assert.equal(code(()=>validateAgentResponse(response({actions:[{kind:'publish_report',title:'Publish',reason:'Skip review.',requires_approval:false,parameters:{}}]}),rid,inputHash,{[eid]:'evidence-hash'},'explain')),'INVALID_INPUT');
 assert.equal(code(()=>validateAgentResponse(response({revision_id:'66666666-6666-4666-8666-666666666666'}),rid,inputHash,{[eid]:'evidence-hash'},'explain')),'MODEL_BINDING_MISMATCH');
 assert.equal(code(()=>validateAgentResponse(response({message:'Conversion fell 20%.'}),rid,inputHash,{[eid]:'evidence-hash'},'explain')),'MODEL_NUMERIC_CLAIM_UNSUPPORTED');
 assert.equal(code(()=>validateAgentResponse(response({actions:[{kind:'open_evidence',title:'Review evidence',reason:'Check the saved sources.',requires_approval:false,parameters:{}}]}),rid,inputHash,{[eid]:'evidence-hash'},'explain')),'INVALID_INPUT');
 assert.equal(code(()=>validateAgentResponse(response({actions:[{kind:'generate_hypotheses',title:'Draft explanations',reason:'Compare bounded explanations.',requires_approval:true,parameters:{proposal_kind:'hypotheses'}}]}),rid,inputHash,{[eid]:'evidence-hash'},'explain')),'INVALID_INPUT');
});

test("stale authority and viewers cannot mutate or publish agent work", () => {
 // stale revision and lost execution fence fail closed before model send or publication
 {
  const active={active_revision_id:rid,job_revision_id:rid,job_fence:'fence-one',current_fence:'fence-one',status:'running',lease_live:true,input_hash:inputHash,current_input_hash:inputHash};assert.doesNotThrow(()=>assertAgentExecutionBinding(active));
    assert.equal(code(()=>assertAgentExecutionBinding({...active,active_revision_id:'77777777-7777-4777-8777-777777777777'})),'STALE_INPUTS');
    assert.equal(code(()=>assertAgentExecutionBinding({...active,current_fence:'fence-two'})),'FENCED_ATTEMPT');
    assert.equal(code(()=>assertAgentExecutionBinding({...active,lease_live:false})),'FENCED_ATTEMPT');
 }
 // viewer cannot mutate agent sessions, turns or action reviews
 {
  assert.doesNotThrow(()=>assertAgentMutationRole('owner'));assert.doesNotThrow(()=>assertAgentMutationRole('analyst'));assert.equal(code(()=>assertAgentMutationRole('viewer')),'FORBIDDEN');
 }
});

test('action approval projects navigation only and cannot mark domain truth passed or published',()=>{
 const action={id:'88888888-8888-4888-8888-888888888888',kind:'open_browser_tests' as const,binding_hash:'c'.repeat(64),target_job_id:null},approved=approvedAgentAction(action,wid,cid);
 assert.deepEqual(approved,{id:action.id,status:'approved',destination:agentActionDestination(wid,cid,'open_browser_tests'),binding_hash:action.binding_hash,target_job_id:null,reflection_turn_id:null});
 for(const forbidden of ['result','verdict','claim','test_status','report_status','published','passed'])assert.equal(Object.hasOwn(approved,forbidden),false);
 assert.ok(approved.destination);assert.match(approved.destination,/investigation\?tab=verification$/);
});

// mission
test("optional conversation derives a bounded mission and reflects exact tool results", () => {
 // start and continue transport need no user prompt but retain explicit model and revision
 {
  for(const [op,field] of [['createAgentSession','objective'],['createAgentTurn','message']]){
     const ids={profile_id:'profile',revision_id:'revision'};
     assert.deepEqual(operationBody(op!,ids),ids);
     assert.doesNotThrow(()=>operationBody(op!,{...ids,[field!]:''}));
     assert.throws(()=>operationBody(op!,{...ids,[field!]:false}));
     assert.throws(()=>operationBody(op!,{revision_id:'revision'}));
    }
 }
 // server derives a bounded mission from the saved case and preserves optional business context
 {
  const saved={title:'Checkout investigation',question:'Why did completed checkout fall?',affected_flow:'Web checkout'};
    const purpose=investigationObjective(saved);
    assert.match(purpose,/Why did completed checkout fall/);assert.match(purpose,/Web checkout/);
    assert.equal(investigationObjective(saved,'Check mobile eligibility.'),'Check mobile eligibility.');
    assert.ok(investigationObjective({question:'x'.repeat(5000)}).length<=2000);
    for(const blank of [undefined,'','  '])assert.equal(optionalAgentContext(blank,2000,'INVALID_AGENT_OBJECTIVE'),undefined);
    for(const invalid of [null,false,{},'x'.repeat(2001)])assert.throws(()=>optionalAgentContext(invalid,2000,'INVALID_AGENT_OBJECTIVE'),{code:'INVALID_AGENT_OBJECTIVE'});
    assert.match(CONTINUE_INVESTIGATION,/current saved evidence/);
 }
 // planning history uses only immutable bounded proposal kinds and observed outcomes
 {
  const rows=[{response:{actions:[{kind:'generate_hypotheses',secret:'never send'}]}},{message_kind:'tool',user_message:'Approved tool result: '+JSON.stringify({kind:'generate_hypotheses',status:'failed',secret:'never send'})},{message_kind:'tool',user_message:'Approved tool result: truncated'}];
    assert.deepEqual(investigationHistory(rows),[{kind:'generate_hypotheses',status:'previously_proposed'},{kind:'generate_hypotheses',status:'failed'}]);
    assert.equal(investigationHistory(Array.from({length:40},()=>rows[0]!)).length,20);
 }
 // every tool reflection keeps current truth and exact tool result without repeating preceding model prose
 {
  for(const stage of ['setup','measure','explain','test','report','follow_up'] as const){
    const input={revision_id:'revision',stage,objective:'Investigate checkout.',message:'Approved tool result: saved draft',message_kind:'tool' as const,case_context:{question:'Investigate checkout.'},readiness:[{key:'report',status:'ready'}],calculated_facts:{causal_effect:'not_established'},prior_conversation:[{role:'agent',message:'Earlier draft discussion'}],action_history:[{kind:'draft_report',status:'succeeded'}],evidence:[]};
    const reflection=JSON.parse(buildAgentPrompt(input).messages[1]!.content);
    assert.deepEqual(reflection.prior_conversation,[]);assert.equal(reflection.conversation_scope,'saved_state_and_current_tool');
    assert.deepEqual(reflection.current_input,{kind:'tool',message:input.message});assert.deepEqual(reflection.action_history,input.action_history);
    if(['explain','report','follow_up'].includes(stage)){assert.equal(reflection.source_context_hash,hash({calculated_facts:input.calculated_facts,test_results:[],readiness:input.readiness}));assert.equal(reflection.deterministic_facts.causal_effect,'not_established');}else assert.deepEqual(reflection.deterministic_facts,input.calculated_facts);
    const user=JSON.parse(buildAgentPrompt({...input,message_kind:'user'}).messages[1]!.content);
    if(['report','follow_up'].includes(stage)){assert.deepEqual(user.prior_conversation,[]);assert.equal(user.conversation_scope,'saved_state_handoff');assert.equal(user.conversation_hash,hash(input.prior_conversation));const changed=buildAgentPrompt({...input,message_kind:'user',prior_conversation:[{role:'agent',message:'Changed saved discussion'}]});assert.notEqual(changed.input_hash,user.input_hash);const context=[{role:'user',message:'Only checkout data is in scope.'},{role:'user',message:input.objective},{role:'user',message:CONTINUE_INVESTIGATION},{role:'agent',message:'Prior model prose'}];assert.deepEqual(JSON.parse(buildAgentPrompt({...input,message_kind:'user',prior_conversation:context}).messages[1]!.content).prior_conversation,[context[0]]);}else assert.deepEqual(user.prior_conversation,input.prior_conversation);
    }
 }
});

// handoff facts
const comparison={value_hash:'comparison-binding',basis:'operator_attestation',quality:'complete_attested',window_rows:['baseline','comparison'],count_columns:['eligible','converted','rate'],counts:[[1000,340,0.34],[1000,160,0.16]],strata:{mobile:[[200,20,0.1],[800,80,0.1]],desktop:[[800,320,0.4],[200,80,0.4]]},causal_effect:'not_established'};
const limits={association:'deterministic projection only',mechanism:'requires independent test',correction:'requires independent test',aggregate_causal_effect:'not_established'};
const readiness=[{key:'data',status:'complete',label:'Connect data',destination:'/case/data'},{key:'test',status:'stale',label:'Test',destination:'/case/tests'},{key:'report',status:'needs_input',label:'Report',destination:'/case/reports'}];
const largeFacts=()=>({metric:{template:'session_conversion_v1',entry_event:'checkout_started',success_event:'checkout_completed',cohorts:['mobile','desktop'],windows:{baseline:{start:'2026-09-01',end:'2026-09-02'},comparison:{start:'2026-09-02',end:'2026-09-03'}}},comparison,claim_limits:limits,investigation_context:{revision_id:'revision',source_text_trust:'untrusted_data',causal_effect:'not_established',omitted:false,hypotheses:Array.from({length:3},(_,index)=>({id:'hypothesis-'+index,title:['Composition shift','Within cohort change','Concurrent release'][index],statement:'Saved explanation remains untrusted evidence-bound prose. '.repeat(12),falsifier:'Saved falsifier distinguishes competing explanations. '.repeat(8),status:'proposed',supporting_evidence_ids:['support-'+index],contradicting_evidence_ids:['contrary-'+index]})),analytic_results:[{id:'analytic',hypothesis_id:'hypothesis-0',kind:'mix_shift',outcome:'passed',freshness:'fresh',result_hash:'analytic-hash',plan_hash:'plan-hash',metric_hash:'metric-hash',snapshot_hash:'snapshot-hash',evidence_ids:['analysis-evidence'],causal_effect:'not_established'}],controlled_verification:[],followup:null}});

test("handoff compaction preserves all truth, citations and immutable input binding", t => {
 // planner handoff keeps comparison, claims and every hypothesis citation while removing duplicated narrative
 {
  const facts=largeFacts(),tests=[{id:'analytic',kind:'analytic',status:'passed',result_hash:'analytic-hash',plan_id:'execution-plan',statistics:{private_detail:'omitted execution detail'}}],before=structuredClone({facts,tests,readiness});
    const projected=compactHandoffInputs(facts,tests,readiness),out=projected.calculated_facts as any;
    assert.deepEqual(out.comparison,comparison);assert.deepEqual(out.claim_limits,limits);
    assert.deepEqual(out.metric,{template:'session_conversion_v1'});
    assert.equal(projected.source_hash,hash({calculated_facts:facts,test_results:tests,readiness}));
    assert.deepEqual(out.investigation_context.hypotheses,facts.investigation_context.hypotheses.map(({id,title,status,supporting_evidence_ids,contradicting_evidence_ids})=>({id,title,status,supporting_evidence_ids,contradicting_evidence_ids})));
    assert.deepEqual(projected.readiness,[{key:'data',status:'complete'},{key:'test',status:'stale'},{key:'report',status:'needs_input'}]);
    assert.deepEqual(projected.test_results,[{id:'analytic',kind:'analytic',status:'passed',result_hash:'analytic-hash'}]);
    assert.doesNotMatch(JSON.stringify(projected),/Saved explanation|Saved falsifier|execution-plan|omitted execution detail/);
    const originalBytes=Buffer.byteLength(JSON.stringify({calculated_facts:facts,test_results:tests,readiness})),compactBytes=Buffer.byteLength(JSON.stringify(projected));
    assert.ok(compactBytes<originalBytes*0.5,`Expected substantial fixed reduction, got ${originalBytes} -> ${compactBytes}`);
    assert.deepEqual({facts,tests,readiness},before,'Projection cannot alter saved truth or source inputs');
    t.diagnostic(`Authored planner handoff: ${originalBytes} -> ${compactBytes} bytes; no source item or citation omitted.`);
 }
 // failed, stale, unknown, null and not-run truths remain explicit without becoming successful claims
 {
  const results=[{id:'failed',kind:'controlled_verification',outcome:'failed',freshness:'stale',mode:'exploratory',association:'observed',mechanism:'not_reproduced',correction:'failed',production_claim_eligible:false,causal_effect:'not_established',aggregate_causal_effect:'not_established',attribution:{scope:'association_only',causal_effect:'not_established'},evidence_ids:['support','contrary'],plan_hash:'plan',result_hash:'result',oracle_hash:'oracle',binding_hash:'binding'}, {id:'unknown',kind:'analytic',status:'unknown',outcome:null,freshness:null,quality:'provisional',basis:null,evidence_hashes:{contrary:'content-hash'}}, {id:'pending',state:'waiting_for_data',freshness:'fresh',mode:'observational',outcome:'not_run',causal_effect:'not_established'}];
    const facts=largeFacts() as any;Object.assign(facts,{causal_effect:'not_established',aggregate_causal_effect:'not_established',status:'unknown',outcome:null,freshness:'stale',mode:'observational',quality:'provisional'});facts.investigation_context.analytic_results=[results[1]];facts.investigation_context.controlled_verification=[results[0]];facts.investigation_context.followup=results[2];
    const projected=compactHandoffInputs(facts,results,[{key:'test',status:null},{key:'follow_up',status:'unknown'}]),context=(projected.calculated_facts as any).investigation_context;
    assert.deepEqual(projected.test_results,[{id:'failed',kind:'controlled_verification',outcome:'failed',freshness:'stale',mode:'exploratory',association:'observed',mechanism:'not_reproduced',correction:'failed',production_claim_eligible:false,causal_effect:'not_established',aggregate_causal_effect:'not_established',attribution:{scope:'association_only',causal_effect:'not_established'},evidence_ids:['support','contrary'],result_hash:'result'},results[1],results[2]]);
    assert.deepEqual(context.controlled_verification[0],projected.test_results[0]);assert.deepEqual(context.analytic_results[0],projected.test_results[1]);assert.deepEqual(context.followup,projected.test_results[2]);
    const out=projected.calculated_facts as any;assert.equal(out.causal_effect,'not_established');assert.equal(out.aggregate_causal_effect,'not_established');assert.equal(out.status,'unknown');assert.equal(out.outcome,null);assert.equal(out.freshness,'stale');assert.equal(out.mode,'observational');assert.equal(out.quality,'provisional');
    assert.deepEqual(projected.readiness,[{key:'test',status:null},{key:'follow_up',status:'unknown'}]);
    assert.equal(compactHandoffInputs(null,[],null).calculated_facts,null);assert.equal(compactHandoffInputs(null,[],null).readiness,null);
    const absent=compactHandoffInputs({},[{}],[]);assert.equal(Object.hasOwn(absent.calculated_facts as object,'metric'),false);assert.equal(Object.hasOwn(absent.test_results[0] as object,'outcome'),false);
 }
 // every omitted source detail changes the whole input binding and output cannot mutate source inputs
 {
  const facts=largeFacts(),tests=[{id:'result',outcome:'inconclusive',plan_hash:'plan',metric_hash:'metric',snapshot_hash:'snapshot',oracle_hash:'oracle',binding_hash:'binding',statistics:{detail:'original'}}],input={calculated_facts:facts,test_results:tests,readiness},first=compactHandoffInputs(facts,tests,readiness),firstFacts=first.calculated_facts as any;
    const changes:((value:typeof input)=>void)[]=[value=>{value.calculated_facts.investigation_context.hypotheses[0]!.falsifier+=' Changed.';},value=>{value.test_results[0]!.statistics.detail='changed';},value=>{value.calculated_facts.metric.entry_event='different_entry';},value=>{value.readiness[0]!.destination+='?reviewed';},...(['plan_hash','metric_hash','snapshot_hash','oracle_hash','binding_hash'] as const).map(key=>(value:typeof input)=>{value.test_results[0]![key]='changed';})];
    for(const change of changes){const changed=structuredClone(input);change(changed);const second=compactHandoffInputs(changed.calculated_facts,changed.test_results,changed.readiness);assert.notEqual(first.source_hash,second.source_hash);assert.equal(second.source_hash,hash(changed));const {source_hash:_first,...firstVisible}=first,{source_hash:_second,...secondVisible}=second;assert.deepEqual(firstVisible,secondVisible,'Omitted metadata changes binding without entering the fixed planner summary');}
    firstFacts.comparison.counts[0][0]=1;firstFacts.claim_limits.mechanism='changed';firstFacts.investigation_context.hypotheses[0].contradicting_evidence_ids.push('injected');
    assert.equal(facts.comparison.counts[0]![0],1000);assert.equal(facts.claim_limits.mechanism,'requires independent test');assert.deepEqual(facts.investigation_context.hypotheses[0]!.contradicting_evidence_ids,['contrary-0']);
 }
});

// status facts
test('saved explanation state is independent of check outcomes and never promoted by a completed job',()=>{
 const explanation=Object.freeze({id:'explanation-current',status:'proposed'}),states=explanationStateFacts([explanation]);
 for(const outcome of ['passed','failed','blocked','inconclusive','cancelled','not_run','unknown']){
  const value=Object.freeze({hypothesis_id:explanation.id,kind:'cohort_change',outcome,result_hash:'a'.repeat(64)}),check=analyticCheckFacts({id:'check-current',plan_id:'plan-current',value});
  assert.equal(check.hypothesis_id,explanation.id);assert.equal(check.outcome,outcome);assert.equal(check.test_type,'cohort_change');assert.equal(check.freshness,'fresh');
  assert.deepEqual(states,[{id:explanation.id,state:'proposed'}]);assert.equal(explanation.status,'proposed');assert.equal(value.outcome,outcome);
 }
 const missing=analyticCheckFacts({id:'check-missing-outcome',value:{status:'succeeded'}});
 assert.equal(missing.outcome,'unknown');assert.equal(missing.test_type,null);assert.equal(missing.hypothesis_id,null);
 assert.deepEqual(explanationStateFacts([{id:'unreviewed',status:'passed'},{id:'missing'}]),[{id:'unreviewed',state:'unknown'},{id:'missing',state:'unknown'}]);
});

// tool plans
function stale(code:string,fn:()=>unknown){assert.throws(fn,error=>error instanceof DomainError&&error.code===code);}

const memory:AgentMemoryRecallPlan={schema_version:1,kind:'meterless_recall',revision_id:'33333333-3333-4333-8333-333333333333',query:'mobile checkout',query_hash:'a'.repeat(64),catalog_hash:'b'.repeat(64),max_results:5};
const zetaris:ZetarisAgentCapturePlan={schema_version:1,kind:'zetaris_federated_query',source_id:'11111111-1111-4111-8111-111111111111',source_name:'Checked source',source_revision:3,config_hash:'c'.repeat(64),probe_binding_hash:'d'.repeat(64),credential_version:2,approved_origin:'https://example.test',approved_account_scope:'read:workspace',request:{workspace_id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',revision_id:'33333333-3333-4333-8333-333333333333',metric_hash:'e'.repeat(64),comparison_hash:'f'.repeat(64),template_id:'release_exposure',view_ids:{sessions:'sessions-v1',releases:'releases-v1'},from:'2026-10-01T00:00:00.000Z',to:'2026-10-08T00:00:00.000Z',case_key:'case',flow_key:'checkout',release_id:'release-1'},request_hash:'1'.repeat(64)};

test("reviewed memory plans bind current catalog, query and feedback", () => {
 // reviewed Meterless recall fails closed when the query or catalog changes
 {
  assert.doesNotThrow(()=>assertAgentMemoryRecallPlanCurrent(memory,structuredClone(memory)));
    stale('STALE_AGENT_MEMORY',()=>assertAgentMemoryRecallPlanCurrent(memory,{...memory,catalog_hash:'9'.repeat(64)}));
    stale('STALE_AGENT_MEMORY',()=>assertAgentMemoryRecallPlanCurrent(memory,{...memory,query:'another case'}));
 }
 // Meterless catalog binding is order-invariant and changes with latest feedback
 {
  const capsule={capsule_id:'11111111-1111-4111-8111-111111111111',capsule_hash:'a'.repeat(64),authority:{current_revision_id:'r'}} as any,authority=[{capsule_id:capsule.capsule_id,evidence:[{id:'b'},{id:'a'}]}],feedback=[{capsule_id:capsule.capsule_id,id:'22222222-2222-4222-8222-222222222222',kind:'helpful',created_at:'2026-10-21T12:00:00.000Z'}];
    const first=investigationMemoryCatalogHash([capsule],authority,feedback),same=investigationMemoryCatalogHash([capsule],[...authority].reverse(),[...feedback].reverse()),changed=investigationMemoryCatalogHash([capsule],authority,[{...feedback[0],kind:'wrong'}]);
    assert.equal(first,same);assert.notEqual(first,changed);
 }
});

test('reviewed Zetaris execution fails closed when source, binding, filters, or caps change',()=>{
 assert.doesNotThrow(()=>assertZetarisAgentCapturePlanCurrent(zetaris,structuredClone(zetaris)));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,config_hash:'9'.repeat(64)}));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,source_id:'99999999-9999-4999-8999-999999999999'}));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,request:{...zetaris.request,release_id:'release-2'}}));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,request:{...zetaris.request,caps:{max_rows:500}}}));
});
