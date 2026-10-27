-- Restore the exact API mutation columns used by the durable agent lifecycle.
-- Older local/hosted installs may have created the agent tables before these
-- column-level grants were included in the original slice.
GRANT UPDATE(status,updated_at)
  ON faultline.agent_sessions TO faultline_api;

GRANT UPDATE(job_id,status,response,input_hash,error_code,updated_at,memory_retrieval_id)
  ON faultline.agent_turns TO faultline_api;

GRANT UPDATE(status,target_job_id,approved_by,approved_at,updated_at,tool_result,reflection_turn_id,last_error_code)
  ON faultline.agent_actions TO faultline_api;
