-- api_keys table
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  keyHash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  lastUsedAt INTEGER,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER
);
CREATE INDEX idx_api_keys_userId ON api_keys(userId);
CREATE UNIQUE INDEX idx_api_keys_keyHash ON api_keys(keyHash);

-- public_reports table
CREATE TABLE public_reports (
  id TEXT PRIMARY KEY,
  linkId TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  isEnabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_public_reports_token ON public_reports(token);
CREATE UNIQUE INDEX idx_public_reports_linkId ON public_reports(linkId);
