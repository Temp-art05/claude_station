CREATE TABLE `project_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`knowledge_item_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_item_id`) REFERENCES `knowledge_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_knowledge_unique` ON `project_knowledge` (`project_id`,`knowledge_item_id`);--> statement-breakpoint
CREATE TABLE `project_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags` text,
	`pinned` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_memories_project` ON `project_memories` (`project_id`,`pinned`);--> statement-breakpoint
ALTER TABLE `agents` ADD `view_path` text;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `kind` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `agent_name` text;--> statement-breakpoint
ALTER TABLE `knowledge_items` ADD `folder` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_knowledge_folder` ON `knowledge_items` (`folder`);