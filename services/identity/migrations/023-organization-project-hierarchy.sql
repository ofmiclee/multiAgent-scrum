-- Explicit migration only. Legacy identifiers remain unset for reviewed mapping.
ALTER TABLE mas_business_organization ADD COLUMN slug text UNIQUE
  CHECK (length(slug) BETWEEN 1 AND 50 AND slug ~ '^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$'),
  ADD COLUMN alias text CHECK (length(alias)<=50),
  ADD COLUMN description text CHECK (length(description)<=200),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0);
ALTER TABLE mas_business_project ADD COLUMN key text
  CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  ADD COLUMN description text CHECK (length(description)<=200),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0),
  ADD COLUMN next_story_number integer NOT NULL DEFAULT 1 CHECK (next_story_number>0),
  ADD UNIQUE (organization_id,key);
ALTER TABLE mas_business_project_member DROP CONSTRAINT mas_business_project_member_role_check;
ALTER TABLE mas_business_project_member ADD CHECK (role IN ('owner','manager','member'));
ALTER TABLE mas_business_membership ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0);
CREATE TABLE mas_business_join_request (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES mas_business_organization(id),
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid REFERENCES mas_business_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX mas_business_join_request_pending ON mas_business_join_request(organization_id,user_id) WHERE status='pending';
CREATE TABLE mas_business_join_command (
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  slug text NOT NULL,
  join_request_id uuid NOT NULL REFERENCES mas_business_join_request(id),
  PRIMARY KEY(user_id,request_id)
);
-- Serialize backfill with inserts; the deployment migration runner uses a transaction.
LOCK TABLE mas_business_story IN ACCESS EXCLUSIVE MODE;
ALTER TABLE mas_business_story ADD COLUMN number integer;
WITH numbered AS (SELECT id,row_number() OVER (PARTITION BY project_id ORDER BY created_at,id)::integer AS number FROM mas_business_story)
UPDATE mas_business_story s SET number=n.number FROM numbered n WHERE s.id=n.id;
UPDATE mas_business_project p SET next_story_number=coalesce((SELECT max(number)+1 FROM mas_business_story WHERE project_id=p.id),1);
ALTER TABLE mas_business_story ALTER COLUMN number SET NOT NULL,
  ADD CHECK (number>0), ADD UNIQUE (project_id,number);
