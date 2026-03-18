CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX idx_campaigns_userId ON campaigns(userId);

CREATE TABLE link_campaigns (
  linkId TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  campaignId TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  PRIMARY KEY (linkId, campaignId)
);
CREATE INDEX idx_link_campaigns_campaignId ON link_campaigns(campaignId);

CREATE TABLE link_targets (
  id TEXT PRIMARY KEY,
  linkId TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('geo', 'device')),
  matchValue TEXT NOT NULL,
  destinationUrl TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_link_targets_linkId ON link_targets(linkId);

ALTER TABLE links ADD COLUMN paramForwarding INTEGER NOT NULL DEFAULT 0;
