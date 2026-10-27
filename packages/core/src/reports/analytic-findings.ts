import type {FaultlineReport} from '../../../contracts/src/generated.js';
import type {AnalyticResult} from '../investigation/analytic.js';
import {demand} from '../errors.js';
import {hash} from '../canonical.js';

type Finding=FaultlineReport['findings'][number];
type ReportCheck={id:string;value:Pick<AnalyticResult,'kind'|'outcome'|'result_hash'|'reasons'|'evidence_hashes'>;title:string;fresh:boolean;evidence:{id:string;content_hash:string;redaction_status:string}[]};
const names:Record<string,string>={data_quality:'Data quality check',cohort_change:'Group conversion check',mix_shift:'Traffic mix check',temporal_alignment:'Release timing check',negative_control:'Unaffected group check'};
const outcomes:Record<string,string>={passed:'Supported the prediction.',failed:'Did not support the prediction.',blocked:'Could not run.',inconclusive:'No conclusion.'};
const reasons:Record<string,string>={
 frozen_input_binding_changed:'The saved data or measurement changed.',
 evidence_reference_unavailable_or_withdrawn:'A required record is unavailable.',
 conflicting_identity_or_unknown_cohort:'Some records conflict or have no known group.',
 multiple_sources_require_explicit_metric_source:'Choose which data source to measure.',
 incomplete_or_provisional_event_population:'The available data is incomplete or still waiting for events.',
 cohort_denominator_below_declared_minimum:'There are too few sessions in a selected group.',
 no_predeclared_direction:'Choose the expected change before running the check.',
 observed_cohort_direction_contradicts_prediction:'The selected groups did not change in the predicted direction.',
 standardization_has_missing_or_sparse_strata:'A required group is missing or has too few sessions.',
 composition_alone_does_not_match_declared_aggregate_pattern:'The change in group sizes does not fully match the overall change.',
 frozen_metric_windows_required_for_temporal_alignment:'Save the measurement periods before checking release timing.',
 precise_release_occurrence_time_unavailable:'The release time is not known precisely enough.',
 denominator_or_predeclared_direction_unavailable:'The check needs enough sessions and an expected change.',
 reported_release_time_does_not_match_declared_boundary_pattern:'The release time does not match the expected change.'
};

/** Projection of saved, independently checked results, never model-authored verdicts. */
export function analyticReportFindings(rows:ReportCheck[]){
 const findings:Finding[]=[],resultHashes:Record<string,string>={},evidenceHashes:Record<string,string>={},required:{id:string;finding_hash:string}[]=[];
 let stale=false;
 for(const row of rows){
  if(!row.fresh){stale=true;continue;}
  demand(Object.hasOwn(names,row.value.kind)&&Object.hasOwn(outcomes,row.value.outcome),'INVALID_CHECK_RESULT','A saved check has an unsupported result. Review it before creating a report.',409);
  const ids=Object.keys(row.value.evidence_hashes);
  demand(ids.length>0&&ids.length<=30&&row.evidence.length===ids.length&&row.evidence.every(e=>ids.includes(e.id)&&e.redaction_status==='sanitized'),'CITATION_RESTRICTED','A check refers to records that cannot be included. Review its records before creating a report.',409);
  const detail=[...new Set(row.value.reasons.map(r=>reasons[r]??'Review the saved check details before drawing a conclusion.'))].join(' ');
  const finding:Finding={text:`${names[row.value.kind]} for “${row.title.slice(0,240)}”: ${outcomes[row.value.outcome]}${detail?' '+detail:''} This checks the selected data only. It does not change the saved explanation or prove the cause.`,evidence_ids:ids as [string,...string[]],test_result_ids:[row.id]};
  findings.push(finding);resultHashes[row.id]=row.value.result_hash;required.push({id:row.id,finding_hash:hash(finding)});
  for(const e of row.evidence)evidenceHashes[e.id]=e.content_hash;
 }
 return {findings,resultHashes,evidenceHashes,required,limitations:stale?['Some earlier check results are out of date. Run those checks again before using them.']:[]};
}

export function requireAnalyticFindings(findings:readonly {text:string;evidence_ids:readonly string[];test_result_ids:readonly string[]}[],required:{id:string;finding_hash:string}[]){
 demand(required.every(r=>findings.some(f=>f.test_result_ids.includes(r.id)&&hash(f)===r.finding_hash)),'CHECK_RESULTS_REQUIRED','Saved check results cannot be removed or changed. Edit the report comments instead.',422);
}
