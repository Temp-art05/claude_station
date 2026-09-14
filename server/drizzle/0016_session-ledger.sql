CREATE TABLE `session_capture` (
	`claude_session_id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`terminal_id` text,
	`transcript_path` text,
	`byte_offset` integer DEFAULT 0 NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`last_event_at` text,
	`updated_at` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `session_files` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`project_id` text NOT NULL,
	`project_path_id` text,
	`abs_path` text NOT NULL,
	`rel_path` text DEFAULT '' NOT NULL,
	`op` text NOT NULL,
	`source` text NOT NULL,
	`tool_name` text,
	FOREIGN KEY (`turn_id`) REFERENCES `session_turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_path_id`) REFERENCES `project_paths`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_session_files_path` ON `session_files` (`project_id`,`abs_path`);--> statement-breakpoint
CREATE INDEX `idx_session_files_turn` ON `session_files` (`turn_id`);--> statement-breakpoint
CREATE TABLE `session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`chat_session_id` text,
	`claude_session_id` text,
	`terminal_id` text,
	`workflow_run_id` text,
	`seq` integer NOT NULL,
	`cwd` text NOT NULL,
	`git_branch` text,
	`model` text,
	`prompt_text` text DEFAULT '' NOT NULL,
	`prompt_preview` text DEFAULT '' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_create_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`duration_ms` integer,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_session_turns_project` ON `session_turns` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_session_turns_chat` ON `session_turns` (`chat_session_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_turns_cli_seq` ON `session_turns` (`claude_session_id`,`seq`);