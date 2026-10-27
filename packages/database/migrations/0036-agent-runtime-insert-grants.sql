-- Agent sessions, turns and suggestions are created by the tenant-scoped API
-- role. Reassert these table privileges for installations that created the
-- tables before the durable-agent grants were finalized.
GRANT SELECT,INSERT
  ON faultline.agent_sessions,faultline.agent_turns,faultline.agent_actions
  TO faultline_api;
