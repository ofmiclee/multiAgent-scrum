CREATE TABLE mas_business_project_files (
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  version integer NOT NULL CHECK (version > 0),
  agents_md text NOT NULL,
  public_config jsonb NOT NULL,
  encrypted_env text NOT NULL,
  created_by uuid NOT NULL REFERENCES mas_business_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,version)
);
CREATE TABLE mas_business_project_personal (
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  runner_id uuid NOT NULL REFERENCES mas_business_runner_device(id),
  version integer NOT NULL CHECK (version > 0),
  encrypted_settings text NOT NULL,
  PRIMARY KEY(project_id,user_id,runner_id)
);
CREATE TABLE mas_business_project_setup (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  runner_id uuid NOT NULL REFERENCES mas_business_runner_device(id),
  config_version integer NOT NULL,
  request_hash text NOT NULL,
  encrypted_settings text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('initialize','sync')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ready','failed')),
  session_hash text,
  lease_until timestamptz,
  result text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,config_version) REFERENCES mas_business_project_files(project_id,version)
);
CREATE UNIQUE INDEX mas_project_setup_active ON mas_business_project_setup(runner_id)
  WHERE state IN ('queued','running');
CREATE INDEX mas_project_setup_history ON mas_business_project_setup(project_id,user_id,created_at DESC);
