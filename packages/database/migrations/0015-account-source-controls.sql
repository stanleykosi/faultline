ALTER TABLE faultline.integration_capture_artifacts DROP CONSTRAINT integration_capture_artifacts_size_bytes_check;
ALTER TABLE faultline.integration_capture_artifacts ADD CONSTRAINT integration_capture_artifacts_size_bytes_check CHECK(size_bytes>=0);
CREATE OR REPLACE FUNCTION faultline.principal_workspaces(pid text) RETURNS TABLE(id uuid,name text,revision integer,created_at timestamptz,role text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
 SELECT w.id,w.name,w.revision,w.created_at,m.role FROM faultline.workspaces w JOIN faultline.memberships m ON m.workspace_id=w.id WHERE m.user_id=pid AND w.deletion_requested_at IS NULL ORDER BY w.created_at,w.id
$fn$;
CREATE FUNCTION auth.delete_own_account(pid text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,auth,faultline AS $fn$
DECLARE address text;
BEGIN
 PERFORM w.id FROM faultline.workspaces w JOIN faultline.memberships m ON m.workspace_id=w.id WHERE m.user_id=pid ORDER BY w.id FOR UPDATE OF w;
 IF EXISTS(SELECT 1 FROM faultline.memberships m JOIN faultline.workspaces w ON w.id=m.workspace_id WHERE m.user_id=pid AND m.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM faultline.memberships o WHERE o.workspace_id=m.workspace_id AND o.role='owner' AND o.user_id<>pid)) THEN RETURN false;END IF;
 SELECT email INTO address FROM auth."user" WHERE id=pid FOR UPDATE;
 IF NOT FOUND THEN RETURN true;END IF;
 INSERT INTO faultline.audit(id,workspace_id,actor_id,operation,details) SELECT gen_random_uuid(),workspace_id,pid,'account.delete',jsonb_build_object('retained_history','minimal actor ID; source records and backups retain their stated policies') FROM faultline.memberships WHERE user_id=pid;
 DELETE FROM faultline.memberships WHERE user_id=pid;
 DELETE FROM auth.recovery_capabilities WHERE user_id=pid;
 DELETE FROM auth.session WHERE "userId"=pid;
 DELETE FROM auth.account WHERE "userId"=pid;
 DELETE FROM auth.verification WHERE identifier=address;
 DELETE FROM auth.enrollment_capabilities WHERE lower(intended_email)=lower(address);
 DELETE FROM auth."user" WHERE id=pid;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION auth.delete_own_account(text) FROM PUBLIC;
GRANT DELETE ON faultline.memberships TO faultline_authority;
GRANT DELETE ON auth."user",auth.session,auth.account,auth.verification,auth.recovery_capabilities,auth.enrollment_capabilities TO faultline_authority;
GRANT SELECT ON auth.session,auth.account,auth.verification,auth.recovery_capabilities TO faultline_authority;
ALTER FUNCTION auth.delete_own_account(text) OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION auth.delete_own_account(text) TO faultline_auth;
