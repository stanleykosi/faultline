import type {BuildAttestation, EnvironmentProfile, FixtureProfile, ObservationProfile, RunnerProfile, TargetGrant} from '../targets/StagingRegistryPanel';

export type ExternalBrowserObjective = 'mechanism' | 'correction';
export type ExternalBrowserRunStatus = 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'failed' | 'blocked' | 'completed' | 'succeeded' | 'unknown';
export type ExternalBrowserAction =
  | {op: 'navigate'; path: string}
  | {op: 'click'; locator: {kind: 'test_id' | 'role' | 'label'; value: string; role?: 'button' | 'textbox' | 'checkbox' | 'link' | 'combobox'}}
  | {op: 'fill'; locator: {kind: 'test_id' | 'role' | 'label'; value: string; role?: 'button' | 'textbox' | 'checkbox' | 'link' | 'combobox'}; value_ref: string}
  | {op: 'wait_for'; locator: {kind: 'test_id' | 'role' | 'label'; value: string; role?: 'button' | 'textbox' | 'checkbox' | 'link' | 'combobox'}; timeout_ms: number};

export interface ExternalBrowserPlan {
  id: string;
  plan_hash: string;
  oracle_hash?: string;
  revision_id: string;
  freshness?: string;
  hypothesis_id?: string;
  objective?: ExternalBrowserObjective;
  runner_id?: string;
  environment_id?: string;
  fixture_profile_id?: string;
  observation_profile_id?: string;
  grant_id?: string;
  build_ids?: {known_good: string; incident: string; candidate?: string};
  actions?: ExternalBrowserAction[];
  evidence_ids?: string[];
  value?: Partial<Omit<ExternalBrowserPlan, 'id' | 'plan_hash' | 'value'>>;
  created_at?: string;
}

export interface ExternalBrowserApproval {
  id: string;
  plan_id: string;
  plan_hash: string;
  grant_id: string;
  expires_at: string;
  revoked?: boolean;
  revision?: number;
  reviewer_role?: 'owner' | 'analyst';
  created_at?: string;
}

export interface ExternalBrowserRun {
  id: string;
  plan_id: string;
  plan_hash?: string;
  approval_id: string;
  job_id?: string | null;
  execution_id?: string | null;
  status: ExternalBrowserRunStatus;
  error_code?: string | null;
  updated_at?: string;
}

export interface ExternalBrowserResult {
  id: string;
  run_id: string;
  plan_id: string;
  status?: string;
  outcome?: string;
  mode?: string;
  freshness?: string;
  reason_code?: string | null;
  reasons?: string[];
  verification_limit_reason?: string | null;
  observed_runs?: number;
  result_hash?: string;
  value?: Record<string, unknown>;
  created_at?: string;
}

export interface ExternalBrowserObservation {
  arm: 'known_good' | 'incident' | 'candidate';
  cohort: 'mobile' | 'desktop';
  repeat: number;
  status: 'observed' | 'blocked' | 'failed' | 'cancelled';
  plan_hash: string;
  oracle_hash: string;
  build_digest: string;
  build_digest_after: string;
  deployment_evidence_hash: string;
  fixture_hash: string;
  environment_hash: string;
  runner_id: string;
  actual: {checkout_completed: boolean; order_created_count: number; error_code: string | null} | null;
}

export interface ExternalBrowserAttempt {
  attempt_id: string;
  arm: ExternalBrowserObservation['arm'];
  cohort: ExternalBrowserObservation['cohort'];
  repeat: number;
  status: ExternalBrowserObservation['status'];
  started_at: string;
  finished_at: string;
  observation_hash: string;
  ui_completed: boolean | null;
  receipt_completed: boolean | null;
  network_request_count: number;
  denied_requests: {code: 'ORIGIN_DENIED' | 'PATH_DENIED' | 'WEBSOCKET_DENIED' | 'POPUP_DENIED' | 'DOWNLOAD_DENIED'; origin: null; path: null}[];
  errors: string[];
  deployment: {
    arm: ExternalBrowserObservation['arm'];
    deployment_id: string;
    attester_id: string;
    origin: string;
    build_digest: string;
    deployment_evidence_hash: string;
  };
}

export interface ExternalBrowserResultDetail extends ExternalBrowserResult {
  observations: ExternalBrowserObservation[];
  attempts: ExternalBrowserAttempt[];
  artifacts: [];
  freshness: 'fresh' | 'stale';
  verification_limit_reason: string;
  production_claim_eligible: false;
}

export interface ExternalRunnerProjection {
  id?: string;
  runner_id?: string;
  status: 'available' | 'unavailable' | 'unconfigured' | 'unknown';
  reason_code?: string | null;
  checked_at?: string | null;
  expires_at?: string | null;
}

export interface ExternalBrowserInventory {
  case_revision: number;
  revision_id: string;
  runner: ExternalRunnerProjection | null;
  plans: ExternalBrowserPlan[];
  approvals: ExternalBrowserApproval[];
  runs: ExternalBrowserRun[];
  results: ExternalBrowserResult[];
  catalog: {
    runners: RunnerProfile[];
    environments: EnvironmentProfile[];
    grants: TargetGrant[];
    fixtures: FixtureProfile[];
    observations: ObservationProfile[];
    builds: BuildAttestation[];
  };
}

export interface ExternalBrowserPlanInput {
  hypothesis_id: string;
  objective: ExternalBrowserObjective;
  runner_id: string;
  environment_id: string;
  fixture_profile_id: string;
  observation_profile_id: string;
  grant_id: string;
  build_ids: {known_good: string; incident: string; candidate?: string};
  actions: ExternalBrowserAction[];
  evidence_ids: string[];
}
