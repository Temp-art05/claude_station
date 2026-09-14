CREATE TABLE `workflow_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`default_value` text DEFAULT '' NOT NULL,
	`help` text DEFAULT '' NOT NULL,
	`options` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_inputs_unique` ON `workflow_inputs` (`workflow_id`,`key`);--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `inputs` text;--> statement-breakpoint
ALTER TABLE `workflow_triggers` ADD `inputs` text;