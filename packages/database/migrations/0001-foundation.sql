CREATE SCHEMA IF NOT EXISTS faultline;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS pgboss;
REVOKE ALL ON SCHEMA faultline,auth,pgboss FROM PUBLIC;
CREATE TABLE IF NOT EXISTS faultline.installation (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), bootstrapped_at timestamptz);
INSERT INTO faultline.installation(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS faultline.workspaces (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS faultline.memberships (
 workspace_id uuid NOT NULL REFERENCES faultline.workspaces(id), user_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','analyst','viewer')), revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS faultline.cases (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES faultline.workspaces(id),
 title text NOT NULL, question text NOT NULL, affected_flow text,
 active_revision_id uuid NOT NULL, lifecycle text NOT NULL DEFAULT 'open' CHECK(lifecycle IN('open','closed')),
 archived boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS faultline.case_revisions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, case_id uuid NOT NULL, parent_id uuid,
 value jsonb NOT NULL, content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,case_id,id),
 FOREIGN KEY(workspace_id,case_id) REFERENCES faultline.cases(workspace_id,id),
 FOREIGN KEY(workspace_id,case_id,parent_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id)
);
ALTER TABLE faultline.cases DROP CONSTRAINT IF EXISTS case_active_revision;
ALTER TABLE faultline.cases ADD CONSTRAINT case_active_revision FOREIGN KEY(workspace_id,id,active_revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE IF NOT EXISTS faultline.invitations (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES faultline.workspaces(id), intended_email text NOT NULL,
 role text NOT NULL CHECK(role IN('analyst','viewer')), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 claimed_by text, revoked boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth.enrollment_capabilities (
 token_hash text PRIMARY KEY, invitation_id uuid, workspace_id uuid NOT NULL, intended_email text NOT NULL,
 role text NOT NULL, mode text NOT NULL CHECK(mode IN('invitation','bootstrap')), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, workspace_name text,
 FOREIGN KEY(invitation_id) REFERENCES faultline.invitations(id)
);
CREATE TABLE IF NOT EXISTS faultline.idempotency (
 workspace_id uuid NOT NULL, principal_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
 input_hash text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,principal_id,operation,key)
);
CREATE TABLE IF NOT EXISTS faultline.audit (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, actor_id text NOT NULL, operation text NOT NULL,
 details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS faultline.jobs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, case_id uuid NOT NULL, revision_id uuid NOT NULL,
 kind text NOT NULL, input_hash text NOT NULL, input jsonb NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','waiting_for_input','cancel_requested','cancelled','succeeded','failed')),
 attempt integer NOT NULL DEFAULT 0, fence uuid, lease_until timestamptz, result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,case_id,id),
 FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id)
);
CREATE TABLE IF NOT EXISTS faultline.job_events (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id uuid NOT NULL, case_id uuid NOT NULL, job_id uuid NOT NULL,
 event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,case_id,job_id) REFERENCES faultline.jobs(workspace_id,case_id,id)
);
CREATE TABLE IF NOT EXISTS faultline.job_outbox (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, job_id uuid NOT NULL, dispatched_at timestamptz,
 dispatch_lease timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS faultline.worker_heartbeats (
 id text PRIMARY KEY, version text NOT NULL, checked_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS faultline.budgets (
 workspace_id uuid NOT NULL, case_id uuid NOT NULL, revision_id uuid NOT NULL,
 ceiling integer NOT NULL DEFAULT 100, reserved integer NOT NULL DEFAULT 0, spent integer NOT NULL DEFAULT 0,
 CHECK(reserved>=0 AND spent>=0 AND reserved+spent<=ceiling),
 PRIMARY KEY(workspace_id,case_id,revision_id),
 FOREIGN KEY(workspace_id,case_id,revision_id) REFERENCES faultline.case_revisions(workspace_id,case_id,id)
);
CREATE TABLE IF NOT EXISTS faultline.secrets (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, purpose text NOT NULL, key_version text NOT NULL,
 ciphertext text NOT NULL, revoked boolean NOT NULL DEFAULT false
);
DO $migration$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['workspaces','memberships','cases','case_revisions','invitations','idempotency','audit','jobs','job_events','budgets','secrets'] LOOP
  EXECUTE format('ALTER TABLE faultline.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE faultline.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON faultline.%I',t);
  IF t='workspaces' THEN
   EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(id::text=current_setting(''faultline.workspace_id'',true))',t);
  ELSE
   EXECUTE format('CREATE POLICY tenant_scope ON faultline.%I USING(workspace_id::text=current_setting(''faultline.workspace_id'',true)) WITH CHECK(workspace_id::text=current_setting(''faultline.workspace_id'',true))',t);
  END IF;
 END LOOP;
END $migration$;
ALTER TABLE faultline.job_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE faultline.job_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant ON faultline.job_outbox USING(workspace_id::text=current_setting('faultline.workspace_id',true)) WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true));
CREATE OR REPLACE FUNCTION faultline.member_role(wid uuid,pid text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline AS
'SELECT role FROM faultline.memberships WHERE workspace_id=wid AND user_id=pid';
CREATE OR REPLACE FUNCTION faultline.principal_workspaces(pid text) RETURNS TABLE(id uuid,name text,revision integer,created_at timestamptz,role text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline AS
'SELECT w.id,w.name,w.revision,w.created_at,m.role FROM faultline.workspaces w JOIN faultline.memberships m ON m.workspace_id=w.id WHERE m.user_id=pid ORDER BY w.created_at,w.id';
CREATE OR REPLACE FUNCTION faultline.invitation_lookup(thash text) RETURNS TABLE(id uuid,workspace_id uuid,intended_email text,role text,expires_at timestamptz,claimed_by text,revoked boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,faultline AS
'SELECT id,workspace_id,intended_email,role,expires_at,claimed_by,revoked FROM faultline.invitations WHERE token_hash=thash';
CREATE OR REPLACE FUNCTION faultline.prepare_enrollment(invhash text,caphash text) RETURNS TABLE(workspace_id uuid,intended_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,faultline,auth AS $enroll$
DECLARE inv faultline.invitations;
BEGIN
 SELECT * INTO inv FROM faultline.invitations WHERE token_hash=invhash AND NOT revoked AND claimed_by IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid invitation'; END IF;
 INSERT INTO auth.enrollment_capabilities(token_hash,invitation_id,workspace_id,intended_email,role,mode,expires_at)
 VALUES(caphash,inv.id,inv.workspace_id,inv.intended_email,inv.role,'invitation',LEAST(inv.expires_at,now()+interval '10 minutes'));
 RETURN QUERY SELECT inv.workspace_id,inv.intended_email;
END $enroll$;
CREATE OR REPLACE FUNCTION auth.pending_enrollment(thash text) RETURNS TABLE(intended_email text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,auth AS
'SELECT intended_email FROM auth.enrollment_capabilities WHERE token_hash=thash AND consumed_at IS NULL AND expires_at>now()';
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA faultline,auth FROM PUBLIC;

