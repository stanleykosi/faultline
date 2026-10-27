-- Minimized read-only capacity observation. No admission lock or reservation is taken.
CREATE FUNCTION faultline.preflight_active_runs() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
 SELECT (SELECT count(*) FROM faultline.jobs WHERE status IN('queued','running','cancel_requested'))
      + (SELECT count(*) FROM faultline.provider_operations WHERE status IN('queued','running','cancel_requested'));
$fn$;
REVOKE ALL ON FUNCTION faultline.preflight_active_runs() FROM PUBLIC;
ALTER FUNCTION faultline.preflight_active_runs() OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION faultline.preflight_active_runs() TO faultline_api;
