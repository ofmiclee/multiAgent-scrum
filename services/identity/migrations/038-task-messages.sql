ALTER TABLE mas_business_work_attempt ADD COLUMN message_ready_until timestamptz;

CREATE TABLE mas_business_task_message (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES mas_business_work_attempt(id),
  author_id uuid NOT NULL REFERENCES mas_business_user(id),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','delivering','delivered','rejected','unknown')),
  error text CHECK(error IN ('execution_ended','permission_revoked','rejected','unconfirmed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  acknowledged_at timestamptz
);
CREATE INDEX mas_task_message_attempt ON mas_business_task_message(attempt_id,created_at,id);
