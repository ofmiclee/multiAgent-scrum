-- Human-confirmed task inputs; no assignment or execution authority is created.
CREATE TABLE mas_business_task_publication (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  board_id uuid NOT NULL,
  story_id uuid NOT NULL,
  story_version integer NOT NULL CHECK (story_version>0),
  author_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,project_id,board_id),
  UNIQUE (story_id,story_version),
  UNIQUE (author_id,request_id),
  FOREIGN KEY (story_id,project_id,board_id) REFERENCES mas_business_story(id,project_id,board_id),
  FOREIGN KEY (story_id,story_version) REFERENCES mas_business_story_revision(story_id,version)
);
CREATE INDEX mas_business_task_publication_story
  ON mas_business_task_publication(story_id,created_at DESC,id DESC);

CREATE TABLE mas_business_task (
  id uuid PRIMARY KEY,
  publication_id uuid NOT NULL,
  project_id uuid NOT NULL,
  board_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  local_key text NOT NULL CHECK (local_key ~ '^[a-z][a-z0-9_-]{0,39}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title=btrim(title)),
  objective text NOT NULL CHECK (length(objective) BETWEEN 1 AND 4000 AND length(btrim(objective))>0),
  acceptance_criteria text NOT NULL CHECK (length(acceptance_criteria) BETWEEN 1 AND 4000 AND length(btrim(acceptance_criteria))>0),
  required_capabilities text[] NOT NULL CHECK (cardinality(required_capabilities) BETWEEN 1 AND 10 AND array_position(required_capabilities,NULL) IS NULL),
  priority text NOT NULL CHECK (priority IN ('low','normal','high')),
  status text NOT NULL DEFAULT 'pending' CHECK (status='pending'),
  UNIQUE (id,publication_id),
  UNIQUE (publication_id,position),
  UNIQUE (publication_id,local_key),
  FOREIGN KEY (publication_id,project_id,board_id)
    REFERENCES mas_business_task_publication(id,project_id,board_id)
);

CREATE TABLE mas_business_task_dependency (
  publication_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_id uuid NOT NULL,
  PRIMARY KEY (task_id,depends_on_id),
  CHECK (task_id<>depends_on_id),
  FOREIGN KEY (task_id,publication_id) REFERENCES mas_business_task(id,publication_id),
  FOREIGN KEY (depends_on_id,publication_id) REFERENCES mas_business_task(id,publication_id)
);
