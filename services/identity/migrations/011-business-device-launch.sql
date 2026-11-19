-- Short-lived Web launch intents bridge a signed-in account and a native
-- credential proof. Only ticket hashes are persisted; Runner ownership remains
-- in mas_business_runner_device and still requires explicit confirmation.
CREATE TABLE mas_business_device_launch (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  ticket_hash text NOT NULL UNIQUE CHECK (ticket_hash ~ '^[a-f0-9]{64}$'),
  verification_code text NOT NULL CHECK (verification_code ~ '^[A-Z0-9]{6}$'),
  expires_at timestamptz NOT NULL,
  runner_id uuid REFERENCES mas_business_runner_device(id) ON DELETE SET NULL,
  credential_hash text CHECK (credential_hash ~ '^[a-f0-9]{64}$'),
  attached_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((credential_hash IS NULL) = (attached_at IS NULL)),
  CHECK (confirmed_at IS NULL OR runner_id IS NOT NULL)
);
CREATE INDEX mas_business_device_launch_user
  ON mas_business_device_launch(user_id,created_at,id);
