-- Immutable scoped staging metadata. Registration never proves runner isolation,
-- deployment freshness or grants authority to execute a target.
CREATE TABLE faultline.staging_catalog (
 id text NOT NULL CHECK(id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
 workspace_id uuid NOT NULL REFERENCES faultline.workspaces(id),case_id uuid,
 kind text NOT NULL CHECK(kind IN('network','runner','environment','attester','grant','fixture','observation','build','probe')),
 value jsonb NOT NULL CHECK(jsonb_typeof(value)='object' AND octet_length(value::text)<=131072),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 registered_by_operator boolean NOT NULL DEFAULT false,
 revoked boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,kind,id),
 FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id),
 CHECK((kind IN('fixture','observation','build'))=(case_id IS NOT NULL)),
 CHECK(registered_by_operator=(kind IN('network','runner','environment','attester')))
);
CREATE INDEX staging_catalog_case ON faultline.staging_catalog(workspace_id,case_id,kind,created_at,id);
ALTER TABLE faultline.staging_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE faultline.staging_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON faultline.staging_catalog FOR SELECT
 USING(workspace_id::text=current_setting('faultline.workspace_id',true));
CREATE POLICY tenant_insert ON faultline.staging_catalog FOR INSERT
 WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true) AND NOT registered_by_operator AND kind IN('grant','fixture','observation','build','probe'));
CREATE POLICY tenant_revoke ON faultline.staging_catalog FOR UPDATE
 USING(workspace_id::text=current_setting('faultline.workspace_id',true) AND NOT registered_by_operator AND kind='grant')
 WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true) AND NOT registered_by_operator AND kind='grant');
GRANT SELECT,INSERT ON faultline.staging_catalog TO faultline_api;
GRANT UPDATE(revoked,revision) ON faultline.staging_catalog TO faultline_api;
-- Operator resource IDs are finite text IDs, rather than invented UUID aliases.
ALTER TABLE faultline.provider_operations ALTER COLUMN resource_id TYPE text USING resource_id::text;
ALTER TABLE faultline.provider_operations DROP CONSTRAINT provider_operations_kind_check;
ALTER TABLE faultline.provider_operations ADD CONSTRAINT provider_operations_kind_check CHECK(kind IN('source_probe','model_probe','runner_probe'));
