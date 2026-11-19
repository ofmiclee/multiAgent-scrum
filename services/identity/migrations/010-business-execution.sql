-- Explicit execution authority; immutable publication inputs remain unchanged.
ALTER TABLE mas_business_task DROP CONSTRAINT mas_business_task_status_check;
ALTER TABLE mas_business_task ADD CONSTRAINT mas_business_task_status_check
  CHECK(status IN ('pending','assigned','running','review','done','failed'));
ALTER TABLE mas_business_agent ADD CONSTRAINT mas_agent_runner_owner_unique UNIQUE(id,runner_id,owner_id);
CREATE INDEX mas_publication_project_page ON mas_business_task_publication(project_id,created_at DESC,id DESC);
CREATE TABLE mas_business_work (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES mas_business_task(id),
  kind text NOT NULL CHECK(kind IN ('assess','execute')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','active','review','done','failed')),
  calls integer NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 4),
  result jsonb,
  approved boolean NOT NULL DEFAULT false,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(issues)='array'),
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,kind)
);
CREATE TABLE mas_business_work_attempt (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES mas_business_work(id),
  agent_id uuid NOT NULL,
  runner_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  fence integer NOT NULL CHECK(fence BETWEEN 1 AND 4),
  coordinator_version integer,
  state text NOT NULL CHECK(state IN ('assigned','running','finished','stopped')),
  lease_until timestamptz NOT NULL,
  report jsonb,
  report_hash text CHECK(report_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(work_id,fence),
  FOREIGN KEY(agent_id,runner_id,owner_id) REFERENCES mas_business_agent(id,runner_id,owner_id),
  CHECK((state IN ('finished','stopped'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX mas_work_one_unsettled_attempt ON mas_business_work_attempt(work_id) WHERE state IN ('assigned','running');
CREATE INDEX mas_work_owner_capacity ON mas_business_work_attempt(owner_id,state);
CREATE TABLE mas_business_work_review (
  attempt_id uuid PRIMARY KEY REFERENCES mas_business_work_attempt(id),
  actor_id uuid NOT NULL REFERENCES mas_business_user(id),
  decision text NOT NULL CHECK(decision IN ('accept','reject')),
  feedback text NOT NULL CHECK(length(feedback) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mas_business_assessment_approval (
  attempt_id uuid PRIMARY KEY REFERENCES mas_business_work_attempt(id),
  actor_id uuid NOT NULL REFERENCES mas_business_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mas_business_stop_confirmation (
  attempt_id uuid PRIMARY KEY REFERENCES mas_business_work_attempt(id),
  actor_id uuid NOT NULL REFERENCES mas_business_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
