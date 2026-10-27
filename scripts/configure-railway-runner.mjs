import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const required=name=>{const value=process.env[name];if(!value)throw new Error('Missing operator configuration: '+name);return value;};
const projectId=required('FAULTLINE_RAILWAY_PROJECT_ID');
const environmentId=required('FAULTLINE_RAILWAY_ENVIRONMENT_ID');
const runnerServiceId=required('FAULTLINE_RAILWAY_RUNNER_SERVICE_ID');
const appServiceId=required('FAULTLINE_RAILWAY_APP_SERVICE_ID');
const tokenName='faultline-runner-staging-v1';
const endpoint=required('EXTERNAL_RUNNER_URL');
const withoutProjectToken=process.argv.includes('--without-project-token');
const railwayScript=process.platform==='win32'
 ? path.join(process.env.APPDATA??'', 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.js')
 : null;

const stableRunnerVariables={
 ALLOW_FIXTURE_ADAPTERS:'false',
 NODE_BASE_IMAGE:'docker.io/library/node@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7',
 RUNNER_PROBE_ORIGIN:required('RUNNER_PROBE_ORIGIN'),
 RUNNER_SANDBOX_CHECKPOINT:'faultline-browser-pw1561-chrome155-8fbd2ae69cdf',
 RUNNER_MODE:'external',
 RUNNER_PRIVATE_PROBE_HOST:required('RUNNER_PRIVATE_PROBE_HOST'),
 EXTERNAL_RUNNER_URL:endpoint,
};

function call(args){
 const result=railwayScript
  ? spawnSync(process.execPath,[railwayScript,...args],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024})
  : spawnSync('railway',args,{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
 if(result.error||result.status!==0)throw new Error('RAILWAY_COMMAND_FAILED');
 return result.stdout;
}
function api(document,variables){
 const output=call(['api',document,'--variables',JSON.stringify(variables),'--compact','--allow-errors']);
 let parsed;try{parsed=JSON.parse(output);}catch{throw new Error('RAILWAY_RESPONSE_INVALID');}
 if(parsed.errors?.length)throw new Error('RAILWAY_GRAPHQL_FAILED:'+String(parsed.errors[0]?.message??'unknown').slice(0,200));
 return parsed.data;
}

const listDocument='query($projectId:String!){projectTokens(projectId:$projectId,first:100){edges{node{id name environmentId}}}}';
const before=api(listDocument,{projectId}).projectTokens.edges.map(edge=>edge.node);
if(!withoutProjectToken&&before.some(token=>token.name===tokenName))throw new Error('RUNNER_TOKEN_ALREADY_EXISTS');

let tokenId=null;
let installed=false;
try{
 let rawToken=null;
 if(!withoutProjectToken){
  rawToken=api('mutation($input:ProjectTokenCreateInput!){projectTokenCreate(input:$input)}',{input:{projectId,environmentId,name:tokenName}}).projectTokenCreate;
  if(typeof rawToken!=='string'||rawToken.length<20)throw new Error('RUNNER_TOKEN_INVALID');
  const after=api(listDocument,{projectId}).projectTokens.edges.map(edge=>edge.node);
  const created=after.filter(token=>token.name===tokenName&&token.environmentId===environmentId);
  if(created.length!==1)throw new Error('RUNNER_TOKEN_METADATA_INVALID');
  tokenId=created[0].id;
 }
 const hmac=randomBytes(32).toString('base64');
 const runnerVariables={...stableRunnerVariables,...(rawToken?{RAILWAY_TOKEN:rawToken}:{}),EXTERNAL_RUNNER_AUTH_KEY_B64:hmac};
 const upsert='mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}';
 const runnerApplied=api(upsert,{input:{projectId,environmentId,serviceId:runnerServiceId,replace:true,skipDeploys:true,variables:runnerVariables}}).variableCollectionUpsert;
 if(runnerApplied!==true)throw new Error('RUNNER_VARIABLE_REPLACEMENT_FAILED');
 const appApplied=api(upsert,{input:{projectId,environmentId,serviceId:appServiceId,replace:false,skipDeploys:true,variables:{RUNNER_MODE:'external',EXTERNAL_RUNNER_URL:endpoint,EXTERNAL_RUNNER_AUTH_KEY_B64:hmac}}}).variableCollectionUpsert;
 if(appApplied!==true)throw new Error('APP_RUNNER_VARIABLE_UPDATE_FAILED');
 installed=true;
 console.log(JSON.stringify({status:withoutProjectToken?'runner_hmac_installed_project_token_blocked':'runner_credentials_installed',runnerServiceId,appServiceId,tokenId,runnerVariableNames:Object.keys(runnerVariables).sort(),appVariableNames:['EXTERNAL_RUNNER_AUTH_KEY_B64','EXTERNAL_RUNNER_URL','RUNNER_MODE']}));
}finally{
 if(!installed){
  try{
   const upsert='mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}';
   api(upsert,{input:{projectId,environmentId,serviceId:runnerServiceId,replace:true,skipDeploys:true,variables:stableRunnerVariables}});
   if(tokenId)api('mutation($id:String!){projectTokenDelete(id:$id)}',{id:tokenId});
  }catch{}
 }
}
