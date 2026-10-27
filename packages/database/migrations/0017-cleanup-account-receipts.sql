CREATE TABLE faultline.retention_runner_receipts(workspace_id uuid NOT NULL,request_id uuid NOT NULL,case_id uuid NOT NULL,nonce uuid NOT NULL,job_id uuid NOT NULL,lease_id uuid NOT NULL,generation text NOT NULL,state text NOT NULL CHECK(state IN('running','stopped','containment_unknown','cleanup_pending','cleaned')),stopped boolean NOT NULL,terminal_proof_hash text,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,request_id,nonce),FOREIGN KEY(workspace_id,request_id) REFERENCES faultline.retention_requests(workspace_id,id),CHECK(NOT stopped OR terminal_proof_hash~'^[a-f0-9]{64}$'));
ALTER TABLE faultline.retention_runner_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE faultline.retention_runner_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON faultline.retention_runner_receipts USING(workspace_id::text=current_setting('faultline.workspace_id',true)) WITH CHECK(workspace_id::text=current_setting('faultline.workspace_id',true));
GRANT SELECT,INSERT ON faultline.retention_runner_receipts TO faultline_api;
GRANT UPDATE(state,stopped,terminal_proof_hash,value,updated_at) ON faultline.retention_runner_receipts TO faultline_api;
CREATE TABLE auth.account_deletion_receipts(cookie_hash text NOT NULL,key_hash text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(cookie_hash,key_hash));
REVOKE ALL ON auth.account_deletion_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON auth.account_deletion_receipts TO faultline_auth;
