CREATE TABLE mas_identity_profile (
  identity_id text PRIMARY KEY REFERENCES mas_identity_user(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  signature text NOT NULL DEFAULT '' CHECK (char_length(signature) <= 200),
  avatar bytea CHECK (octet_length(avatar) <= 1048576),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
