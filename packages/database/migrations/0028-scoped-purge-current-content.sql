-- Extend the reviewed deletion-intent capability to the schema-27 append-only
-- and redaction metadata. Scope, containment, runner proof and object checks are
-- unchanged from 0019; no API role receives direct DELETE authority.
CREATE OR REPLACE FUNCTION faultline.purge_case_data(cid uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,faultline,auth AS $fn$
DECLARE wid uuid:=current_setting('faultline.workspace_id',true)::uuid;t text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM faultline.cases WHERE workspace_id=wid AND id=cid AND deletion_requested_at IS NOT NULL) THEN RAISE EXCEPTION 'Deletion intent required';END IF;
 IF EXISTS(SELECT 1 FROM faultline.jobs WHERE workspace_id=wid AND case_id=cid AND status IN('queued','running','cancel_requested')) OR EXISTS(SELECT 1 FROM faultline.storage_reservations WHERE workspace_id=wid) THEN RAISE EXCEPTION 'Containment or object publication pending';END IF;
 IF EXISTS(SELECT 1 FROM faultline.verification_runs r WHERE r.workspace_id=wid AND r.case_id=cid AND NOT EXISTS(SELECT 1 FROM faultline.retention_runner_receipts j JOIN faultline.retention_requests q ON q.workspace_id=j.workspace_id AND q.id=j.request_id WHERE j.workspace_id=wid AND j.case_id=cid AND j.nonce=r.nonce AND j.job_id=r.job_id AND j.lease_id=r.fence AND j.generation=r.runner_generation AND j.state='cleaned' AND j.stopped AND j.terminal_proof_hash~'^[a-f0-9]{64}$' AND q.kind IN('case_delete','workspace_delete') AND (q.case_id=cid OR q.case_id IS NULL))) THEN RAISE EXCEPTION 'Exact runner cleanup proof required';END IF;
 IF EXISTS(SELECT 1 FROM faultline.object_references WHERE workspace_id=wid AND case_id=cid) THEN RAISE EXCEPTION 'Private object cleanup required';END IF;
 SET CONSTRAINTS ALL DEFERRED;
 DELETE FROM faultline.job_outbox WHERE workspace_id=wid AND job_id IN(SELECT id FROM faultline.jobs WHERE workspace_id=wid AND case_id=cid);
 DELETE FROM faultline.notifications WHERE workspace_id=wid AND case_id=cid;
 DELETE FROM faultline.idempotency WHERE workspace_id=wid AND case_id=cid AND operation NOT IN('case.delete','workspace.delete');
 FOREACH t IN ARRAY ARRAY['staging_catalog','redaction_previews','evidence_annotations','evidence_artifacts','verification_artifacts','verification_results','verification_runs','test_approvals','target_grants','browser_plans','experiment_candidates','comment_revisions','comments','followups','report_exports','report_versions','report_drafts','analytic_results','analytic_plans','model_calls','model_proposals','model_budget_extensions','model_budgets','integration_capture_artifacts','integration_captures','comparisons','metric_versions','canonical_events','snapshots','mappings','imports','job_events','jobs','budgets','case_storage','storage_reservations','object_references','evidence','hypotheses','case_redaction_keys','case_revisions'] LOOP
  EXECUTE format('DELETE FROM faultline.%I WHERE workspace_id=$1 AND case_id=$2',t) USING wid,cid;
 END LOOP;
 DELETE FROM faultline.cases WHERE workspace_id=wid AND id=cid;
 UPDATE faultline.audit SET details=jsonb_build_object('case_id',cid,'content_removed',true) WHERE workspace_id=wid AND details->>'case_id'=cid::text;
 RETURN true;
END $fn$;
CREATE OR REPLACE FUNCTION faultline.purge_workspace_data() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,faultline,auth AS $fn$
DECLARE wid uuid:=current_setting('faultline.workspace_id',true)::uuid;cid uuid;t text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM faultline.workspaces WHERE id=wid AND deletion_requested_at IS NOT NULL) THEN RAISE EXCEPTION 'Deletion intent required';END IF;
 IF EXISTS(SELECT 1 FROM faultline.jobs WHERE workspace_id=wid AND status IN('queued','running','cancel_requested')) OR EXISTS(SELECT 1 FROM faultline.provider_operations WHERE workspace_id=wid AND status IN('queued','running','cancel_requested')) OR EXISTS(SELECT 1 FROM faultline.storage_reservations WHERE workspace_id=wid) THEN RAISE EXCEPTION 'Containment or object publication pending';END IF;
 SET CONSTRAINTS ALL DEFERRED;
 FOR cid IN SELECT id FROM faultline.cases WHERE workspace_id=wid LOOP PERFORM faultline.purge_case_data(cid);END LOOP;
 DELETE FROM auth.pending_commands WHERE token_hash IN(SELECT token_hash FROM faultline.invitations WHERE workspace_id=wid);
 DELETE FROM auth.enrollment_capabilities WHERE workspace_id=wid;
 FOREACH t IN ARRAY ARRAY['staging_catalog','secret_replacements','export_declarations','source_identity_policies','source_connections','model_profiles','model_budgets','secret_versions','secrets','provider_operations','sources','invitations','workspace_policies','notifications'] LOOP EXECUTE format('DELETE FROM faultline.%I WHERE workspace_id=$1',t) USING wid;END LOOP;
 DELETE FROM faultline.idempotency WHERE workspace_id=wid AND operation NOT IN('case.delete','workspace.delete');
 UPDATE faultline.workspaces SET name='Deleted workspace' WHERE id=wid;
 UPDATE faultline.audit SET details=jsonb_build_object('scope','workspace_deleted','content_removed',true) WHERE workspace_id=wid;
 RETURN true;
END $fn$;
DO $grants$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['staging_catalog','case_redaction_keys','redaction_previews','model_budget_extensions','secret_replacements','evidence_annotations','evidence_artifacts','verification_artifacts','verification_results','verification_runs','test_approvals','target_grants','browser_plans','experiment_candidates','comment_revisions','comments','followups','report_exports','report_versions','report_drafts','analytic_results','analytic_plans','model_calls','model_proposals','model_budgets','integration_capture_artifacts','integration_captures','comparisons','metric_versions','canonical_events','snapshots','mappings','imports','job_events','jobs','budgets','case_storage','storage_reservations','object_references','evidence','hypotheses','case_revisions','cases','notifications','source_identity_policies','sources','export_declarations','source_connections','model_profiles','secret_versions','secrets','provider_operations','invitations','idempotency','workspace_policies','job_outbox','retention_runner_receipts','retention_requests'] LOOP
 EXECUTE format('GRANT SELECT,DELETE ON faultline.%I TO faultline_authority',t);
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='faultline' AND tablename=t AND policyname='purge_authority') THEN EXECUTE format('CREATE POLICY purge_authority ON faultline.%I TO faultline_authority USING(true) WITH CHECK(true)',t);END IF;
END LOOP;END $grants$;
GRANT UPDATE(details) ON faultline.audit TO faultline_authority;
GRANT DELETE ON auth.pending_commands,auth.enrollment_capabilities TO faultline_authority;
ALTER FUNCTION faultline.purge_case_data(uuid) OWNER TO faultline_authority;
ALTER FUNCTION faultline.purge_workspace_data() OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION faultline.purge_case_data(uuid),faultline.purge_workspace_data() TO faultline_api;
REVOKE DELETE ON faultline.canonical_events FROM faultline_api;
