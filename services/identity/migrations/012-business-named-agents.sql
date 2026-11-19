-- Preserve existing discovery IDs, readiness and grants. Named configurations
-- share their device runtime but never inherit execution consent.
ALTER TABLE mas_business_agent
  ADD COLUMN name text NOT NULL DEFAULT 'Default Agent' CHECK(char_length(name) BETWEEN 1 AND 120),
  ADD COLUMN instructions text NOT NULL DEFAULT '' CHECK(char_length(instructions)<=4000),
  ADD COLUMN is_default boolean NOT NULL DEFAULT true;
ALTER TABLE mas_business_agent DROP CONSTRAINT mas_business_agent_runner_id_profile_key;
CREATE UNIQUE INDEX mas_business_agent_default_runtime ON mas_business_agent(runner_id,profile) WHERE is_default;
CREATE TABLE mas_business_agent_creation (
  owner_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  source_agent_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  name text NOT NULL,
  instructions text NOT NULL,
  PRIMARY KEY(owner_id,request_id),
  FOREIGN KEY(source_agent_id,owner_id) REFERENCES mas_business_agent(id,owner_id),
  FOREIGN KEY(agent_id,owner_id) REFERENCES mas_business_agent(id,owner_id)
);
