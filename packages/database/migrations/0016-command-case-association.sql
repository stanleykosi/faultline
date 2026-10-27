ALTER TABLE faultline.idempotency ADD COLUMN case_id uuid;
UPDATE faultline.idempotency SET case_id=(result->>'case_id')::uuid WHERE result->>'case_id' ~ '^[a-f0-9-]{36}$';
UPDATE faultline.idempotency SET case_id=(result#>>'{value,case_id}')::uuid WHERE case_id IS NULL AND result#>>'{value,case_id}' ~ '^[a-f0-9-]{36}$';
UPDATE faultline.idempotency d SET case_id=j.case_id FROM faultline.jobs j WHERE d.workspace_id=j.workspace_id AND d.case_id IS NULL AND (d.result->>'job_id'=j.id::text OR d.result->>'id'=j.id::text);
UPDATE faultline.idempotency d SET case_id=c.id FROM faultline.cases c WHERE d.workspace_id=c.workspace_id AND d.case_id IS NULL AND d.operation LIKE 'case.%' AND d.result->>'id'=c.id::text;
UPDATE faultline.idempotency d SET case_id=e.case_id FROM faultline.evidence_artifacts e WHERE d.workspace_id=e.workspace_id AND d.case_id IS NULL AND d.result->>'id'=e.id::text;
UPDATE faultline.idempotency d SET case_id=s.case_id FROM faultline.snapshots s WHERE d.workspace_id=s.workspace_id AND d.case_id IS NULL AND d.result->>'snapshot_id'=s.id::text;
UPDATE faultline.idempotency d SET case_id=r.case_id FROM faultline.report_exports r WHERE d.workspace_id=r.workspace_id AND d.case_id IS NULL AND d.result->>'id'=r.id::text;
CREATE INDEX idempotency_case_scope ON faultline.idempotency(workspace_id,case_id);
