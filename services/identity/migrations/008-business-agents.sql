-- Device announcements are not grants. Runtime never applies this migration.
ALTER TABLE mas_business_runner_device ADD CONSTRAINT mas_runner_device_owner_unique UNIQUE(id,owner_id);
CREATE TABLE mas_business_agent (
  id uuid PRIMARY KEY,
  runner_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  profile text NOT NULL CHECK(profile IN ('demo','dsh-text')),
  enabled boolean NOT NULL DEFAULT false,
  max_concurrency integer NOT NULL DEFAULT 1 CHECK(max_concurrency=1),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  ready_until timestamptz NOT NULL,
  ready_session_hash text NOT NULL CHECK(ready_session_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(runner_id,profile), UNIQUE(id,owner_id),
  FOREIGN KEY(runner_id,owner_id) REFERENCES mas_business_runner_device(id,owner_id)
);
CREATE INDEX mas_business_agent_owner ON mas_business_agent(owner_id,id);
CREATE TABLE mas_business_agent_project (
  agent_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  enabled boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(agent_id,project_id),
  FOREIGN KEY(agent_id,owner_id) REFERENCES mas_business_agent(id,owner_id),
  FOREIGN KEY(project_id,owner_id) REFERENCES mas_business_project_member(project_id,user_id)
);
CREATE TABLE mas_business_execution_policy (
  user_id uuid PRIMARY KEY REFERENCES mas_business_user(id),
  max_concurrency integer NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 8),
  version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
