import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelProfileRemovalReview, modelProviderBaseUrl, openRouterBaseUrl} from './ModelProfiles';

test('profile removal review binds exact identity/revision and warns about dependency and separate credential scope',()=>{
  const html = renderToStaticMarkup(<ModelProfileRemovalReview profile={{id:'profile-id',name:'<script>proposal</script>',provider:'ollama',base_url:'http://localhost:11434',model_name:'supplied-model',revision:7,profile_hash:'a'.repeat(64),credential:{secret_id:'secret-id',active_version:2,hint:'masked-only',revoked:false},capabilities:null,status:'unknown'}}/>);
  for (const value of ['profile-id','Resource revision','>7<','http://localhost:11434','supplied-model','cancellation requests','separately stored credential']) assert.ok(html.includes(value),value);
  assert.ok(html.includes('&lt;script&gt;')); assert.doesNotMatch(html,/<script>|secret-id/);
});

test('OpenRouter selection uses the exact standard API base without changing other saved provider URLs',()=>{
  assert.equal(modelProviderBaseUrl('openrouter', ''), openRouterBaseUrl);
  assert.equal(openRouterBaseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(modelProviderBaseUrl('openai_compatible', openRouterBaseUrl), '');
  assert.equal(modelProviderBaseUrl('ollama', 'http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
});
