ALTER TABLE mas_business_board
  ADD COLUMN archived_at timestamptz;

CREATE TABLE mas_business_board_command (
  user_id uuid NOT NULL REFERENCES mas_business_user(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create','rename','archive')),
  project_id uuid NOT NULL REFERENCES mas_business_project(id),
  board_id uuid NOT NULL,
  result_name text NOT NULL CHECK (length(result_name) BETWEEN 1 AND 120),
  result_archived boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,request_id),
  FOREIGN KEY (project_id,board_id) REFERENCES mas_business_board(project_id,id)
);
