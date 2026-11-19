-- System-owned model directory. Runner input never controls model availability.
CREATE TABLE mas_business_model_catalog (
  vendor text NOT NULL CHECK (vendor ~ '^[a-z][a-z0-9-]{0,39}$'),
  profile text NOT NULL CHECK (profile IN ('dsh-text','codex-code')),
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  difficulty_min integer NOT NULL DEFAULT 1 CHECK (difficulty_min BETWEEN 1 AND 5),
  difficulty_max integer NOT NULL DEFAULT 4 CHECK (difficulty_max BETWEEN difficulty_min AND 5),
  relative_cost integer NOT NULL DEFAULT 2 CHECK (relative_cost BETWEEN 1 AND 3),
  is_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (vendor,profile,model),
  UNIQUE (profile,model)
);
CREATE UNIQUE INDEX mas_business_model_catalog_default_profile
  ON mas_business_model_catalog(profile) WHERE is_default;

INSERT INTO mas_business_model_catalog
  (vendor,profile,model,display_name,difficulty_min,difficulty_max,relative_cost,is_default,sort_order)
VALUES
  ('deepseek','dsh-text','deepseek-v4-flash','DeepSeek V4 Flash',1,3,1,false,10),
  ('deepseek','dsh-text','deepseek-v4-pro','DeepSeek V4 Pro',1,5,2,true,20),
  ('deepseek','dsh-text','deepseek-v4-flash-vision-exp','DeepSeek V4 Flash Vision',1,3,1,false,30),
  ('openai','codex-code','gpt-6-astra','6 Astra',1,5,3,false,10),
  ('openai','codex-code','gpt-5.6-sol','5.6 Sol',1,5,2,false,20),
  ('openai','codex-code','gpt-5.6-terra','5.6 Terra',1,4,2,true,30),
  ('openai','codex-code','gpt-5.6-luna','5.6 Luna',1,3,1,false,40),
  ('openai','codex-code','gpt-5.5','5.5',1,5,2,false,50);
