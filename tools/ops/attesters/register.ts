// Attester keys use the same immutable scoped operator registry. This entry
// point accepts the reviewed public-key envelope; private signing keys are denied.
import {validateOperatorRegistration} from '../../../packages/core/src/targets/operator-profile.js';
import {regularBytes} from '../backup.js';
import {demand} from '../../../packages/core/src/errors.js';
const arg=process.argv[2];demand(process.argv.length===3&&arg?.startsWith('--attester-file='),'OPERATOR_INPUT_REQUIRED','Pass one reviewed --attester-file=<path>.');
const file=arg!.slice('--attester-file='.length),bytes=await regularBytes(file,131072),input=validateOperatorRegistration(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));demand(input.kind==='attester','INVALID_OPERATOR_PROFILE','This entry point registers scoped public attester keys only.');
process.argv[2]='--profile-file='+file;process.argv.push('--required-kind=attester');await import('../runner-profiles/register.js');
