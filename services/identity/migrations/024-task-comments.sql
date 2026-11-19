CREATE TABLE mas_business_task_comment (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES mas_business_task(id),
  actor_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
  input_revision integer NOT NULL CHECK(input_revision BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,request_id)
);
CREATE INDEX mas_task_comment_page ON mas_business_task_comment(task_id,created_at DESC,id DESC);
-- Legacy attempts keep unknown provenance rather than a guessed start time/version.
ALTER TABLE mas_business_work_attempt ADD COLUMN input_revision integer CHECK(input_revision BETWEEN 1 AND 4);
ALTER TABLE mas_business_work_attempt ADD COLUMN started_at timestamptz;
ALTER TABLE mas_business_work_attempt ADD COLUMN start_input text CHECK(octet_length(start_input)<=64000);
ALTER TABLE mas_business_work_attempt ADD COLUMN start_sources jsonb;
ALTER TABLE mas_business_work_attempt ADD COLUMN report_outcome text CHECK(report_outcome IN ('review','assessment_valid','assessment_invalid','assessment_approval_required'));
CREATE TABLE mas_business_task_transition (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES mas_business_task(id),
  actor_id uuid REFERENCES mas_business_user(id),
  operation text NOT NULL CHECK(operation IN ('assessment_deadline','coordinator_resume')),
  input_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
