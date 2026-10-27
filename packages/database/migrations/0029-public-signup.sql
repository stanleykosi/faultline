ALTER TABLE auth.enrollment_capabilities
 DROP CONSTRAINT enrollment_capabilities_mode_check;
ALTER TABLE auth.enrollment_capabilities
 ADD CONSTRAINT enrollment_capabilities_mode_check CHECK(mode IN('invitation','bootstrap','public_signup'));

CREATE OR REPLACE FUNCTION faultline.prepare_public_signup(caphash text,address text,wid uuid,workspace_name text)
RETURNS TABLE(intended_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,auth,faultline AS $signup$
BEGIN
 IF length(trim(address))<3 OR length(address)>254 THEN RAISE EXCEPTION 'Invalid signup email'; END IF;
 IF length(trim(workspace_name))<1 OR length(workspace_name)>200 THEN RAISE EXCEPTION 'Invalid workspace name'; END IF;
 IF NOT EXISTS(SELECT 1 FROM faultline.installation WHERE singleton AND bootstrapped_at IS NOT NULL) THEN RAISE EXCEPTION 'Installation bootstrap required'; END IF;
 IF EXISTS(SELECT 1 FROM auth."user" WHERE lower(email)=lower(trim(address))) THEN RAISE EXCEPTION 'Account already exists'; END IF;
 INSERT INTO auth.enrollment_capabilities(token_hash,workspace_id,intended_email,role,mode,expires_at,workspace_name)
 VALUES(caphash,wid,lower(trim(address)),'owner','public_signup',now()+interval '10 minutes',trim(workspace_name));
 RETURN QUERY SELECT lower(trim(address));
END $signup$;

CREATE OR REPLACE FUNCTION faultline.cancel_public_signup(caphash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,auth AS
'DELETE FROM auth.enrollment_capabilities WHERE token_hash=caphash AND mode=''public_signup'' AND consumed_at IS NULL';

CREATE OR REPLACE FUNCTION auth.consume_enrollment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,auth,faultline AS $consume$
DECLARE cap auth.enrollment_capabilities; inv faultline.invitations;
BEGIN
 SELECT * INTO cap FROM auth.enrollment_capabilities WHERE token_hash=NEW."enrollmentHash" AND consumed_at IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND OR lower(cap.intended_email)<>lower(NEW.email) THEN RAISE EXCEPTION 'Enrollment capability required'; END IF;
 IF cap.mode IN('bootstrap','public_signup') THEN
  IF cap.mode='bootstrap' THEN
   PERFORM 1 FROM faultline.installation WHERE singleton AND bootstrapped_at IS NULL FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Installation already bootstrapped'; END IF;
   UPDATE faultline.installation SET bootstrapped_at=now() WHERE singleton;
  END IF;
  INSERT INTO faultline.workspaces(id,name) VALUES(cap.workspace_id,cap.workspace_name);
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

REVOKE ALL ON FUNCTION faultline.prepare_public_signup(text,text,uuid,text),faultline.cancel_public_signup(text),auth.consume_enrollment() FROM PUBLIC;
ALTER FUNCTION faultline.prepare_public_signup(text,text,uuid,text) OWNER TO faultline_authority;
ALTER FUNCTION faultline.cancel_public_signup(text) OWNER TO faultline_authority;
ALTER FUNCTION auth.consume_enrollment() OWNER TO faultline_authority;
GRANT EXECUTE ON FUNCTION faultline.prepare_public_signup(text,text,uuid,text),faultline.cancel_public_signup(text) TO faultline_api;
