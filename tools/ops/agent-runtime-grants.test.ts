import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {agentRuntimeGrants} from './agent-runtime-grants.js';

test('finalized agent column grants match the independently declared migration permissions',()=>{
 const migrations=['0031-case-agent.sql','0033-agent-tools-memory.sql','0035-agent-runtime-grants.sql'].map(name=>fs.readFileSync('packages/database/migrations/'+name,'utf8')).join('\n');
 const grants=(sql:string)=>{const result=new Map<string,Set<string>>();for(const match of sql.matchAll(/GRANT UPDATE\(([^)]+)\)\s+ON faultline\.(agent_sessions|agent_turns|agent_actions|memory_capsules) TO faultline_api/gi)){const columns=result.get(match[2]!)??new Set<string>();for(const column of match[1]!.split(','))columns.add(column.trim());result.set(match[2]!,columns);}return Object.fromEntries([...result].sort().map(([table,columns])=>[table,[...columns].sort()]));};
 assert.deepEqual(grants(agentRuntimeGrants),grants(migrations));
 assert.doesNotMatch(agentRuntimeGrants,/\bDELETE\b|\bBYPASSRLS\b|GRANT UPDATE ON|GRANT ALL/i);
 const roles=fs.readFileSync('tools/ops/roles.ts','utf8');assert.ok(roles.indexOf('await admin.query(agentRuntimeGrants)')>roles.indexOf('REVOKE ALL ON ALL TABLES'));
});
