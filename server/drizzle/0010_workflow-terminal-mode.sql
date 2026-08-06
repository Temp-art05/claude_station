ALTER TABLE `workflow_runs` ADD `mode` text DEFAULT 'engine' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `terminal_id` text;