-- Immutable finite-policy previews and retained within-case pseudonym bindings.
-- No deletion or arbitrary declassification authority is added.
CREATE TABLE faultline.case_redaction_keys (
 workspace_id uuid NOT NULL,case_id uuid NOT NULL,key_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,case_id),
 FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id)
);
CREATE TABLE faultline.redaction_previews (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,case_id uuid NOT NULL,
 revision_id uuid NOT NULL,job_id uuid NOT NULL UNIQUE,value jsonb NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,case_id,id),
 FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id),
 FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.case_redaction_keys(workspace_id,case_id)
);
DO $scope$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['case_redaction_keys','redaction_previews'] LOOP
 EXECUTE format('ALTER TABLE faultline.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE faultline.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(workspace_id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(workspace_id::text=current_setting(''faultline.workspace_id'',true))',t);
END LOOP;END $scope$;
GRANT SELECT,INSERT ON faultline.case_redaction_keys,faultline.redaction_previews TO faultline_api;
