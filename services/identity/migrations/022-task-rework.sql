-- Explicit Owner revisions retain the same work identities and monotonic fences.
ALTER TABLE mas_business_task ADD COLUMN input_revision integer NOT NULL DEFAULT 1 CHECK(input_revision BETWEEN 1 AND 4);
ALTER TABLE mas_business_work DROP CONSTRAINT mas_business_work_calls_check;
ALTER TABLE mas_business_work ADD CONSTRAINT mas_business_work_calls_check CHECK(calls BETWEEN 0 AND 16);
ALTER TABLE mas_business_work ADD COLUMN round_start_calls integer NOT NULL DEFAULT 0 CHECK(round_start_calls BETWEEN 0 AND calls);
ALTER TABLE mas_business_work_attempt DROP CONSTRAINT mas_business_work_attempt_fence_check;
ALTER TABLE mas_business_work_attempt ADD CONSTRAINT mas_business_work_attempt_fence_check CHECK(fence BETWEEN 1 AND 16);
CREATE TABLE mas_business_task_rework (
  task_id uuid NOT NULL REFERENCES mas_business_task(id),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 3),
  actor_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  previous jsonb NOT NULL CHECK(jsonb_typeof(previous)='object'),
  work jsonb NOT NULL CHECK(jsonb_typeof(work)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,revision),
  UNIQUE(actor_id,request_id)
);
