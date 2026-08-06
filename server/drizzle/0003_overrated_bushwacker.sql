CREATE TABLE `project_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_workflows_unique` ON `project_workflows` (`project_id`,`workflow_id`);--> statement-breakpoint
CREATE TABLE `workflow_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`run_step_id` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`title` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_artifacts_run` ON `workflow_artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`run_step_id` text NOT NULL,
	`key` text NOT NULL,
	`question` text NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`options` text,
	`answer` text,
	`answered_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_questions_run` ON `workflow_questions` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`session_id` text,
	`command_run_id` text,
	`note` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_run_steps_unique` ON `workflow_run_steps` (`run_id`,`step_key`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`title` text NOT NULL,
	`definition` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_step_key` text,
	`cwd` text NOT NULL,
	`env_set_id` text,
	`use_worktree` integer DEFAULT false NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_project` ON `workflow_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`agent_name` text,
	`instruction` text,
	`command_name` text,
	`requires_confirm` integer DEFAULT false NOT NULL,
	`permission_mode` text,
	`max_retries` integer DEFAULT 0 NOT NULL,
	`condition` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_steps_workflow` ON `workflow_steps` (`workflow_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_name_unique` ON `workflows` (`name`);--> statement-breakpoint
CREATE INDEX `idx_workflows_folder` ON `workflows` (`folder`);--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `workflow_run_step_id` text;