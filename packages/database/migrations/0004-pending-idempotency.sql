CREATE TABLE auth.pending_commands(token_hash text NOT NULL,key text NOT NULL,input_hash text NOT NULL,result_ciphertext text NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(token_hash,key));
CREATE OR REPLACE FUNCTION faultline.prepare_enrollment(invhash text,caphash text,cmdkey text,inputhash text,resultcipher text)
RETURNS TABLE(workspace_id uuid,intended_email text,result_ciphertext text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,faultline,auth AS $enroll$
DECLARE inv faultline.invitations; old auth.pending_commands;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(invhash||':'||cmdkey,0));
 SELECT * INTO inv FROM faultline.invitations WHERE token_hash=invhash AND NOT revoked AND claimed_by IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid invitation'; END IF;
 SELECT * INTO old FROM auth.pending_commands WHERE token_hash=invhash AND key=cmdkey;
 IF FOUND THEN
  IF old.input_hash<>inputhash THEN RAISE EXCEPTION 'Idempotency conflict'; END IF;
  IF old.expires_at<=now() THEN RAISE EXCEPTION 'Pending enrollment expired'; END IF;
  RETURN QUERY SELECT inv.workspace_id,inv.intended_email,old.result_ciphertext;
 ELSE
  INSERT INTO auth.enrollment_capabilities(token_hash,invitation_id,workspace_id,intended_email,role,mode,expires_at)
  VALUES(caphash,inv.id,inv.workspace_id,inv.intended_email,inv.role,'invitation',LEAST(inv.expires_at,now()+interval '10 minutes'));
  INSERT INTO auth.pending_commands(token_hash,key,input_hash,result_ciphertext,expires_at) VALUES(invhash,cmdkey,inputhash,resultcipher,LEAST(inv.expires_at,now()+interval '10 minutes'));
  RETURN QUERY SELECT inv.workspace_id,inv.intended_email,resultcipher;
 END IF;
END $enroll$;
DROP FUNCTION faultline.prepare_enrollment(text,text);
REVOKE ALL ON FUNCTION faultline.prepare_enrollment(text,text,text,text,text) FROM PUBLIC;

