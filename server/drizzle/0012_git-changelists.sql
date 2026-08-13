CREATE TABLE `git_changelist_files` (
	`id` text PRIMARY KEY NOT NULL,
	`changelist_id` text NOT NULL,
	`path` text NOT NULL,
	FOREIGN KEY (`changelist_id`) REFERENCES `git_changelists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_git_changelist_files_unique` ON `git_changelist_files` (`changelist_id`,`path`);--> statement-breakpoint
CREATE TABLE `git_changelists` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_git_changelists_scope` ON `git_changelists` (`project_id`,`path_id`);