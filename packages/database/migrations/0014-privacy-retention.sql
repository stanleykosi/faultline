CREATE TABLE faultline.source_identity_policies(workspace_id uuid NOT NULL,source_id uuid NOT NULL,version text NOT NULL,key_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,source_id),FOREIGN KEY(workspace_id,source_id) REFERENCES faultline.sources(workspace_id,id));
CREATE TABLE faultline.evidence_annotations(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,case_id uuid NOT NULL,evidence_id uuid NOT NULL,related_evidence_ids uuid[] NOT NULL DEFAULT '{}',kind text NOT NULL CHECK(kind IN('note_links','supersession','privacy_derivative')),reason text NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,case_id,evidence_id) REFERENCES faultline.evidence(workspace_id,case_id,id));
CREATE TABLE faultline.evidence_artifacts(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,case_id uuid NOT NULL,evidence_id uuid NOT NULL,original_id uuid,object_key text NOT NULL,sha256 text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=5242880),media_type text NOT NULL,kind text NOT NULL CHECK(kind IN('quarantined_original','reviewed_text_derivative')),privacy_policy_version text,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,case_id,id),FOREIGN KEY(workspace_id,case_id,evidence_id) REFERENCES faultline.evidence(workspace_id,case_id,id),FOREIGN KEY(workspace_id,case_id,original_id) REFERENCES faultline.evidence_artifacts(workspace_id,case_id,id));
ALTER TABLE faultline.jobs ADD COLUMN retry_of uuid REFERENCES faultline.jobs(id);
CREATE TABLE faultline.retention_requests(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,case_id uuid,kind text NOT NULL CHECK(kind IN('case_delete','workspace_delete','policy_retention')),actor_id text NOT NULL,review_hash text NOT NULL,value jsonb NOT NULL,status text NOT NULL CHECK(status IN('pending_containment','purging','completed','pending_cleanup')),fence uuid,lease_until timestamptz,result jsonb NOT NULL DEFAULT '{}',error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,id));
CREATE TABLE faultline.retention_objects(workspace_id uuid NOT NULL,request_id uuid NOT NULL,object_key text NOT NULL,status text NOT NULL CHECK(status IN('pending','removed','retained_shared','failed')),error_code text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,request_id,object_key),FOREIGN KEY(workspace_id,request_id) REFERENCES faultline.retention_requests(workspace_id,id));
DO $scope$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['source_identity_policies','evidence_annotations','evidence_artifacts','retention_requests','retention_objects'] LOOP
 EXECUTE format('ALTER TABLE faultline.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE faultline.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(workspace_id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(workspace_id::text=current_setting(''faultline.workspace_id'',true))',t);
END LOOP;END $scope$;
CREATE POLICY retention_authority ON faultline.retention_requests TO faultline_authority USING(true) WITH CHECK(true);
GRANT SELECT ON faultline.retention_requests TO faultline_authority;
CREATE FUNCTION faultline.retention_routes() RETURNS TABLE(workspace_id uuid,id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
 SELECT workspace_id,id FROM faultline.retention_requests WHERE status<>'completed' AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT 20
$fn$;
REVOKE ALL ON FUNCTION faultline.retention_routes() FROM PUBLIC;
ALTER FUNCTION faultline.retention_routes() OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION faultline.retention_routes() TO faultline_api;
GRANT SELECT,INSERT ON faultline.source_identity_policies,faultline.evidence_annotations,faultline.evidence_artifacts,faultline.retention_requests,faultline.retention_objects TO faultline_api;
GRANT UPDATE(status,fence,lease_until,result,error_code,updated_at) ON faultline.retention_requests TO faultline_api;
GRANT UPDATE(status,error_code,updated_at) ON faultline.retention_objects TO faultline_api;
GRANT DELETE ON faultline.object_references,faultline.canonical_events TO faultline_api;
