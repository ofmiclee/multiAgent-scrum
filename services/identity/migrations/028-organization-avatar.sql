ALTER TABLE mas_business_organization ADD COLUMN avatar bytea
  CHECK (octet_length(avatar) <= 1048576);
