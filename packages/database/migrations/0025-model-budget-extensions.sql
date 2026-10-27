CREATE TABLE faultline.model_budget_extensions(
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 case_id uuid NOT NULL,
 revision_id uuid NOT NULL,
 additional_calls integer NOT NULL CHECK(additional_calls BETWEEN 1 AND 4),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 actor_id text NOT NULL,
 case_resource_revision integer NOT NULL CHECK(case_resource_revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id)
);
CREATE INDEX model_budget_extensions_revision ON faultline.model_budget_extensions(workspace_id,case_id,revision_id);
ALTER TABLE faultline.model_budget_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE faultline.model_budget_extensions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON faultline.model_budget_extensions
 USING(workspace_id::text=current_setting('faultline.workspace_id',true))
 WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true));
GRANT SELECT,INSERT ON faultline.model_budget_extensions TO faultline_api;
REVOKE UPDATE,DELETE ON faultline.model_budget_extensions FROM faultline_api;
