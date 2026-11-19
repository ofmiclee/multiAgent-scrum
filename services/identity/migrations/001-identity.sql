-- Explicit migration for the isolated MAS identity database/schema.
-- Runtime startup does not execute this file. Better Auth 1.7.4 native PG adapter.
CREATE TABLE mas_identity_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE mas_identity_session (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES mas_identity_user(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  "expiresAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX mas_identity_session_user ON mas_identity_session ("userId");
CREATE TABLE mas_identity_account (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES mas_identity_user(id) ON DELETE CASCADE,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  "idToken" text,
  password text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX mas_identity_account_user ON mas_identity_account ("userId");
CREATE TABLE mas_identity_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX mas_identity_verification_identifier ON mas_identity_verification (identifier);
CREATE TABLE mas_identity_rate_limit (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
