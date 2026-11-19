-- Canonical project base repositories. Runtime request handling never applies DDL.
-- Upload IDs are server-minted publication operations, not execution attempts.
CREATE TABLE mas_business_code_repository_upload (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runner_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  reference jsonb NOT NULL CHECK (jsonb_typeof(reference)='object'),
  object_sha256 text NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 50331648),
  state text NOT NULL DEFAULT 'staging' CHECK (state IN ('staging','published','abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  abandoned_at timestamptz,
  UNIQUE (runner_id,request_id),
  UNIQUE (id,project_id,runner_id),
  FOREIGN KEY (project_id,owner_id) REFERENCES mas_business_project_member(project_id,user_id),
  FOREIGN KEY (runner_id,owner_id) REFERENCES mas_business_runner_device(id,owner_id),
  CHECK ((state='staging' AND committed_at IS NULL AND abandoned_at IS NULL)
    OR (state='published' AND committed_at IS NOT NULL AND abandoned_at IS NULL)
    OR (state='abandoned' AND committed_at IS NULL AND abandoned_at IS NOT NULL))
);
CREATE INDEX mas_business_code_repository_upload_project ON mas_business_code_repository_upload(project_id,created_at,id);

CREATE TABLE mas_business_code_repository (
  project_id uuid PRIMARY KEY REFERENCES mas_business_project(id),
  publication_id uuid NOT NULL,
  published_by_runner uuid NOT NULL,
  published_by_user uuid NOT NULL,
  reference jsonb NOT NULL CHECK (jsonb_typeof(reference)='object'),
  object_sha256 text NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 50331648),
  published_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (publication_id,project_id,published_by_runner)
    REFERENCES mas_business_code_repository_upload(id,project_id,runner_id),
  FOREIGN KEY (project_id,published_by_user)
    REFERENCES mas_business_project_member(project_id,user_id),
  FOREIGN KEY (published_by_runner,published_by_user)
    REFERENCES mas_business_runner_device(id,owner_id)
);
