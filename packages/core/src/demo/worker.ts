import fs from 'node:fs/promises';
import path from 'node:path';
import {byteHash} from '../canonical.js';
import {demand} from '../errors.js';
import {config} from '../config.js';
import {commitHandler,createImport,previewImport,saveMapping} from '../captures/service.js';
import {storeBounded} from '../storage/capacity.js';
import {objects} from '../storage/objects.js';
import {getDemoCaseBinding} from './service.js';
import {demoFixtureFiles,requireDemoCaseBinding,requireDemoSeedJob,requireTrustedDemoRuntime,type DemoFixture} from './domain.js';
import type {FaultlineCoverageDeclaration} from '../../../contracts/src/generated.js';

type DemoSeedJob={id:string;workspace_id:string;case_id:string;revision_id:string;fence:string;input:{actor_id:string;fixture:DemoFixture;fixture_version:number;generation:number}};

const coverage:FaultlineCoverageDeclaration={
 basis:'operator_attestation',
 statement:'Original deterministic synthetic data; complete by construction. This is not external-source evidence.',
 declared_event_watermark:'2026-09-03T00:30:00.000Z',
 event_time_intervals:[{start:'2026-09-01T00:00:00.000Z',end:'2026-09-03T00:30:00.000Z'}],
 reference_evidence_ids:[],
 late_arrival_hours:0
};

export async function demoSeedHandler(job:DemoSeedJob){
 requireTrustedDemoRuntime({production:config.production,runnerMode:config.runnerMode});
 requireDemoSeedJob({fixture:job.input?.fixture,actorId:job.input?.actor_id,caseId:job.case_id});
 const fixture=job.input.fixture,actorId=job.input.actor_id,workspaceId=job.workspace_id,caseId=job.case_id;
 const binding=await getDemoCaseBinding(workspaceId,actorId,caseId);
 requireDemoCaseBinding({fixture,storedFixture:binding.fixture,fixtureVersion:job.input.fixture_version,storedFixtureVersion:binding.fixture_version,generation:job.input.generation,storedGeneration:binding.generation});
 const metadata=demoFixtureFiles[fixture],file=path.resolve(process.cwd(),metadata.path);
 const bytes=await fs.readFile(file);
 demand(bytes.length>0&&bytes.length<=50*1024*1024&&byteHash(bytes)===metadata.sha256,'DEMO_FIXTURE_UNAVAILABLE','The supplied synthetic fixture failed its pinned size or digest check.',503);
 const raw=await storeBounded(workspaceId,actorId,caseId,bytes.length,()=>objects.put(workspaceId,bytes));
 const seedIdentity=`${workspaceId}:${caseId}:${job.input.generation}`;
 const importRecord=await createImport(workspaceId,actorId,`demo-import:${seedIdentity}`,caseId,{kind:'analytics',format:'csv',name:`Faultline local synthetic ${fixture} fixture`,raw_key:raw.key,raw_bytes:raw.size_bytes});
 const mapping=await saveMapping(workspaceId,actorId,`demo-mapping:${seedIdentity}`,caseId,importRecord.id,{kind:'analytics',schema_version:1,event_id_path:'event_id',session_id_path:'session_id',event_time_path:'occurred_at',event_name_path:'event_name',device_path:'device',excluded_path:'excluded',release_id_path:'release_id',device_map:[{source_value:'mobile',cohort:'mobile'},{source_value:'desktop',cohort:'desktop'}]},'1');
 const preview=await previewImport(workspaceId,actorId,`demo-preview:${seedIdentity}`,caseId,importRecord.id,mapping.id);
 demand(preview.stage==='review_ready'&&preview.can_finalize===true,'DEMO_FIXTURE_INVALID','The supplied synthetic fixture did not pass the normal import parser and preview.',422);
 return commitHandler({...job,input:{...job.input,import_id:importRecord.id,mapping_id:mapping.id,normalized_key:preview.hashes.normalized,coverage_declaration:coverage}});
}
