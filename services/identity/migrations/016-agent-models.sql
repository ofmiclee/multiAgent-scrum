ALTER TABLE mas_business_agent ADD COLUMN model text CHECK (model IS NULL OR (length(model) BETWEEN 1 AND 120 AND model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'));
ALTER TABLE mas_business_agent_creation ADD COLUMN model text;
ALTER TABLE mas_business_runner_device ADD COLUMN model_catalogs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE mas_business_runner_device ADD COLUMN model_catalog_session text;
