ALTER TABLE mas_business_project ADD CONSTRAINT mas_project_owner_unique UNIQUE(id,owner_id);
CREATE TABLE mas_business_project_coordinator (
  project_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  agent_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  last_resume_version integer,
  FOREIGN KEY(project_id,owner_id) REFERENCES mas_business_project(id,owner_id),
  FOREIGN KEY(agent_id,owner_id) REFERENCES mas_business_agent(id,owner_id)
);
