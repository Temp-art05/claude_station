CREATE TABLE `workflow_trigger_seen` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_id` text NOT NULL,
	`item_key` text NOT NULL,
	`item_updated_at` text,
	`run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `workflow_triggers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_trigger_seen_unique` ON `workflow_trigger_seen` (`trigger_id`,`item_key`);--> statement-breakpoint
CREATE TABLE `workflow_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`source` text NOT NULL,
	`query` text NOT NULL,
	`repo` text,
	`enabled` integer DEFAULT false NOT NULL,
	`auto_mode` integer DEFAULT true NOT NULL,
	`ask_policy` text DEFAULT 'stop' NOT NULL,
	`poll_seconds` integer DEFAULT 120 NOT NULL,
	`cwd_path_id` text,
	`env_set_id` text,
	`last_polled_at` text,
	`last_seen_key` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_triggers_project` ON `workflow_triggers` (`project_id`);--> statement-breakpoint
ALTER TABLE `workflow_run_steps` ADD `loops` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `auto_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `ask_policy` text DEFAULT 'stop' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `deadline_at` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `assumptions` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `trigger_id` text;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `depends_on` text;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `on_fail` text;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `max_loops` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `cwd_label` text;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `isolate` integer DEFAULT false NOT NULL;