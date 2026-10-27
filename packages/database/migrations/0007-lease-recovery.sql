CREATE FUNCTION faultline.recover_expired_jobs() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,faultline AS $fn$
DECLARE j faultline.jobs; n integer:=0; terminal text;
BEGIN
 FOR j IN SELECT * FROM faultline.jobs WHERE status IN('running','cancel_requested') AND lease_until<now() ORDER BY lease_until LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  terminal:=CASE WHEN j.status='cancel_requested' THEN 'cancelled' WHEN j.attempt>=3 THEN 'failed' ELSE 'queued' END;
  UPDATE faultline.jobs SET status=terminal,fence=NULL,lease_until=NULL,updated_at=now(),error_code=CASE WHEN terminal='failed' THEN 'LEASE_RETRIES_EXHAUSTED' ELSE error_code END WHERE id=j.id;
  INSERT INTO faultline.job_events(workspace_id,case_id,job_id,event) VALUES(j.workspace_id,j.case_id,j.id,jsonb_build_object('status',terminal,'reason','lease_expired'));
  IF terminal='queued' THEN INSERT INTO faultline.job_outbox(id,workspace_id,job_id) VALUES(gen_random_uuid(),j.workspace_id,j.id);
  ELSIF j.reserved_units>0 THEN UPDATE faultline.budgets SET reserved=reserved-j.reserved_units WHERE workspace_id=j.workspace_id AND case_id=j.case_id AND revision_id=j.revision_id;UPDATE faultline.jobs SET reserved_units=0 WHERE id=j.id;
  END IF;n:=n+1;
 END LOOP;RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION faultline.recover_expired_jobs() FROM PUBLIC;
