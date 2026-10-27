import type {AnalysisContext, Evidence, ReportRecord} from '../investigation/types';
import type {ModelProposal} from './types';

type DraftSentence = ModelProposal['value']['draft_sentences'][number];

export function diagnosisSentenceIssue(sentence: DraftSentence, evidence: Evidence[]): string | null {
  if ((sentence.qualification === 'observed' || sentence.qualification === 'hypothesis') && !sentence.evidence_ids.length) return 'Finding text requires at least one frozen sanitized evidence citation.';
  if (sentence.evidence_ids.some(id => !evidence.some(item => item.id === id && item.redaction_status === 'sanitized'))) return 'A selected citation is restricted, withdrawn or unavailable. Review current evidence before using this sentence.';
  return null;
}

export function diagnosisDraftIssue(proposal: ModelProposal, record: ReportRecord | null, context: AnalysisContext | null): string | null {
  if (proposal.draft_only !== true || proposal.value.kind !== 'diagnosis_draft') return 'Only an actual draft-only diagnosis proposal can be reviewed here.';
  if (proposal.freshness !== 'fresh') return 'This model proposal is stale. Request new draft text from reviewed current inputs.';
  if (!/^[a-f0-9]{64}$/.test(proposal.profile_hash) || proposal.input_hash !== proposal.value.input_hash) return 'The captured profile or proposal input binding is unavailable.';
  if (!context || proposal.revision_id !== context.binding.revision_id || proposal.value.revision_id !== context.binding.revision_id) return 'This proposal is bound to another input revision.';
  if (!record?.value || record.value.status !== 'draft') return 'Create or select an unpublished manual report draft before appending reviewed model text.';
  if (!Number.isInteger(record.revision) || record.revision! < 1) return 'Refresh to establish the exact report resource revision.';
  if (record.freshness !== 'fresh' || record.value.claim.freshness !== 'fresh' || record.value.revision_id !== context.binding.revision_id || record.value.metric_hash !== context.binding.metric_hash || record.value.snapshot_hash !== context.binding.snapshot_hash) return 'The selected report draft uses stale or unknown inputs. Prepare a fresh draft first.';
  return null;
}

export function reviewedDiagnosisCommand(proposal: ModelProposal, record: ReportRecord, context: AnalysisContext | null, evidence: Evidence[], indexes: number[]) {
  const issue = diagnosisDraftIssue(proposal, record, context);
  if (issue) throw new Error(issue);
  if (!indexes.length || indexes.length > 30 || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isInteger(index) || index < 0 || index >= proposal.value.draft_sentences.length)) throw new Error('Select existing draft sentence indexes after reviewing their qualifications and citations.');
  for (const index of indexes) {
    const citationIssue = diagnosisSentenceIssue(proposal.value.draft_sentences[index]!, evidence);
    if (citationIssue) throw new Error(citationIssue);
  }
  return {body: {model_proposal_id: proposal.id, proposal_sentence_indexes: indexes}, revision: record.revision!};
}
