PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
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
INSERT INTO `__new_project_memories`("id", "project_id", "title", "body", "tags", "pinned", "source", "created_at", "updated_at") SELECT "id", "project_id", "title", "body", "tags", "pinned", "source", "created_at", "updated_at" FROM `project_memories`;--> statement-breakpoint
DROP TABLE `project_memories`;--> statement-breakpoint
ALTER TABLE `__new_project_memories` RENAME TO `project_memories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_project_memories_project` ON `project_memories` (`project_id`,`pinned`);