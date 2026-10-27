ALTER TABLE faultline.mappings ADD UNIQUE(workspace_id,case_id,id);
ALTER TABLE faultline.imports ADD FOREIGN KEY(workspace_id,case_id,mapping_id) REFERENCES faultline.mappings(workspace_id,case_id,id);
ALTER TABLE faultline.imports ADD FOREIGN KEY(workspace_id,case_id,snapshot_id) REFERENCES faultline.snapshots(workspace_id,case_id,id);
ALTER TABLE faultline.imports ADD FOREIGN KEY(workspace_id,case_id,job_id) REFERENCES faultline.jobs(workspace_id,case_id,id);
ALTER TABLE faultline.metric_versions ADD FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id);
CREATE FUNCTION faultline.protect_accepted_import() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN IF OLD.snapshot_id IS NOT NULL AND ROW(NEW.stage,NEW.mapping_id,NEW.normalized_key,NEW.summary,NEW.snapshot_id,NEW.raw_key,NEW.source_id) IS DISTINCT FROM ROW(OLD.stage,OLD.mapping_id,OLD.normalized_key,OLD.summary,OLD.snapshot_id,OLD.raw_key,OLD.source_id) THEN RAISE EXCEPTION 'Accepted import is immutable';END IF;RETURN NEW;END $fn$;
CREATE TRIGGER protect_accepted_import BEFORE UPDATE ON faultline.imports FOR EACH ROW EXECUTE FUNCTION faultline.protect_accepted_import();
CREATE FUNCTION faultline.protect_frozen_metric() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN IF OLD.state='frozen' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Frozen metric is immutable';END IF;RETURN NEW;END $fn$;
CREATE TRIGGER protect_frozen_metric BEFORE UPDATE ON faultline.metric_versions FOR EACH ROW EXECUTE FUNCTION faultline.protect_frozen_metric();
REVOKE ALL ON FUNCTION faultline.protect_accepted_import(),faultline.protect_frozen_metric() FROM PUBLIC;
REVOKE UPDATE(value) ON faultline.evidence FROM faultline_api;
