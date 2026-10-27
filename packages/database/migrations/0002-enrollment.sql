ALTER TABLE auth."user" ADD COLUMN IF NOT EXISTS "enrollmentHash" text;
ALTER TABLE faultline.memberships DROP CONSTRAINT IF EXISTS membership_identity;
ALTER TABLE faultline.memberships ADD CONSTRAINT membership_identity FOREIGN KEY(user_id) REFERENCES auth."user"(id);
CREATE OR REPLACE FUNCTION auth.consume_enrollment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,auth,faultline AS $consume$
DECLARE cap auth.enrollment_capabilities; inv faultline.invitations;
BEGIN
 SELECT * INTO cap FROM auth.enrollment_capabilities WHERE token_hash=NEW."enrollmentHash" AND consumed_at IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND OR lower(cap.intended_email)<>lower(NEW.email) THEN RAISE EXCEPTION 'Enrollment capability required'; END IF;
 IF cap.mode='bootstrap' THEN
  PERFORM 1 FROM faultline.installation WHERE singleton AND bootstrapped_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Installation already bootstrapped'; END IF;
  INSERT INTO faultline.workspaces(id,name) VALUES(cap.workspace_id,cap.workspace_name);
  UPDATE faultline.installation SET bootstrapped_at=now() WHERE singleton;
 ELSE
  SELECT * INTO inv FROM faultline.invitations WHERE id=cap.invitation_id AND NOT revoked AND claimed_by IS NULL AND expires_at>now() FOR UPDATE;
  IF NOT FOUND OR inv.workspace_id<>cap.workspace_id OR inv.role<>cap.role THEN RAISE EXCEPTION 'Invitation unavailable'; END IF;
  UPDATE faultline.invitations SET claimed_by=NEW.id,revision=revision+1 WHERE id=inv.id;
 END IF;
 INSERT INTO faultline.memberships(workspace_id,user_id,role) VALUES(cap.workspace_id,NEW.id,cap.role);
 UPDATE auth.enrollment_capabilities SET consumed_at=now() WHERE token_hash=cap.token_hash;
 INSERT INTO faultline.audit(id,workspace_id,actor_id,operation,details) VALUES(gen_random_uuid(),cap.workspace_id,NEW.id,'enrollment',jsonb_build_object('mode',cap.mode,'role',cap.role));
 UPDATE auth."user" SET "enrollmentHash"=NULL WHERE id=NEW.id;
 RETURN NEW;
END $consume$;
DROP TRIGGER IF EXISTS enrollment_guard ON auth."user";
CREATE TRIGGER enrollment_guard AFTER INSERT ON auth."user" FOR EACH ROW EXECUTE FUNCTION auth.consume_enrollment();
REVOKE ALL ON FUNCTION auth.consume_enrollment() FROM PUBLIC;

