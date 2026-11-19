-- Project-scoped human stories with immutable revisions and actor receipts.
-- Runtime services never apply this migration implicitly.
CREATE TABLE mas_business_story (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  board_id uuid NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,project_id,board_id),
  FOREIGN KEY (project_id,board_id) REFERENCES mas_business_board(project_id,id)
);

CREATE TABLE mas_business_story_revision (
  story_id uuid NOT NULL,
  project_id uuid NOT NULL,
  board_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title=btrim(title)),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 12000),
  author_id uuid NOT NULL REFERENCES mas_business_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id,version),
  FOREIGN KEY (story_id,project_id,board_id)
    REFERENCES mas_business_story(id,project_id,board_id)
);

ALTER TABLE mas_business_story ADD CONSTRAINT mas_business_story_current_revision
  FOREIGN KEY (id,current_version) REFERENCES mas_business_story_revision(story_id,version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX mas_business_story_board
  ON mas_business_story(project_id,board_id,created_at,id);

CREATE TABLE mas_business_story_command (
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  story_id uuid NOT NULL,
  story_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,request_id),
  FOREIGN KEY (story_id,story_version)
    REFERENCES mas_business_story_revision(story_id,version)
);
