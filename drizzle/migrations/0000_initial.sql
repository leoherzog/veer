CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`keyHash` text NOT NULL,
	`prefix` text NOT NULL,
	`lastUsedAt` integer,
	`createdAt` integer NOT NULL,
	`expiresAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_keys_keyHash` ON `api_keys` (`keyHash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_userId` ON `api_keys` (`userId`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_campaigns_userId` ON `campaigns` (`userId`);--> statement-breakpoint
CREATE TABLE `domain_access` (
	`hostname` text NOT NULL,
	`email` text NOT NULL,
	PRIMARY KEY(`hostname`, `email`),
	FOREIGN KEY (`hostname`) REFERENCES `domain_config`(`hostname`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `domain_config` (
	`hostname` text PRIMARY KEY NOT NULL,
	`rootRedirect` text,
	`notFoundRedirect` text,
	`accessMode` text DEFAULT 'all' NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `link_campaigns` (
	`linkId` text NOT NULL,
	`campaignId` text NOT NULL,
	PRIMARY KEY(`linkId`, `campaignId`),
	FOREIGN KEY (`linkId`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaignId`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_link_campaigns_campaignId` ON `link_campaigns` (`campaignId`);--> statement-breakpoint
CREATE TABLE `link_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`linkId` text NOT NULL,
	`date` text NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`uniqueClicks` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`linkId`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_link_stats_linkId_date` ON `link_stats` (`linkId`,`date`);--> statement-breakpoint
CREATE TABLE `link_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`linkId` text NOT NULL,
	`type` text NOT NULL,
	`matchValue` text NOT NULL,
	`destinationUrl` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`linkId`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "link_targets_type_check" CHECK("link_targets"."type" IN ('geo', 'device', 'ab'))
);
--> statement-breakpoint
CREATE INDEX `idx_link_targets_linkId` ON `link_targets` (`linkId`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`slug` text NOT NULL,
	`destinationUrl` text NOT NULL,
	`redirectType` integer DEFAULT 302 NOT NULL,
	`title` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`expiresAt` integer,
	`maxClicks` integer,
	`password` text,
	`isInternal` integer DEFAULT false NOT NULL,
	`ogTitle` text,
	`ogDescription` text,
	`ogImage` text,
	`paramForwarding` integer DEFAULT false NOT NULL,
	`domainHostname` text,
	`teamId` text,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domainHostname`) REFERENCES `domain_config`(`hostname`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_links_slug_domain` ON `links` (`slug`,`domainHostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_links_slug_default` ON `links` (`slug`) WHERE "links"."domainHostname" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_links_userId` ON `links` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_links_domainHostname` ON `links` (`domainHostname`);--> statement-breakpoint
CREATE INDEX `idx_links_teamId` ON `links` (`teamId`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`publicKey` text NOT NULL,
	`userId` text NOT NULL,
	`credentialID` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`deviceType` text NOT NULL,
	`backedUp` integer DEFAULT false NOT NULL,
	`transports` text,
	`createdAt` integer,
	`aaguid` text,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credentialID_idx` ON `passkey` (`credentialID`);--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`userId`);--> statement-breakpoint
CREATE TABLE `public_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`linkId` text NOT NULL,
	`token` text NOT NULL,
	`isEnabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`linkId`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_public_reports_token` ON `public_reports` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_public_reports_linkId` ON `public_reports` (`linkId`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_idx` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `team_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_invites_role_check" CHECK("team_invites"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE INDEX `idx_team_invites_teamId` ON `team_invites` (`teamId`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_invites_token` ON `team_invites` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_invites_teamId_email` ON `team_invites` (`teamId`,`email`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joinedAt` integer NOT NULL,
	PRIMARY KEY(`teamId`, `userId`),
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_members_role_check" CHECK("team_members"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE INDEX `idx_team_members_userId` ON `team_members` (`userId`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_teams_slug` ON `teams` (`slug`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`maxLinks` integer
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
