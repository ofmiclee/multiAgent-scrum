-- Latest bounded public progress per execution attempt; never workflow authority.
ALTER TABLE mas_business_work_attempt
  ADD COLUMN conversation_snapshot jsonb CHECK (
    conversation_snapshot IS NULL OR
    (jsonb_typeof(conversation_snapshot)='object' AND octet_length(conversation_snapshot::text)<=65536)
  ),
  ADD COLUMN conversation_updated_at timestamptz;
