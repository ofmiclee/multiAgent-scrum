-- Explicit migration. Historical join dates remain unknown rather than fabricated.
ALTER TABLE mas_business_project_member DROP CONSTRAINT mas_business_project_member_role_check;
ALTER TABLE mas_business_project_member ADD CHECK (role IN ('owner','manager','member','viewer'));
ALTER TABLE mas_business_project_member ADD COLUMN joined_at timestamptz;
ALTER TABLE mas_business_project_member ALTER COLUMN joined_at SET DEFAULT now();
ALTER TABLE mas_business_membership ADD COLUMN joined_at timestamptz,
  ADD COLUMN invited_by uuid REFERENCES mas_business_user(id);
ALTER TABLE mas_business_membership ALTER COLUMN joined_at SET DEFAULT now();

CREATE TABLE mas_business_invite_link (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES mas_business_organization(id),
  issued_by uuid NOT NULL REFERENCES mas_business_user(id),
  issuer_version integer NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 500),
  hours integer NOT NULL CHECK (hours BETWEEN 1 AND 48),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  approval_required boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(issued_by,request_id)
);
ALTER TABLE mas_business_join_request ADD COLUMN invite_link_id uuid REFERENCES mas_business_invite_link(id);
CREATE TABLE mas_business_invite_claim (
  link_id uuid NOT NULL REFERENCES mas_business_invite_link(id),
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  join_request_id uuid REFERENCES mas_business_join_request(id),
  PRIMARY KEY(link_id,user_id)
);

CREATE TABLE mas_business_member_add_command (
  issued_by uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES mas_business_organization(id),
  target_id uuid NOT NULL REFERENCES mas_business_user(id),
  email text NOT NULL,
  PRIMARY KEY(issued_by,request_id)
);
