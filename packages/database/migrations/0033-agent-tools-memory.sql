-- Sponsor-backed agent context remains subordinate to the current case,
-- published report, evidence and deterministic result records.
CREATE TABLE faultline.memory_capsules(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  case_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  report_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','withdrawn')),
  value jsonb NOT NULL,
  capsule_hash text NOT NULL CHECK(capsule_hash ~ '^[a-f0-9]{64}$'),
  accepted_by text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,report_id),
  FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,case_id,report_id) REFERENCES faultline.report_versions(workspace_id,case_id,id) ON DELETE CASCADE
);

CREATE TABLE faultline.memory_retrievals(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  case_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  query_hash text NOT NULL CHECK(query_hash ~ '^[a-f0-9]{64}$'),
  catalog_hash text NOT NULL CHECK(catalog_hash ~ '^[a-f0-9]{64}$'),
  result_hash text NOT NULL CHECK(result_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN('complete','empty','unavailable')),
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,case_id,id),
  FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id) ON DELETE CASCADE
);

CREATE TABLE faultline.memory_feedback(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  case_id uuid NOT NULL,
  capsule_id uuid NOT NULL,
  retrieval_id uuid NOT NULL,
  actor_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN('helpful','not_relevant','wrong')),
  engine_trace jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,capsule_id) REFERENCES faultline.memory_capsules(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,case_id,retrieval_id) REFERENCES faultline.memory_retrievals(workspace_id,case_id,id) ON DELETE CASCADE
);

CREATE INDEX memory_capsules_active_catalog_idx ON faultline.memory_capsules(workspace_id,accepted_at,id) WHERE status='active';
CREATE INDEX memory_feedback_latest_idx ON faultline.memory_feedback(workspace_id,capsule_id,created_at DESC,id DESC);

ALTER TABLE faultline.agent_turns
  ADD COLUMN message_kind text NOT NULL DEFAULT 'user' CHECK(message_kind IN('user','tool')),
  ADD COLUMN memory_retrieval_id uuid,
  ADD CONSTRAINT agent_turns_memory_retrieval_fkey
    FOREIGN KEY(workspace_id,case_id,memory_retrieval_id)
    REFERENCES faultline.memory_retrievals(workspace_id,case_id,id)
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE faultline.agent_actions DROP CONSTRAINT agent_actions_kind_check;
ALTER TABLE faultline.agent_actions DROP CONSTRAINT agent_actions_status_check;
ALTER TABLE faultline.agent_actions
  ADD CONSTRAINT agent_actions_kind_check CHECK(kind IN(
    'open_data','review_metric','generate_hypotheses','open_evidence',
    'open_data_checks','open_browser_tests','draft_report','open_follow_up',
    'gather_related_evidence','recall_prior_investigations','review_results',
    'draft_test_plan','schedule_follow_up'
  )),
  ADD CONSTRAINT agent_actions_status_check CHECK(status IN('suggested','approved','completed','dismissed','blocked','failed','cancelled')),
  ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN tool_result jsonb,
  ADD COLUMN reflection_turn_id uuid,
  ADD COLUMN last_error_code text,
  ADD CONSTRAINT agent_actions_reflection_turn_fkey
    FOREIGN KEY(workspace_id,case_id,reflection_turn_id)
    REFERENCES faultline.agent_turns(workspace_id,case_id,id)
    DEFERRABLE INITIALLY IMMEDIATE;

DO $scope$ DECLARE t text;BEGIN
  FOREACH t IN ARRAY ARRAY['memory_capsules','memory_retrievals','memory_feedback'] LOOP
    EXECUTE format('ALTER TABLE faultline.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE faultline.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(workspace_id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(workspace_id::text=current_setting(''faultline.workspace_id'',true))',t);
  END LOOP;
END $scope$;

GRANT SELECT,INSERT ON faultline.memory_capsules,faultline.memory_retrievals,faultline.memory_feedback TO faultline_api;
GRANT UPDATE(status,withdrawn_at) ON faultline.memory_capsules TO faultline_api;
GRANT UPDATE(memory_retrieval_id) ON faultline.agent_turns TO faultline_api;
GRANT UPDATE(tool_result,reflection_turn_id,last_error_code) ON faultline.agent_actions TO faultline_api;

GRANT SELECT,DELETE ON faultline.memory_capsules,faultline.memory_retrievals,faultline.memory_feedback TO faultline_authority;
CREATE POLICY purge_authority ON faultline.memory_capsules TO faultline_authority USING(true) WITH CHECK(true);
CREATE POLICY purge_authority ON faultline.memory_retrievals TO faultline_authority USING(true) WITH CHECK(true);
CREATE POLICY purge_authority ON faultline.memory_feedback TO faultline_authority USING(true) WITH CHECK(true);

CREATE FUNCTION faultline.agent_reflection_routes()
RETURNS TABLE(workspace_id uuid,job_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
 SELECT DISTINCT a.workspace_id,a.target_job_id
 FROM faultline.agent_actions a
 JOIN faultline.jobs j ON j.workspace_id=a.workspace_id AND j.id=a.target_job_id
 WHERE a.status='approved' AND a.reflection_turn_id IS NULL
   AND j.status IN('succeeded','failed','waiting_for_input','cancelled')
 ORDER BY a.target_job_id
 LIMIT 20
$fn$;
REVOKE ALL ON FUNCTION faultline.agent_reflection_routes() FROM PUBLIC;
ALTER FUNCTION faultline.agent_reflection_routes() OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION faultline.agent_reflection_routes() TO faultline_dispatcher;
