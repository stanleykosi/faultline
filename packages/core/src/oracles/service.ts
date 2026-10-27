import {transaction} from '../../../database/src/client.js';
import {access} from '../workspaces/service.js';
import {protectedFixtureOracle} from '../verification/fixture.js';
import {demand} from '../errors.js';
export async function listOraclePolicies(wid:string,pid:string){return transaction(wid,async tx=>{await access(tx,wid,pid);return [protectedFixtureOracle('mechanism'),protectedFixtureOracle('correction')];});}
export async function getOraclePolicy(wid:string,pid:string,id:string){const policies=await listOraclePolicies(wid,pid),policy=policies.find(value=>value.version===id);demand(policy,'NOT_FOUND','Protected oracle policy unavailable.',404);return policy;}
