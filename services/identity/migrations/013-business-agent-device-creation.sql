-- A bound device may seed its first disabled DSH configuration before the
-- native runtime announces readiness. Existing source-Agent receipts remain.
ALTER TABLE mas_business_agent_creation
  ALTER COLUMN source_agent_id DROP NOT NULL,
  ADD COLUMN runner_id uuid,
  ADD COLUMN profile text,
  ADD CONSTRAINT mas_business_agent_creation_runner_owner_fkey
    FOREIGN KEY(runner_id,owner_id) REFERENCES mas_business_runner_device(id,owner_id),
  ADD CONSTRAINT mas_business_agent_creation_variant_check CHECK (
    (source_agent_id IS NOT NULL AND runner_id IS NULL AND profile IS NULL)
    OR
    (source_agent_id IS NULL AND runner_id IS NOT NULL AND profile IS NOT NULL AND profile='dsh-text')
  );
