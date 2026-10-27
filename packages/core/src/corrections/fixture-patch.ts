import {byteHash} from '../canonical.js';
import {demand} from '../errors.js';
export const suppliedPatchPins=Object.freeze({incident:'e9feb82a796dd57a34c0d5494fd22e1f2c4c75acc18c21f1ea14d06ac7d2f9df',candidate:'1ddbde59937c00e7fabd6f7ecd191600a0b21bc820f934a4b8454210a1da0bf1',patch:'c215610e51d3b6bc076c2d7f1180aab01f011d8d837c5b82f0b519c3712a3ec7'});
export function suppliedPatchView(incident:Buffer,candidate:Buffer,patch:Buffer){
 demand(byteHash(incident)===suppliedPatchPins.incident&&byteHash(candidate)===suppliedPatchPins.candidate&&byteHash(patch)===suppliedPatchPins.patch,'FIXTURE_PATCH_CHANGED','Only the exact supplied fixture before/after/diff bytes can be reviewed.',409);
 return {scope:'supplied_fixture_only',production_claim_eligible:false,before:{path:'checkout/behavior.js',sha256:suppliedPatchPins.incident,bytes_utf8:incident.toString('utf8')},after:{path:'checkout/behavior.js',sha256:suppliedPatchPins.candidate,bytes_utf8:candidate.toString('utf8')},diff:{sha256:suppliedPatchPins.patch,bytes_utf8:patch.toString('utf8')}};
}
