-- Formal organization invitations and versioned project membership.
-- Runtime services never apply this migration implicitly.
CREATE TABLE mas_business_invitation (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES mas_business_organization(id),
  email text NOT NULL CHECK (email=lower(email) AND length(email) BETWEEN 3 AND 254),
  issued_by uuid NOT NULL REFERENCES mas_business_user(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES mas_business_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='accepted')=(accepted_by IS NOT NULL))
);
CREATE INDEX mas_business_invitation_recipient
  ON mas_business_invitation(email,status,expires_at,id);
CREATE INDEX mas_business_invitation_organization
  ON mas_business_invitation(organization_id,created_at,id);

CREATE TABLE mas_business_invitation_command (
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  invitation_id uuid NOT NULL REFERENCES mas_business_invitation(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,request_id)
);

ALTER TABLE mas_business_project_member
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0);
