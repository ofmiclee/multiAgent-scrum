-- Ephemeral, owner-scoped browser-to-Runner configuration rendezvous.
-- API keys never enter this table or the cloud HTTP service.
ALTER TABLE mas_business_runner_device
  ADD COLUMN local_config_port integer CHECK (local_config_port BETWEEN 1 AND 65535),
  ADD COLUMN local_config_token text CHECK (local_config_token ~ '^[a-f0-9]{64}$'),
  ADD COLUMN local_config_seen timestamptz;
