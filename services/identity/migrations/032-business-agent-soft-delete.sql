-- Named Agents can be removed from management while execution history remains auditable.
ALTER TABLE mas_business_agent ADD COLUMN deleted_at timestamptz;
CREATE INDEX mas_business_agent_active_owner ON mas_business_agent(owner_id,created_at,id) WHERE deleted_at IS NULL;
