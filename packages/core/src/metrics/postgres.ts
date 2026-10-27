import type {Tx} from '../../../database/src/client.js';
import {demand,DomainError} from '../errors.js';
import {validateMetric,summarizeRate,computeCountedComparison,type WindowSummary} from './comparison.js';
/** Fixed session_conversion_v1 SQL: one scoped scan; per-session successes inspected at most twice. */
export async function computePostgresComparison(tx:Tx,wid:string,cid:string,snapshotId:string,metricValue:unknown,coverage:unknown){
 const metric=validateMetric(metricValue);
 await tx.query("SELECT set_config('statement_timeout','5000',true)");
 let rows;
 try{rows=(await tx.query(`WITH sessions AS (
 SELECT e.session_id,
 min(e.occurred_at) FILTER(WHERE e.event_name=$9 AND e.occurred_at>=$5::timestamptz AND e.occurred_at<$6::timestamptz) AS baseline_entry,
 min(e.occurred_at) FILTER(WHERE e.event_name=$9 AND e.occurred_at>=$7::timestamptz AND e.occurred_at<$8::timestamptz) AS comparison_entry,
 (array_agg(e.device ORDER BY e.occurred_at,e.event_id COLLATE "C") FILTER(WHERE e.event_name=$9 AND e.occurred_at>=$5::timestamptz AND e.occurred_at<$6::timestamptz))[1] AS baseline_device,
 (array_agg(e.device ORDER BY e.occurred_at,e.event_id COLLATE "C") FILTER(WHERE e.event_name=$9 AND e.occurred_at>=$7::timestamptz AND e.occurred_at<$8::timestamptz))[1] AS comparison_device,
 (array_agg(e.excluded ORDER BY e.occurred_at,e.event_id COLLATE "C") FILTER(WHERE e.event_name=$9 AND e.occurred_at>=$5::timestamptz AND e.occurred_at<$6::timestamptz))[1] AS baseline_excluded,
 (array_agg(e.excluded ORDER BY e.occurred_at,e.event_id COLLATE "C") FILTER(WHERE e.event_name=$9 AND e.occurred_at>=$7::timestamptz AND e.occurred_at<$8::timestamptz))[1] AS comparison_excluded,
 array_agg(e.occurred_at) FILTER(WHERE e.event_name=$10) AS successes
 FROM faultline.canonical_events e
 WHERE e.workspace_id=$1 AND e.case_id=$2 AND e.snapshot_id=$3 AND e.source_id=$4::uuid
 AND e.event_name IN($9,$10)
 GROUP BY e.session_id)
 SELECT w.side,w.device,count(*) FILTER(WHERE NOT w.excluded)::text AS eligible,
 count(*) FILTER(WHERE NOT w.excluded AND EXISTS(SELECT 1 FROM unnest(s.successes) AS success(at)
 WHERE success.at>=w.entry_at AND success.at<=w.entry_at+interval '30 minutes'))::text AS converted
 FROM sessions s CROSS JOIN LATERAL (VALUES
 ('baseline'::text,s.baseline_entry,s.baseline_device,s.baseline_excluded),
 ('comparison'::text,s.comparison_entry,s.comparison_device,s.comparison_excluded)) AS w(side,entry_at,device,excluded)
 WHERE w.entry_at IS NOT NULL GROUP BY w.side,w.device`,[wid,cid,snapshotId,metric.source_id,metric.windows.baseline.start,metric.windows.baseline.end,metric.windows.comparison.start,metric.windows.comparison.end,metric.entry_event,metric.success_event])).rows;
 }catch(error){if((error as {code?:string}).code==='57014')throw new DomainError('METRIC_QUERY_TIMEOUT','The deterministic query did not finish within its five-second resource bound; no comparison is established.',503);throw error;}
 const side=(name:string):WindowSummary=>{let eligible=0,converted=0,unknown=0;const strata=Object.fromEntries(metric.cohorts.map(c=>[c,summarizeRate(0,0)]));for(const row of rows){demand(['baseline','comparison'].includes(row.side),'INVALID_COUNTS','Unexpected deterministic SQL window.');if(row.side!==name)continue;const n=Number(row.eligible),k=Number(row.converted),rate=summarizeRate(n,k);eligible+=n;converted+=k;if(Object.hasOwn(strata,row.device))strata[row.device]=rate;else unknown+=n;}return{...summarizeRate(eligible,converted),strata,unknown_cohort_count:unknown};};
 return computeCountedComparison({baseline:side('baseline'),comparison:side('comparison')},metric,coverage);
}
