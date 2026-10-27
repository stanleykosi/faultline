import test from 'node:test';
import assert from 'node:assert/strict';
import {DomainError} from '../errors.js';
import {agentSchema,agentWireSchema,agentOutputAllowance,agentActionDestination,approvedAgentAction,assertAgentExecutionBinding,assertAgentMutationRole,buildAgentPrompt,projectAgentStage,validateAgentResponse,modelDraftHumanReview,type AgentFacts} from './service.js';
import {Ajv2020} from 'ajv/dist/2020.js';

test('planner wire hints reject observed number words in every shared prose location',()=>{
 const {$id,...schema}=agentWireSchema('explain'),validate=new Ajv2020({strict:true}).compile(schema);
 for(const prose of ['The two cohorts held steady.','Once reviewed, continue.','Review the affected one.','The FIRST explanation needs evidence.','Review three alternatives.']){
  const writes=[(r:any)=>r.message=prose,(r:any)=>r.analysis.current_belief=prose,(r:any)=>r.analysis.what_changed=prose,(r:any)=>r.analysis.unknowns=[prose],(r:any)=>r.questions=[prose],(r:any)=>r.limitations=[prose],(r:any)=>r.actions[0].title=prose,(r:any)=>r.actions[0].reason=prose];
  for(const write of writes){const value=response({actions:[{kind:'generate_hypotheses',title:'Review explanations',reason:'Inspect supported alternatives.',requires_approval:true,parameters:{}}]});write(value);assert.equal(validate(value),false,prose);}
 }
 const valid=response({actions:[{kind:'generate_hypotheses',title:'Review explanations',reason:'Inspect supported alternatives.',requires_approval:true,parameters:{}}]});
 assert.equal(validate(valid),true);
 const runtimeOnly={...valid,message:'A dozen cohorts changed.'};
 assert.throws(()=>validateAgentResponse(runtimeOnly,rid,inputHash,{[eid]:'hash'},'explain'),{code:'MODEL_NUMERIC_CLAIM_UNSUPPORTED'},'Compact hints do not replace the full runtime numeric policy.');
});

test('report and follow-up wire contracts reject irrelevant parameters without dropping protected response fields',()=>{
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
});

test('every planning wire action correlates its kind with bounded arguments',()=>{
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
});

const wid='11111111-1111-4111-8111-111111111111',cid='22222222-2222-4222-8222-222222222222',rid='33333333-3333-4333-8333-333333333333',eid='44444444-4444-4444-8444-444444444444',inputHash='a'.repeat(64);
const empty:AgentFacts={snapshot:false,metric:false,comparison:false,hypotheses:false,test_result:false,test_result_stale:false,report_draft:false,published_report:false,report_stale:false,follow_up:false,follow_up_pending:false,follow_up_stale:false};

test('actual successful bounded model drafts hand off to human review without a paid reflection',()=>{
 const job={id:cid,kind:'model_proposal',status:'succeeded',input:{kind:'hypotheses'},result:{proposal_id:eid,draft_only:true}};
 assert.equal(modelDraftHumanReview('generate_hypotheses',job),true);
 assert.equal(modelDraftHumanReview('draft_report',{...job,input:{kind:'diagnosis_draft'}}),true);
 for(const status of ['failed','cancelled','waiting_for_input','running'])assert.equal(modelDraftHumanReview('generate_hypotheses',{...job,status}),false);
 for(const result of [null,{}, {proposal_id:eid}, {proposal_id:eid,draft_only:false},{proposal_id:'not-a-proposal',draft_only:true}])assert.equal(modelDraftHumanReview('generate_hypotheses',{...job,result}),false);
 assert.equal(modelDraftHumanReview('draft_report',job),false);
 assert.equal(modelDraftHumanReview('generate_hypotheses',{...job,kind:'source_capture'}),false);
 assert.equal(modelDraftHumanReview('gather_related_evidence',job),false);
});

test('fresh follow-up observations still require report review before the agent advances past reporting',()=>{
 const ready={...empty,snapshot:true,metric:true,comparison:true,follow_up:true,report_draft:true};
 assert.equal(projectAgentStage(ready).stage,'report');assert.equal(projectAgentStage(ready).readiness.find(r=>r.key==='follow_up')?.status,'complete');
 assert.equal(projectAgentStage({...ready,published_report:true}).stage,'follow_up');
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

test('deterministic stage projection follows saved artifacts and keeps incomplete steps explicit',()=>{
 const setup=projectAgentStage(empty,wid,cid);assert.equal(setup.stage,'setup');assert.deepEqual(setup.readiness.map(item=>item.status),['ready','blocked','blocked','blocked','blocked','blocked']);assert.equal(setup.readiness[0]?.destination,`/w/${wid}/cases/${cid}/data`);
 const measured=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true},wid,cid);assert.equal(measured.stage,'explain');assert.deepEqual(measured.readiness.slice(0,3).map(item=>item.status),['complete','complete','ready']);
 const testing=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true},wid,cid);assert.equal(testing.stage,'test');assert.equal(testing.readiness[3]?.status,'ready');assert.equal(testing.readiness[4]?.status,'ready');
 const reporting=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,test_result:true},wid,cid);assert.equal(reporting.stage,'report');assert.equal(reporting.readiness[3]?.status,'complete');
 const following=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,test_result:true,report_draft:true,published_report:true},wid,cid);assert.equal(following.stage,'follow_up');assert.equal(following.readiness[5]?.status,'ready');
 const stale=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,test_result_stale:true,report_stale:true,follow_up_stale:true},wid,cid);assert.equal(stale.readiness[3]?.status,'stale');assert.equal(stale.readiness[4]?.status,'stale');assert.equal(stale.readiness[5]?.status,'stale');
 const waiting=projectAgentStage({...empty,snapshot:true,metric:true,comparison:true,hypotheses:true,follow_up_pending:true},wid,cid);assert.equal(waiting.readiness[5]?.status,'needs_input');
});

test('agent prompt accepts only sanitized bounded evidence and strips operational artifact fields',()=>{
 const evidence={id:eid,snapshot_id:null,content_hash:'b'.repeat(64),event_time:{kind:'unknown',raw_description:'Not supplied'},source_kind:'human_note',text:'Reviewed customer wording.',redaction_status:'sanitized',artifact_refs:[{object_key:'private/original'}],private_detail:'must not cross'} as any;
 const prompt=buildAgentPrompt({revision_id:rid,stage:'explain',objective:'Find the regression.',message:'What should I check?',case_context:{question:'Why did conversion fall?'},readiness:[],calculated_facts:{comparison:{quality:'provisional'}},prior_conversation:[],evidence:[evidence]});
 const wire=prompt.messages.map(item=>item.content).join('\n');assert.match(wire,/Reviewed customer wording/);assert.doesNotMatch(wire,/private\/original|must not cross|artifact_refs|redaction_status/);assert.deepEqual(Object.keys(prompt.evidence_hashes),[eid]);
 assert.match(prompt.messages[0]!.content,/strictly number-free/);assert.match(prompt.messages[0]!.content,/empty citation arrays/);assert.match(prompt.messages[0]!.content,/empty parameters objects/);assert.match(prompt.messages[0]!.content,/Equal group rates mean no observed within-group decline/);assert.match(prompt.messages[1]!.content,/faultline-case-agent-v21/);assert.equal(Object.hasOwn(JSON.parse(prompt.messages[1]!.content),'schema'),false,'Provider structured-output wire carries the schema without a duplicate message copy.');
 const shape=JSON.parse(prompt.messages[0]!.content.split('Do not return an alternative object format: ')[1]!);assert.doesNotThrow(()=>validateAgentResponse(shape,rid,prompt.input_hash,prompt.evidence_hashes,'explain'));assert.equal(shape.actions[0].kind,'generate_hypotheses');
 assert.equal(code(()=>validateAgentResponse({...shape,revision_id:cid},rid,prompt.input_hash,prompt.evidence_hashes,'explain')),'MODEL_BINDING_MISMATCH');
 assert.equal(code(()=>buildAgentPrompt({revision_id:rid,stage:'explain',objective:'Find it.',message:'Continue.',case_context:{},readiness:[],calculated_facts:{},prior_conversation:[],evidence:[{...evidence,redaction_status:'restricted'}]})),'MODEL_EVIDENCE_RESTRICTED');
});

test('planner binds saved explanation state separately from fresh failed, passed and unfinished check outcomes',()=>{
 const states=[{id:'explanation-saved',status:'proposed'}],checks=['passed','failed','blocked','cancelled','inconclusive','unknown','not_run'].map((outcome,index)=>({id:'check-'+index,hypothesis_id:'explanation-saved',kind:'analytic',test_type:'cohort_change',outcome,freshness:'fresh',result_hash:'b'.repeat(64)}));
 const input={revision_id:rid,stage:'report' as const,objective:'Investigate checkout.',message:'Continue.',case_context:{},readiness:[],calculated_facts:{},prior_conversation:[],evidence:[],hypothesis_states:states,test_results:checks},prompt=buildAgentPrompt(input),body=JSON.parse(prompt.messages[1]!.content),before=JSON.stringify(input);
 assert.deepEqual(body.explanation_states,[{id:'explanation-saved',state:'proposed'}]);assert.deepEqual(body.test_results,checks);
 assert.match(prompt.messages[0]!.content,/Checks never change saved explanation states/);assert.match(prompt.messages[0]!.content,/failed means prediction unsupported/);assert.match(prompt.messages[0]!.content,/Blocked\/cancelled\/inconclusive\/unknown\/not-run never pass/);assert.match(prompt.messages[0]!.content,/groups, explanations, earlier\/later period; agent, never AI/);
 assert.notEqual(buildAgentPrompt({...input,hypothesis_states:[{id:'explanation-saved',status:'accepted'}]}).input_hash,prompt.input_hash);
 assert.notEqual(buildAgentPrompt({...input,test_results:[{...checks[0],outcome:'failed'}]}).input_hash,prompt.input_hash);assert.equal(JSON.stringify(input),before);
 const invalid=response({stage:'report',message:'The hypothesis passed.',actions:[]}),original=JSON.stringify(invalid);
 assert.throws(()=>validateAgentResponse(invalid,rid,inputHash,{[eid]:'hash'},'report'),{code:'INVALID_MODEL_PROPOSAL'});assert.equal(JSON.stringify(invalid),original);
 const valid=response({stage:'report',message:'The check did not support the prediction; the explanation remains proposed.',actions:[]});assert.equal(validateAgentResponse(valid,rid,inputHash,{[eid]:'hash'},'report'),valid);
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

test('stale revision and lost execution fence fail closed before model send or publication',()=>{
 const active={active_revision_id:rid,job_revision_id:rid,job_fence:'fence-one',current_fence:'fence-one',status:'running',lease_live:true,input_hash:inputHash,current_input_hash:inputHash};assert.doesNotThrow(()=>assertAgentExecutionBinding(active));
 assert.equal(code(()=>assertAgentExecutionBinding({...active,active_revision_id:'77777777-7777-4777-8777-777777777777'})),'STALE_INPUTS');
 assert.equal(code(()=>assertAgentExecutionBinding({...active,current_fence:'fence-two'})),'FENCED_ATTEMPT');
 assert.equal(code(()=>assertAgentExecutionBinding({...active,lease_live:false})),'FENCED_ATTEMPT');
});

test('viewer cannot mutate agent sessions, turns or action reviews',()=>{
 assert.doesNotThrow(()=>assertAgentMutationRole('owner'));assert.doesNotThrow(()=>assertAgentMutationRole('analyst'));assert.equal(code(()=>assertAgentMutationRole('viewer')),'FORBIDDEN');
});

test('action approval projects navigation only and cannot mark domain truth passed or published',()=>{
 const action={id:'88888888-8888-4888-8888-888888888888',kind:'open_browser_tests' as const,binding_hash:'c'.repeat(64),target_job_id:null},approved=approvedAgentAction(action,wid,cid);
 assert.deepEqual(approved,{id:action.id,status:'approved',destination:agentActionDestination(wid,cid,'open_browser_tests'),binding_hash:action.binding_hash,target_job_id:null,reflection_turn_id:null});
 for(const forbidden of ['result','verdict','claim','test_status','report_status','published','passed'])assert.equal(Object.hasOwn(approved,forbidden),false);
 assert.ok(approved.destination);assert.match(approved.destination,/investigation\?tab=verification$/);
});

