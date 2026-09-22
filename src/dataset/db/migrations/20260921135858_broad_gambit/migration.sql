-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (c) 2026 Alexander Corrado

CREATE TABLE `dataset_rows` (
	`id` text PRIMARY KEY,
	`dataset_id` text NOT NULL,
	`cells` blob NOT NULL,
	`source` blob,
	`created_at` real NOT NULL,
	CONSTRAINT `fk_dataset_rows_dataset_id_datasets_id_fk` FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`fields` text NOT NULL,
	`next_field_id` integer NOT NULL,
	`prompt` text,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dataset_rows_dataset` ON `dataset_rows` (`dataset_id`,`created_at`);