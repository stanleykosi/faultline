/** Display only: original enums, source text, citations and hashes stay unchanged. */
const labels: Record<string, string> = {
  MODEL_UNAVAILABLE: 'Agent unavailable',
  MODEL_BUDGET_EXHAUSTED: 'Agent limit reached', MODEL_BUDGET_EXCEEDED: 'Agent limit reached', MODEL_CALL_FAILED: 'Agent request failed', MODEL_REFUSED_OR_TRUNCATED: 'The model could not finish its response', MODEL_NOT_READY: 'Check the model connection', SOURCE_UNAVAILABLE: 'Data source unavailable', STALE_INPUTS: 'Inputs changed', MODEL_CANCELLED: 'Agent request cancelled',
  complete_attested: 'Complete (reported)', provisional: 'May change', incomplete: 'Incomplete',
  source_guarantee: 'Source confirmed', operator_attestation: 'Confirmed by a reviewer', lateness_assumption: 'Assumes no late data', none: 'Not confirmed',
  association_only: 'Observed link only', not_established: 'Not proven', untested: 'Not tested', not_tested: 'Not tested',
  reproduced: 'Reproduced', not_reproduced: 'Not reproduced', validated: 'Fix checked', inconclusive: 'No conclusion',
  specified_snapshot_and_test_environment: 'Selected data and test environment', synthetic_fixture: 'Synthetic test data',
  LATE_ARRIVAL_ASSUMPTION: 'Late data could change this result.',
  sanitized: 'Filtered', restricted: 'Private', withdrawn: 'Withdrawn',
  user_attested: 'Confirmed by a reviewer', analytics: 'Session data', human_note: 'Note', support: 'Support', release: 'Release',
  cohort: 'Group', cohorts: 'Groups', strata: 'Groups', baseline: 'Earlier period', comparison: 'Later period',
  baseline_rate: 'Earlier rate', comparison_rate: 'Later rate', baseline_eligible: 'Earlier eligible sessions', comparison_eligible: 'Later eligible sessions',
  baseline_converted: 'Earlier conversions', comparison_converted: 'Later conversions', delta_pp: 'Change (percentage points)',
  unknown_cohort_count: 'Sessions with no known group', cohort_relation: 'Group link', causal_effect: 'Overall cause',
  data_quality: 'Data quality', cohort_change: 'Change within groups', mix_shift: 'Group mix', temporal_alignment: 'Release timing', negative_control: 'Unaffected group check',
  hypotheses: 'Possible reasons', hypothesis: 'Possible reason', diagnosis_draft: 'Report draft', critique: 'Draft review', next_step: 'Next step',
  mechanism: 'Issue reproduction', correction: 'Fix check',
  frozen_input_binding_changed: 'The locked inputs changed', evidence_reference_unavailable_or_withdrawn: 'Cited evidence is unavailable or withdrawn', multiple_sources_require_explicit_metric_source: 'Choose one data source for the metric', incomplete_or_provisional_event_population: 'The data is incomplete or provisional', cohort_denominator_below_declared_minimum: 'Not enough eligible sessions in a group', no_predeclared_direction: 'Choose the expected change before running the check', observed_cohort_direction_contradicts_prediction: 'The group changed differently from the prediction', standardization_has_missing_or_sparse_strata: 'Some groups are missing or have too few sessions', composition_alone_does_not_match_declared_aggregate_pattern: 'The group mix alone does not explain the expected pattern', frozen_metric_windows_required_for_temporal_alignment: 'Lock the metric periods before checking timing',
  conflicting_identity_or_unknown_cohort: 'Conflicting records or unknown device groups',
  expected_direction_observed: 'The expected change was observed', expected_direction_not_observed: 'The expected change was not observed',
  insufficient_denominator: 'Not enough eligible sessions', unchanged: 'Unchanged', increase: 'Increase', decrease: 'Decrease',
};
function knownLabel(value: string): string | undefined {return Object.hasOwn(labels,value) ? labels[value] : undefined;}
export function displayLabel(value: string): string {return knownLabel(value) ?? knownLabel(value.replaceAll(' ', '_')) ?? value.replaceAll('_', ' ');}

/** Translate product-authored summaries, not uploaded records or user notes. */
function plainWords(value: string): string {
  // These phrases come from fixed server summaries. Preserve their values and limits.
  const summary = value
    .replace(/^Session conversion: baseline /, 'Session conversion: earlier period ').replace(/; comparison (?=\d|unknown)/g, '; later period ')
    .replace(/Baseline-mix standardization is a descriptive accounting identity, not a causal contribution\./g, 'Using the earlier group sizes does not prove the cause.')
    .replace(/Descriptive analytic checks do not establish aggregate causality or reproduce an application mechanism\./g, 'Data checks do not prove the cause or reproduce the issue.')
    .replace(/Comparison conversion rate at baseline cohort weights: (0(?:\.\d+)?|1(?:\.0+)?|unknown) \((complete|provisional|inconclusive)\)\./g, (_match, rate: string, status: string) => `Later rate using earlier group sizes: ${rate === 'unknown' ? 'Unknown' : `${Number((Number(rate) * 100).toFixed(8))}%`} (${displayLabel(status)}).`)
    .replace(/Descriptive association; aggregate causal effect not established\./gi, 'This is an observed link, not proof of the cause.')
    .replace(/aggregate causal effect (?:is )?not established/gi, 'the overall cause is not proven');
  return summary.replace(/\bGenerate hypotheses\b/gi, match => /^[A-Z]/.test(match) ? 'Suggest possible reasons' : 'suggest possible reasons').replace(/\bAI\b/g,'agent').replace(/\bHypotheses\b/g,'Possible reasons').replace(/\bhypotheses\b/g,'possible reasons').replace(/\bHypothesis\b/g,'Possible reason').replace(/\bhypothesis\b/g,'possible reason').replace(/\bcohort mix\b/gi,'group mix').replace(/\b[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+\b/g, token => knownLabel(token) ?? token)
    .replace(/\bcohorts?\b/gi, match => match.toLowerCase()==='cohorts'?'groups':'group')
    .replace(/\bwithin[-\s\u2010-\u2015]+strat(?:um|a) (?:component|change)\b/gi,'change within groups')
    .replace(/\bwithin[-\s\u2010-\u2015]+strat(?:um|a)\b/gi,'within-group')
    .replace(/\bstratified (rates?|results?|analysis|checks?)\b/gi, '$1 by group')
    .replace(/\bstratum\b/gi,'group').replace(/\bstrata\b/gi,'groups').replace(/\bstratified\b/gi,'grouped')
    .replace(/\bbaseline (?:cohort )?weights\b/gi,'earlier group sizes')
    .replace(/\bbaseline\b/gi,'earlier period').replace(/\bcomparison window\b/gi,'later period')
    .replace(/\baggregate causal effect\b/gi,'the overall cause').replace(/\baggregate causation\b/gi,'the overall cause')
    .replace(/\bobserved association\b/gi,'observed link').replace(/\breproduced mechanism\b/gi,'reproduced issue').replace(/\bvalidated correction\b/gi,'tested fix').replace(/\baggregate\b/gi,'overall');
}
// Paths, URLs and quoted data are exact references, never glossary input.
const exactReferences = /https?:\/\/[^\s<>"'`]+|[A-Za-z]:\\[^\s<>"'`]+|“[^”]*”|‘[^’]*’|`[^`]*`|"(?:\\.|[^"\\])*"|(?<!\w)'(?:\\.|[^'\\])*'(?!\w)|(?:\.{0,2}\/|[A-Za-z0-9._~-]+\/)[^\s<>"'`]+/g;
export function plainSummary(value: string): string {
  let result = '', start = 0;
  for (const match of value.matchAll(exactReferences)) {
    result += plainWords(value.slice(start, match.index)) + match[0];
    start = match.index + match[0].length;
  }
  return result + plainWords(value.slice(start));
}
export function evidenceSummary(item: {source_kind: string; source_ref: string; text: string}): string {
  return item.source_kind==='analytics' && /^(?:comparison|followup):/.test(item.source_ref) ? plainSummary(item.text) : item.text;
}
