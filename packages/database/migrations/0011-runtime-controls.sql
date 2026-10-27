ALTER TABLE faultline.cases ADD COLUMN disposition text CHECK(disposition IN('resolved','unresolved','no_issue'));
ALTER TABLE faultline.cases ADD COLUMN disposition_note text;
ALTER TABLE faultline.cases ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE faultline.workspaces ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE faultline.followups ADD COLUMN due_lease_until timestamptz;
ALTER TABLE faultline.followups ADD COLUMN due_dispatched_at timestamptz;
ALTER TABLE faultline.secrets ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE faultline.secrets ADD COLUMN active_version integer NOT NULL DEFAULT 1;
ALTER TABLE faultline.secrets ADD CONSTRAINT secret_scope UNIQUE(workspace_id,id);
CREATE TABLE faultline.secret_versions(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,secret_id uuid NOT NULL,version integer NOT NULL,key_version text NOT NULL,ciphertext text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,secret_id,version),FOREIGN KEY(workspace_id,secret_id) REFERENCES faultline.secrets(workspace_id,id));
CREATE TABLE faultline.workspace_policies(workspace_id uuid PRIMARY KEY REFERENCES faultline.workspaces(id),value jsonb NOT NULL,privacy_value jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,privacy_revision integer NOT NULL DEFAULT 1);
CREATE TABLE faultline.notifications(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,user_id text NOT NULL,case_id uuid,type text NOT NULL,details jsonb NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),dedupe_key text NOT NULL,UNIQUE(workspace_id,user_id,dedupe_key));
CREATE TABLE faultline.comment_revisions(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,case_id uuid NOT NULL,comment_id uuid NOT NULL,revision integer NOT NULL,text text NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,comment_id,revision));
DO $scope$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['secret_versions','workspace_policies','notifications','comment_revisions'] LOOP
 EXECUTE format('ALTER TABLE faultline.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE faultline.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(workspace_id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(workspace_id::text=current_setting(''faultline.workspace_id'',true))',t);
END LOOP;END $scope$;
CREATE FUNCTION faultline.admit_run_slot() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
BEGIN
 PERFORM singleton FROM faultline.installation WHERE singleton FOR UPDATE;
 RETURN (SELECT count(*) FROM faultline.jobs WHERE status IN('queued','running','cancel_requested'))<2;
END $fn$;
REVOKE ALL ON FUNCTION faultline.admit_run_slot() FROM PUBLIC;
CREATE FUNCTION faultline.due_followup_routes() RETURNS TABLE(workspace_id uuid,case_id uuid,followup_id uuid,actor_id text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
DECLARE f faultline.followups;
BEGIN
 FOR f IN SELECT * FROM faultline.followups WHERE state='scheduled' AND due_dispatched_at IS NULL AND (value->>'due_at')::timestamptz<=now() AND (due_lease_until IS NULL OR due_lease_until<now()) ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  UPDATE faultline.followups SET due_lease_until=now()+interval '30 seconds' WHERE id=f.id;
  workspace_id:=f.workspace_id;case_id:=f.case_id;followup_id:=f.id;actor_id:=f.actor_id;RETURN NEXT;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION faultline.due_followup_routes() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON faultline.followups TO faultline_authority;
CREATE POLICY due_authority ON faultline.followups TO faultline_authority USING(true) WITH CHECK(true);
ALTER FUNCTION faultline.admit_run_slot() OWNER TO faultline_authority;
ALTER FUNCTION faultline.due_followup_routes() OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION faultline.admit_run_slot(),faultline.due_followup_routes() TO faultline_api;
GRANT SELECT,INSERT ON faultline.secret_versions,faultline.workspace_policies,faultline.notifications,faultline.comment_revisions TO faultline_api;
GRANT UPDATE(value,privacy_value,revision,privacy_revision) ON faultline.workspace_policies TO faultline_api;
GRANT UPDATE(read_at) ON faultline.notifications TO faultline_api;
GRANT UPDATE(revision,active_version) ON faultline.secrets TO faultline_api;
GRANT UPDATE(disposition,disposition_note,deletion_requested_at) ON faultline.cases TO faultline_api;
GRANT UPDATE(deletion_requested_at) ON faultline.workspaces TO faultline_api;
GRANT UPDATE(due_lease_until,due_dispatched_at) ON faultline.followups TO faultline_api;
