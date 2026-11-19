-- Direct tasks have a publication receipt but no fabricated source Story.
ALTER TABLE mas_business_task_publication ALTER COLUMN story_id DROP NOT NULL;
ALTER TABLE mas_business_task_publication ALTER COLUMN story_version DROP NOT NULL;
ALTER TABLE mas_business_task_publication ADD CONSTRAINT publication_story_pair
  CHECK ((story_id IS NULL) = (story_version IS NULL));
ALTER TABLE mas_business_task_publication ADD FOREIGN KEY (project_id,board_id)
  REFERENCES mas_business_board(project_id,id);
ALTER TABLE mas_business_task ADD COLUMN source text NOT NULL DEFAULT 'story' CHECK (source IN ('story','direct'));
ALTER TABLE mas_business_task DROP CONSTRAINT mas_business_task_title_check;
ALTER TABLE mas_business_task ADD CONSTRAINT mas_business_task_title_check
  CHECK ((source='direct' AND title='') OR (source='story' AND length(title) BETWEEN 1 AND 200 AND title=btrim(title)));
ALTER TABLE mas_business_task DROP CONSTRAINT mas_business_task_required_capabilities_check;
ALTER TABLE mas_business_task ADD CONSTRAINT mas_business_task_required_capabilities_check
  CHECK (cardinality(required_capabilities) BETWEEN CASE WHEN source='direct' THEN 0 ELSE 1 END AND 10 AND array_position(required_capabilities,NULL) IS NULL);

CREATE TABLE mas_business_body_image (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  author_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_hash text NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 10485760),
  committed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mas_business_body_image_project ON mas_business_body_image(project_id);
CREATE INDEX mas_business_body_image_draft ON mas_business_body_image(author_id,created_at) WHERE NOT committed;
