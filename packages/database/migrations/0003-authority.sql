CREATE OR REPLACE FUNCTION faultline.member_summary(wid uuid,pid text) RETURNS TABLE(id text,workspace_id uuid,user_id text,name text,email text,role text,revision integer,created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline,auth AS
'SELECT m.user_id,m.workspace_id,m.user_id,u.name,u.email,m.role,m.revision,m.created_at FROM faultline.memberships m JOIN auth."user" u ON u.id=m.user_id WHERE m.workspace_id=wid AND EXISTS(SELECT 1 FROM faultline.memberships a WHERE a.workspace_id=wid AND a.user_id=pid AND a.role=''owner'') ORDER BY m.created_at,m.user_id';
REVOKE ALL ON FUNCTION faultline.member_summary(uuid,text) FROM PUBLIC;

