-- Explicit isolated MAS onboarding tables. Not the preview aggregate or full
-- production workflow schema. Apply after 001 with a separate migration role.
CREATE TABLE mas_business_user (
  id uuid PRIMARY KEY,
  identity_id text NOT NULL UNIQUE REFERENCES mas_identity_user(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mas_business_organization (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by uuid NOT NULL REFERENCES mas_business_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mas_business_membership (
  organization_id uuid NOT NULL REFERENCES mas_business_organization(id),
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  role text NOT NULL CHECK (role IN ('owner','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  PRIMARY KEY (organization_id,user_id)
);
CREATE INDEX mas_business_membership_user ON mas_business_membership (user_id);
CREATE TABLE mas_business_onboarding_command (
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  organization_id uuid NOT NULL REFERENCES mas_business_organization(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,request_id)
);
