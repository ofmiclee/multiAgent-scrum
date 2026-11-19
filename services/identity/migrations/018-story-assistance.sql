-- Human stories receive durable AI proposals, never synthetic execution tasks.
CREATE TABLE mas_business_story_assistance (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  story_id uuid NOT NULL,
  story_version integer NOT NULL,
  requester_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','draft','failed')),
  calls integer NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 4),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  proposal jsonb,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(issues)='array'),
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(story_id,story_version) REFERENCES mas_business_story_revision(story_id,version),
  UNIQUE(requester_id,request_id)
);
CREATE UNIQUE INDEX mas_story_assistance_one_live ON mas_business_story_assistance(story_id) WHERE state IN ('queued','running');
ALTER TABLE mas_business_work_attempt ALTER COLUMN work_id DROP NOT NULL;
ALTER TABLE mas_business_work_attempt ADD COLUMN story_job_id uuid REFERENCES mas_business_story_assistance(id);
ALTER TABLE mas_business_work_attempt ADD CONSTRAINT mas_attempt_one_target CHECK((work_id IS NOT NULL)::int+(story_job_id IS NOT NULL)::int=1);
CREATE UNIQUE INDEX mas_story_attempt_fence ON mas_business_work_attempt(story_job_id,fence) WHERE story_job_id IS NOT NULL;
CREATE UNIQUE INDEX mas_story_attempt_one_live ON mas_business_work_attempt(story_job_id) WHERE story_job_id IS NOT NULL AND state IN ('assigned','running');
