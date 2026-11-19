-- Private bounded byte storage; never served as public objects. Application
-- capabilities and domain validators remain mandatory before publication/read.
CREATE TABLE mas_artifact_upload (
  id uuid PRIMARY KEY,
  scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 50331648),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mas_artifact_chunk (
  upload_id uuid NOT NULL REFERENCES mas_artifact_upload(id),
  offset_bytes integer NOT NULL CHECK(offset_bytes>=0 AND offset_bytes%262144=0),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 262144),
  PRIMARY KEY(upload_id,offset_bytes)
);
CREATE TABLE mas_business_code_result_artifact (
  attempt_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  runner_id uuid NOT NULL,
  fence integer NOT NULL CHECK(fence>0),
  reference jsonb NOT NULL CHECK(jsonb_typeof(reference)='object'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 50331648),
  published boolean NOT NULL DEFAULT false
);
CREATE INDEX mas_code_result_project ON mas_business_code_result_artifact(project_id);
