CREATE TABLE mas_business_directory_pick (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  runner_id uuid NOT NULL REFERENCES mas_business_runner_device(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','selected','cancelled','unavailable','expired')),
  session_hash text,
  encrypted_directory text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='selected')=(encrypted_directory IS NOT NULL))
);
CREATE INDEX mas_directory_pick_runner ON mas_business_directory_pick(runner_id,state,created_at);
CREATE INDEX mas_directory_pick_owner ON mas_business_directory_pick(project_id,user_id,created_at DESC);
