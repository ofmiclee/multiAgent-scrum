-- Personal devices belong to verified business users, not preview personas.
-- Apply explicitly; runtime requests never create or upgrade tables.
CREATE TABLE mas_business_runner_device (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES mas_business_user(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  credential_hash text NOT NULL CHECK (credential_hash ~ '^[a-f0-9]{64}$'),
  pairing_hash text UNIQUE CHECK (pairing_hash ~ '^[a-f0-9]{64}$'),
  pairing_until timestamptz,
  revoked_at timestamptz,
  session_hash text CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  session_until timestamptz,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((session_hash IS NULL) = (session_until IS NULL)),
  CHECK (owner_id IS NOT NULL OR (session_hash IS NULL AND revoked_at IS NULL)),
  CHECK (revoked_at IS NULL OR session_hash IS NULL),
  CHECK ((owner_id IS NULL AND pairing_until IS NOT NULL AND pairing_hash IS NOT NULL)
    OR (owner_id IS NOT NULL AND pairing_until IS NULL))
);
CREATE INDEX mas_business_runner_owner ON mas_business_runner_device(owner_id,created_at,id);
