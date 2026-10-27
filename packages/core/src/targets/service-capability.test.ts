import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRunnerCapabilities} from './service.js';

const clock=Date.parse('2026-10-17T12:00:00.000Z');
const available=(checked_at:string)=>({schema_version:1,source_kind:'runner',status:'available',checked_at,adapter_version:'faultline-hardened-runner-v1',read_only:true,features:['ephemeral_vm_isolation','default_deny_guest_egress','external_browser_execution','cancellation_reconciliation'],unsupported_features:['independent_deployment_observation'],reason_code:null,provider_version:'example-cloud@2026-10'});

test('stored runner capability expires with the controller five-minute probe window',()=>{
 assert.equal(projectRunnerCapabilities(available(new Date(clock-299_999).toISOString()),clock).status,'available');
 const stale=projectRunnerCapabilities(available(new Date(clock-300_001).toISOString()),clock);
 assert.equal(stale.status,'unavailable');assert.equal(stale.reason_code,'RUNNER_CAPABILITY_STALE');assert.deepEqual(stale.features,[]);assert.ok(stale.unsupported_features.includes('external_browser_execution'));
});
