import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {RedactionPanel,reviewedRedaction} from './RedactionPanel';

const preview={preview_id:'8cc14e71-370a-4eb3-97da-9d415166e43f',preview_hash:'a'.repeat(64),revision_id:'777acb4d-df00-4844-813c-9c33088514c1',review_status:'preview_only',binding:{policy_version:'contact-secrets-v1'},rows:[{id:'bf984f4a-9eaf-4439-8032-d60f45fc2d12',redaction:{text:'[REDACTED_SECRET]',output_hash:'b'.repeat(64),counts:{emails:0,secrets:1,phones:0},limitations:['Only the approved finite policy was applied.']}}],limitations:['Unknown private text can remain.']};
test('an exact completed supported preview requires explicit human approval and a bounded reason',()=>{
 assert.deepEqual(reviewedRedaction(preview,true,'  Reviewed excerpt  '),{preview_id:preview.preview_id,reason:'Reviewed excerpt'});
 assert.throws(()=>reviewedRedaction(preview,false,'Reviewed excerpt'),/Review every/);
 assert.throws(()=>reviewedRedaction(preview,true,' '),/Review every/);
 assert.throws(()=>reviewedRedaction(preview,true,'x'.repeat(2001)),/Review every/);
});
test('unknown, empty, unsupported or unbound preview results cannot be approved',()=>{
 for(const value of [null,{...preview,review_status:'queued'},{...preview,preview_hash:'unknown'},{...preview,preview_id:'untrusted'},{...preview,rows:[]},{...preview,binding:{policy_version:'model-proposed-policy'}}])assert.throws(()=>reviewedRedaction(value,true,'Reviewed excerpt'),/complete supported/);
});
test('viewer has no redaction controls; analyst sees finite policy limits without changing owner approval',()=>{
 const common={base:'/api/v1/workspaces/unit-workspace/cases/unit-case',csrf:'unit-csrf',evidence:[],onChanged:async()=>{}};
 assert.equal(renderToStaticMarkup(<RedactionPanel {...common} canMutate={false}/>),'');
 const html=renderToStaticMarkup(<RedactionPanel {...common} canMutate/>);
 assert.match(html,/contact-secrets-v1/);assert.match(html,/Other private text can remain/);assert.match(html,/Original files and attachments stay separate/);assert.match(html,/disabled="">Preview redaction/);
 assert.doesNotMatch(html,/Apply reviewed redaction|Save reviewed policy|sanitized citations/);
});
