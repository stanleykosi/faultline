-- Agent turns are immutable case-revision records. Deleting a reviewed case
-- revision during scoped purge must remove its dependent agent history first.
ALTER TABLE faultline.agent_turns DROP CONSTRAINT agent_turns_workspace_id_case_id_revision_id_fkey;
ALTER TABLE faultline.agent_turns
  ADD CONSTRAINT agent_turns_workspace_id_case_id_revision_id_fkey
  FOREIGN KEY(workspace_id,case_id,revision_id)
  REFERENCES faultline.case_revisions(workspace_id,case_id,id)
  ON DELETE CASCADE;

ALTER TABLE faultline.agent_turns
  ADD CONSTRAINT agent_turns_workspace_id_case_id_job_id_fkey
  FOREIGN KEY(workspace_id,case_id,job_id)
  REFERENCES faultline.jobs(workspace_id,case_id,id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE faultline.agent_actions
  ADD CONSTRAINT agent_actions_workspace_id_case_id_target_job_id_fkey
  FOREIGN KEY(workspace_id,case_id,target_job_id)
  REFERENCES faultline.jobs(workspace_id,case_id,id)
  DEFERRABLE INITIALLY IMMEDIATE;
