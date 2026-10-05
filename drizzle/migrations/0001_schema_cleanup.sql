PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_link_stats` (
	`linkId` text NOT NULL,
	`date` text NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`linkId`, `date`),
	FOREIGN KEY (`linkId`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_link_stats`("linkId", "date", "clicks") SELECT "linkId", "date", "clicks" FROM `link_stats`;--> statement-breakpoint
DROP TABLE `link_stats`;--> statement-breakpoint
ALTER TABLE `__new_link_stats` RENAME TO `link_stats`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_public_reports` (
	`linkId` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`isEnabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`linkId`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_public_reports`("linkId", "token", "isEnabled", "createdAt") SELECT "linkId", "token", "isEnabled", "createdAt" FROM `public_reports`;--> statement-breakpoint
DROP TABLE `public_reports`;--> statement-breakpoint
ALTER TABLE `__new_public_reports` RENAME TO `public_reports`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_public_reports_token` ON `public_reports` (`token`);--> statement-breakpoint
DROP INDEX `idx_team_invites_teamId`;--> statement-breakpoint
DROP INDEX `idx_teams_slug`;--> statement-breakpoint
ALTER TABLE `teams` DROP COLUMN `slug`;