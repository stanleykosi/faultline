ALTER TABLE faultline.model_profiles DROP CONSTRAINT model_profiles_provider_check;
ALTER TABLE faultline.model_profiles
  ADD CONSTRAINT model_profiles_provider_check
  CHECK(provider IN('ollama','openai_compatible','openrouter'));

CREATE TABLE faultline.agent_sessions(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  case_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  objective text NOT NULL CHECK(length(objective) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','closed')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,case_id,id),
  FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,profile_id) REFERENCES faultline.model_profiles(workspace_id,id)
);

CREATE TABLE faultline.agent_turns(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  case_id uuid NOT NULL,
  session_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  job_id uuid,
  actor_id text NOT NULL,
  user_message text NOT NULL CHECK(length(user_message) BETWEEN 1 AND 4000),
  status text NOT NULL CHECK(status IN('queued','running','succeeded','failed','cancelled','stale')),
  response jsonb,
  input_hash text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,case_id,id),
  UNIQUE(workspace_id,job_id),
  FOREIGN KEY(workspace_id,case_id,session_id) REFERENCES faultline.agent_sessions(workspace_id,case_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id)
);

CREATE TABLE faultline.agent_actions(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  case_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN('open_data','review_metric','generate_hypotheses','open_evidence','open_data_checks','open_browser_tests','draft_report','open_follow_up')),
  title text NOT NULL,
  reason text NOT NULL,
  requires_approval boolean NOT NULL,
  status text NOT NULL DEFAULT 'suggested' CHECK(status IN('suggested','approved','completed','dismissed','blocked','failed')),
  target_job_id uuid,
  binding_hash text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,case_id,id),
  FOREIGN KEY(workspace_id,case_id,session_id) REFERENCES faultline.agent_sessions(workspace_id,case_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,case_id,turn_id) REFERENCES faultline.agent_turns(workspace_id,case_id,id) ON DELETE CASCADE
);

DO $scope$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['agent_sessions','agent_turns','agent_actions'] LOOP
  EXECUTE format('ALTER TABLE faultline.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE faultline.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(workspace_id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(workspace_id::text=current_setting(''faultline.workspace_id'',true))',t);
 END LOOP;
END $scope$;

GRANT SELECT,INSERT ON faultline.agent_sessions,faultline.agent_turns,faultline.agent_actions TO faultline_api;
GRANT UPDATE(status,updated_at) ON faultline.agent_sessions TO faultline_api;
GRANT UPDATE(job_id,status,response,input_hash,error_code,updated_at) ON faultline.agent_turns TO faultline_api;
GRANT UPDATE(status,target_job_id,approved_by,approved_at,updated_at) ON faultline.agent_actions TO faultline_api;

-- Deleting the case cascades the agent history after the existing containment,
-- object and runner-cleanup checks succeed. The API role still has no DELETE.
GRANT SELECT,DELETE ON faultline.agent_sessions,faultline.agent_turns,faultline.agent_actions TO faultline_authority;
CREATE POLICY purge_authority ON faultline.agent_sessions TO faultline_authority USING(true) WITH CHECK(true);
CREATE POLICY purge_authority ON faultline.agent_turns TO faultline_authority USING(true) WITH CHECK(true);
CREATE POLICY purge_authority ON faultline.agent_actions TO faultline_authority USING(true) WITH CHECK(true);
