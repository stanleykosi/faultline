import {useEffect, useState} from 'react';
import {boundedResource} from '../../read-state';

export type ProposalKind = 'diagnosis_draft' | 'hypotheses';
export type ProposalReadinessBinding = {base: string; revisionId: string; profileId: string; kind: ProposalKind; refreshKey: string};
export type ProposalRequestReadiness = {
  revision_id: string;
  profile_id: string;
  kind: ProposalKind;
  remaining_calls: number;
  remaining_input: number;
  remaining_output: number;
  input_required: number;
  can_request: boolean;
  reason_code: null | 'MODEL_BUDGET_EXHAUSTED';
};
export type ProposalReadinessSnapshot = {key: string; status: 'loading' | 'available' | 'unavailable'; value: ProposalRequestReadiness | null};
export type ProposalRequestState = {canRequest: boolean; status: 'loading' | 'available' | 'unavailable' | 'exhausted'; message: string | null};

export function proposalReadinessKey(binding: ProposalReadinessBinding): string {
  return JSON.stringify([binding.base, binding.revisionId, binding.profileId, binding.kind, binding.refreshKey]);
}

function exactReadiness(value: unknown, binding: ProposalReadinessBinding): value is ProposalRequestReadiness {
  if (!value || typeof value !== 'object') return false;
  const item = value as ProposalRequestReadiness;
  return item.revision_id === binding.revisionId && item.profile_id === binding.profileId && item.kind === binding.kind &&
    [item.remaining_calls, item.remaining_input, item.remaining_output, item.input_required].every(count => Number.isSafeInteger(count) && count >= 0) &&
    typeof item.can_request === 'boolean' && [null, 'MODEL_BUDGET_EXHAUSTED'].includes(item.reason_code) &&
    (item.can_request ? item.reason_code === null : item.reason_code === 'MODEL_BUDGET_EXHAUSTED');
}

export async function readProposalRequestReadiness(binding: ProposalReadinessBinding, signal?: AbortSignal): Promise<ProposalRequestReadiness> {
  if (!binding.profileId || !binding.revisionId) throw new Error('Select current model and investigation inputs before checking the request allowance.');
  const query = new URLSearchParams({profile_id: binding.profileId, kind: binding.kind});
  const value = await boundedResource<unknown>(`${binding.base}/model-proposal-readiness?${query}`, signal);
  if (!exactReadiness(value, binding)) throw new Error('The agent request allowance did not match the selected model and investigation inputs. Refresh to check again.');
  return value;
}

export function proposalRequestState(snapshot: ProposalReadinessSnapshot | null, binding: ProposalReadinessBinding): ProposalRequestState {
  // Compare during render, before effects run: a prior selection or refresh must
  // never authorize a request for the newly selected profile or input revision.
  if (!snapshot || snapshot.key !== proposalReadinessKey(binding) || snapshot.status === 'loading')
    return {canRequest: false, status: 'loading', message: 'Checking this agent request’s allowance. Saved work remains available.'};
  if (snapshot.status !== 'available' || !exactReadiness(snapshot.value, binding))
    return {canRequest: false, status: 'unavailable', message: 'Could not check this agent request’s allowance. Saved work is preserved. Refresh to try again.'};
  const value = snapshot.value;
  if (!value.can_request || value.remaining_calls < 1 || value.remaining_input < value.input_required || value.remaining_output < 1)
    return {canRequest: false, status: 'exhausted', message: 'This agent request exceeds the remaining allowance. Saved drafts and tool results are preserved. Review saved work or ask an owner to review the limit, then refresh.'};
  return {canRequest: true, status: 'available', message: null};
}

export function useProposalRequestReadiness(binding: ProposalReadinessBinding, enabled: boolean): ProposalRequestState {
  const key = proposalReadinessKey(binding);
  const [snapshot, setSnapshot] = useState<ProposalReadinessSnapshot | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (!enabled) return;
    const controller = new AbortController();
    setSnapshot({key, status: 'loading', value: null});
    void readProposalRequestReadiness(binding, controller.signal).then(value => {
      if (!controller.signal.aborted) setSnapshot({key, status: 'available', value});
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot({key, status: 'unavailable', value: null});
    });
    return () => controller.abort();
  }, [key, enabled]);
  return proposalRequestState(enabled ? snapshot : null, binding);
}
