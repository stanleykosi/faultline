ALTER TABLE faultline.jobs ADD COLUMN reserved_units integer NOT NULL DEFAULT 0 CHECK(reserved_units>=0);
CREATE TABLE faultline.case_storage(workspace_id uuid NOT NULL,case_id uuid NOT NULL,used_bytes bigint NOT NULL DEFAULT 0,reserved_bytes bigint NOT NULL DEFAULT 0,ceiling bigint NOT NULL DEFAULT 1073741824,CHECK(used_bytes>=0 AND reserved_bytes>=0 AND used_bytes+reserved_bytes<=ceiling),PRIMARY KEY(workspace_id,case_id),FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id));
CREATE TABLE faultline.object_references(workspace_id uuid NOT NULL,case_id uuid NOT NULL,object_key text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>=0),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,case_id,object_key),FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id));
CREATE TABLE faultline.storage_reservations(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,case_id uuid NOT NULL,amount bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id));
DO $scope$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['case_storage','object_references','storage_reservations'] LOOP
EXECUTE format('ALTER TABLE faultline.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE faultline.%I FORCE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(workspace_id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(workspace_id::text=current_setting(''faultline.workspace_id'',true))',t);
END LOOP;END $scope$;
GRANT SELECT,INSERT ON faultline.case_storage,faultline.object_references,faultline.storage_reservations TO faultline_api;
GRANT UPDATE(used_bytes,reserved_bytes,ceiling) ON faultline.case_storage TO faultline_api;
GRANT DELETE ON faultline.storage_reservations TO faultline_api;
