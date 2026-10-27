CREATE TABLE faultline.secret_replacements (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 secret_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 base_secret_revision integer NOT NULL CHECK(base_secret_revision>0),
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','model')),
 resource_id uuid NOT NULL,
 resource_revision integer NOT NULL CHECK(resource_revision>0),
 resource_binding jsonb NOT NULL,
 resource_binding_hash text NOT NULL,
 created_by text NOT NULL,
 status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','probing','probed','failed','activated')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 capabilities jsonb,
 probe_binding_hash text,
 probe_nonce uuid,
 probe_expires_at timestamptz,
 activated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,secret_id,version),
 FOREIGN KEY(workspace_id,secret_id,version) REFERENCES faultline.secret_versions(workspace_id,secret_id,version)
);
ALTER TABLE faultline.secret_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE faultline.secret_replacements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON faultline.secret_replacements
 USING(workspace_id::text=current_setting('faultline.workspace_id',true))
 WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true));
GRANT SELECT,INSERT,UPDATE ON faultline.secret_replacements TO faultline_api;
REVOKE DELETE,TRUNCATE ON faultline.secret_replacements FROM faultline_api;
