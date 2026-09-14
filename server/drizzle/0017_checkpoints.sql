CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`project_path_id` text,
	`repo_path` text NOT NULL,
	`commit_sha` text NOT NULL,
	`patch_id` text,
	`committed_at` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`turn_id` text,
	`chat_session_id` text,
	`claude_session_id` text,
	`confidence` text DEFAULT 'orphan' NOT NULL,
	`score` real,
	`reason` text DEFAULT '' NOT NULL,
	`superseded_sha` text,
	`detected_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_path_id`) REFERENCES `project_paths`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`turn_id`) REFERENCES `session_turns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_checkpoints_commit` ON `checkpoints` (`repo_path`,`commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_checkpoints_project` ON `checkpoints` (`project_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `idx_checkpoints_patch` ON `checkpoints` (`patch_id`);--> statement-breakpoint
CREATE INDEX `idx_checkpoints_turn` ON `checkpoints` (`turn_id`);--> statement-breakpoint
CREATE TABLE `repo_cursors` (
	`repo_path` text PRIMARY KEY NOT NULL,
	`last_seen_sha` text,
	`last_scan_at` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`detail` text
);
