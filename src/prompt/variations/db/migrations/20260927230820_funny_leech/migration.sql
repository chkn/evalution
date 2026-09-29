-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (c) 2026 Alexander Corrado

CREATE TABLE `blobs` (
	`sha256` text PRIMARY KEY,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_snapshots` (
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` real NOT NULL,
	CONSTRAINT `file_snapshots_pk` PRIMARY KEY(`path`, `sha256`),
	CONSTRAINT `fk_file_snapshots_sha256_blobs_sha256_fk` FOREIGN KEY (`sha256`) REFERENCES `blobs`(`sha256`)
);
--> statement-breakpoint
CREATE TABLE `variation_names` (
	`prompt_id` text NOT NULL,
	`name` text NOT NULL,
	`variation_id` text NOT NULL,
	`created_at` real NOT NULL,
	CONSTRAINT `variation_names_pk` PRIMARY KEY(`prompt_id`, `name`),
	CONSTRAINT `fk_variation_names_variation_id_variations_id_fk` FOREIGN KEY (`variation_id`) REFERENCES `variations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `variations` (
	`id` text PRIMARY KEY,
	`prompt_id` text NOT NULL,
	`global_id` text,
	`base_version` text NOT NULL,
	`updates` text NOT NULL,
	`wip` integer DEFAULT 0 NOT NULL,
	`on_head` integer DEFAULT 0 NOT NULL,
	`origin_name` text,
	`pending` text,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_variations_frozen` ON `variations` (`prompt_id`,`base_version`,`updates`) WHERE "variations"."wip" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_variations_wip` ON `variations` (`prompt_id`,`base_version`) WHERE "variations"."wip" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_variations_head_wip` ON `variations` (`prompt_id`) WHERE "variations"."wip" = 1 and "variations"."on_head" = 1;