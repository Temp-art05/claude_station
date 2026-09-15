CREATE TABLE `pack_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`kind` text NOT NULL,
	`rel_path` text NOT NULL,
	`name` text NOT NULL,
	`ref_id` text,
	`status` text DEFAULT 'installed' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pack_assets_pack` ON `pack_assets` (`pack_id`,`kind`);--> statement-breakpoint
CREATE TABLE `packs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_url` text NOT NULL,
	`ref` text DEFAULT 'HEAD' NOT NULL,
	`sha` text NOT NULL,
	`installed_path` text NOT NULL,
	`scripts_enabled` integer DEFAULT false NOT NULL,
	`installed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packs_name_unique` ON `packs` (`name`);--> statement-breakpoint
CREATE INDEX `idx_packs_name` ON `packs` (`name`);--> statement-breakpoint
CREATE TABLE `session_memory_cursors` (
	`session_key` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_memory_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`source_kind` text NOT NULL,
	`session_key` text,
	`turn_id` text,
	`ref_id` text,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_memory_events_seq` ON `session_memory_events` (`project_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_memory_events_kind` ON `session_memory_events` (`project_id`,`kind`,`seq`);--> statement-breakpoint
CREATE TABLE `session_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`chat_session_id` text,
	`claude_session_id` text,
	`turn_id` text,
	`request_id` text,
	`prompt_preview` text DEFAULT '' NOT NULL,
	`markdown` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_plans_project` ON `session_plans` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_plans_request` ON `session_plans` (`request_id`);--> statement-breakpoint
ALTER TABLE `session_turns` ADD `cost_source` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `lines_added` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `lines_removed` integer DEFAULT 0 NOT NULL;