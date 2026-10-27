-- External browser plans share the immutable verification tables but keep their
-- provider-neutral staging bindings separate from the browser-plan contract.
ALTER TABLE faultline.browser_plans
  ADD COLUMN external_binding jsonb;

ALTER TABLE faultline.browser_plans
  ADD CONSTRAINT external_browser_binding CHECK (
    (value->>'mode' = 'trusted_fixture' AND external_binding IS NULL)
    OR
    (value->>'mode' IN ('exploratory','verified_staging') AND jsonb_typeof(external_binding) = 'object')
  );
