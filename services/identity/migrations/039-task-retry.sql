-- Manual retries keep the input revision and assessment; each stopped attempt
-- can authorize one replacement, with an actor-scoped idempotency receipt.
ALTER TABLE mas_business_work_attempt ADD COLUMN stop_reason text CHECK(stop_reason IN ('timeout','execution_failed'));
CREATE TABLE mas_business_task_retry (
  attempt_id uuid PRIMARY KEY REFERENCES mas_business_work_attempt(id),
  task_id uuid NOT NULL REFERENCES mas_business_task(id),
  input_revision integer NOT NULL CHECK(input_revision BETWEEN 1 AND 4),
  actor_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  previous jsonb NOT NULL CHECK(jsonb_typeof(previous)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,request_id)
);
CREATE INDEX mas_task_retry_revision ON mas_business_task_retry(task_id,input_revision);
