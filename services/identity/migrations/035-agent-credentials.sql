-- Metadata only. Secret material remains on the owner's Runner.
CREATE TABLE mas_business_runner_credential (
  runner_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  id text NOT NULL CHECK (id = 'legacy' OR id ~ '^[a-f0-9-]{36}$'),
  profile text NOT NULL CHECK (profile IN ('dsh-text','codex-code')),
  kind text NOT NULL CHECK (kind IN ('subscription','api-key')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  seen_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  PRIMARY KEY (runner_id,profile,id),
  FOREIGN KEY (runner_id,owner_id) REFERENCES mas_business_runner_device(id,owner_id)
);
INSERT INTO mas_business_runner_credential(runner_id,owner_id,id,profile,kind,label)
SELECT DISTINCT runner_id,owner_id,'legacy',profile,
  CASE WHEN profile='codex-code' THEN 'subscription' ELSE 'api-key' END,
  CASE WHEN profile='codex-code' THEN '本机 Codex 账号' ELSE '本机 DSH API Key' END
FROM mas_business_agent WHERE profile IN ('codex-code','dsh-text');
ALTER TABLE mas_business_agent ADD COLUMN credential_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE mas_business_work_attempt ADD COLUMN credential_id text;
ALTER TABLE mas_business_agent_creation ADD COLUMN credential_id text;
