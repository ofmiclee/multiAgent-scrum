-- Keep model-directory additions separate from the initial catalog migration.
INSERT INTO mas_business_model_catalog
  (vendor,profile,model,display_name,difficulty_min,difficulty_max,relative_cost,is_default,sort_order)
VALUES
  ('openai','codex-code','gpt-6-sol','6 Sol',1,5,2,false,15),
  ('openai','codex-code','gpt-6-luna','6 Luna',1,3,1,false,35);
