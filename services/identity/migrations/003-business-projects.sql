-- Independent projects only. No preview import or implicit organization-wide access.
CREATE TABLE mas_business_project (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES mas_business_organization(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner_id uuid NOT NULL,
  default_board_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,organization_id),
  FOREIGN KEY (organization_id,owner_id) REFERENCES mas_business_membership(organization_id,user_id)
);
CREATE TABLE mas_business_project_member (
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  PRIMARY KEY (project_id,user_id),
  FOREIGN KEY (project_id,organization_id) REFERENCES mas_business_project(id,organization_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES mas_business_membership(organization_id,user_id)
);
CREATE INDEX mas_business_project_member_user ON mas_business_project_member(user_id,project_id);
CREATE TABLE mas_business_board (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id)
);
ALTER TABLE mas_business_project ADD CONSTRAINT mas_business_project_default_board
  FOREIGN KEY (id,default_board_id) REFERENCES mas_business_board(project_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE mas_business_project_command (
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,request_id)
);
