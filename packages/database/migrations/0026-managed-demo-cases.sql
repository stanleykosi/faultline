CREATE TABLE faultline.demo_cases (
 workspace_id uuid NOT NULL,
 case_id uuid NOT NULL,
 fixture text NOT NULL CHECK(fixture IN ('regression','mix-shift')),
 fixture_version integer NOT NULL CHECK(fixture_version>0),
 generation integer NOT NULL CHECK(generation>0),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,case_id),
 FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id)
);
ALTER TABLE faultline.demo_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE faultline.demo_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON faultline.demo_cases
 USING(workspace_id::text=current_setting('faultline.workspace_id',true))
 WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true));
GRANT SELECT,INSERT ON faultline.demo_cases TO faultline_api;
REVOKE UPDATE,DELETE,TRUNCATE ON faultline.demo_cases FROM faultline_api;
