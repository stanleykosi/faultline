ALTER TABLE faultline.model_profiles
  DROP CONSTRAINT model_profiles_provider_check;

ALTER TABLE faultline.model_profiles
  ADD CONSTRAINT model_profiles_provider_check
  CHECK(provider IN ('ollama','openai_compatible','openrouter','meterless'));

-- Keep the actual answering model separate from a Nightshift routing-mode ID.
-- Existing calls have no retrospective model identity claim.
ALTER TABLE faultline.model_calls
  ADD COLUMN model_identity text
  CHECK (model_identity IS NULL OR
    (length(model_identity) BETWEEN 1 AND 200
     AND model_identity !~ '[[:cntrl:]]'));

GRANT UPDATE(model_identity) ON faultline.model_calls TO faultline_api;
