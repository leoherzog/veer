ALTER TABLE links ADD COLUMN expiresAt integer;
ALTER TABLE links ADD COLUMN maxClicks integer;
ALTER TABLE links ADD COLUMN password text;
ALTER TABLE links ADD COLUMN isInternal integer NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN ogTitle text;
ALTER TABLE links ADD COLUMN ogDescription text;
ALTER TABLE links ADD COLUMN ogImage text;
