-- Temporary storage is charged before a signed upload can be issued. Its
-- reservation survives acceptance until the provider's two-hour URL expires.
CREATE TABLE faultline.direct_uploads (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 case_id uuid NOT NULL,
 actor_id text NOT NULL,
 reservation_id uuid NOT NULL,
 size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=52428800),
 expires_at timestamptz NOT NULL,
 cleanup_after timestamptz NOT NULL,
 cleaned_at timestamptz,
 FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id) ON DELETE CASCADE,
 CHECK(cleanup_after>expires_at)
);
ALTER TABLE faultline.direct_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE faultline.direct_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON faultline.direct_uploads
 USING(workspace_id::text=current_setting('faultline.workspace_id',true))
 WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true));
GRANT SELECT,INSERT ON faultline.direct_uploads TO faultline_api;
GRANT UPDATE(cleaned_at) ON faultline.direct_uploads TO faultline_api;
GRANT UPDATE(amount) ON faultline.storage_reservations TO faultline_api;
GRANT SELECT,DELETE ON faultline.direct_uploads TO faultline_authority;
CREATE POLICY purge_authority ON faultline.direct_uploads TO faultline_authority USING(true) WITH CHECK(true);
CREATE FUNCTION faultline.expired_direct_upload_routes()
RETURNS TABLE(workspace_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
 SELECT DISTINCT workspace_id FROM faultline.direct_uploads
 WHERE cleaned_at IS NULL AND cleanup_after<now() LIMIT 10
$fn$;
REVOKE ALL ON FUNCTION faultline.expired_direct_upload_routes() FROM PUBLIC;
ALTER FUNCTION faultline.expired_direct_upload_routes() OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION faultline.expired_direct_upload_routes() TO faultline_dispatcher;
