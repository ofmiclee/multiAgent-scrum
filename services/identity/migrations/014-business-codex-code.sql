-- Explicit schema migration only; never applied by request handling.
ALTER TABLE mas_business_agent DROP CONSTRAINT mas_business_agent_profile_check,
  ADD CONSTRAINT mas_business_agent_profile_check CHECK(profile IN ('demo','dsh-text','codex-code'));
ALTER TABLE mas_business_agent_creation DROP CONSTRAINT mas_business_agent_creation_variant_check,
  ADD CONSTRAINT mas_business_agent_creation_variant_check CHECK (
    (source_agent_id IS NOT NULL AND runner_id IS NULL AND profile IS NULL)
    OR (source_agent_id IS NULL AND runner_id IS NOT NULL AND profile IS NOT NULL AND profile IN ('dsh-text','codex-code'))
  );
ALTER TABLE mas_business_work_attempt ADD COLUMN code_context jsonb;
