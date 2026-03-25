-- M7: Teams & Enterprise

-- teams table
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_teams_slug ON teams(slug);

-- team_members table
CREATE TABLE team_members (
  teamId TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  joinedAt INTEGER NOT NULL,
  PRIMARY KEY (teamId, userId)
);
CREATE INDEX idx_team_members_userId ON team_members(userId);

-- team_invites table
CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  teamId TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  token TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_team_invites_teamId ON team_invites(teamId);
CREATE UNIQUE INDEX idx_team_invites_token ON team_invites(token);
CREATE UNIQUE INDEX idx_team_invites_teamId_email ON team_invites(teamId, email);

-- Add teamId column to links
ALTER TABLE links ADD COLUMN teamId TEXT REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX idx_links_teamId ON links(teamId);

-- Add maxLinks column to user
ALTER TABLE user ADD COLUMN maxLinks INTEGER;
