ALTER TABLE mas_business_agent
  ADD COLUMN routing_capabilities text[],
  ADD COLUMN difficulty_min integer NOT NULL DEFAULT 1 CHECK(difficulty_min BETWEEN 1 AND 5),
  ADD COLUMN difficulty_max integer NOT NULL DEFAULT 5 CHECK(difficulty_max BETWEEN 1 AND 5),
  ADD COLUMN routing_preference text NOT NULL DEFAULT 'balanced' CHECK(routing_preference IN ('quality','balanced','economy')),
  ADD COLUMN relative_cost integer NOT NULL DEFAULT 2 CHECK(relative_cost BETWEEN 1 AND 3),
  ADD COLUMN routing_version integer NOT NULL DEFAULT 1 CHECK(routing_version>0),
  ADD CONSTRAINT mas_agent_difficulty_order CHECK(difficulty_min<=difficulty_max);

CREATE TABLE mas_business_routing_decision (
  attempt_id uuid PRIMARY KEY REFERENCES mas_business_work_attempt(id),
  work_id uuid NOT NULL REFERENCES mas_business_work(id),
  agent_id uuid NOT NULL REFERENCES mas_business_agent(id),
  score double precision NOT NULL,
  explanation jsonb NOT NULL CHECK(jsonb_typeof(explanation)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mas_routing_decision_work ON mas_business_routing_decision(work_id,created_at DESC);
