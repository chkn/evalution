-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (c) 2026 Alexander Corrado

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
	`base_version` text DEFAULT '' NOT NULL,
	`updates` text NOT NULL,
	`base_values` text NOT NULL,
	`wip` integer DEFAULT 0 NOT NULL,
	`on_head` integer DEFAULT 0 NOT NULL,
	`origin_name` text,
	`pending` text,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_variations_frozen` ON `variations` (`prompt_id`,`base_version`,`updates`,`base_values`) WHERE "variations"."wip" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_variations_wip` ON `variations` (`prompt_id`,`base_version`) WHERE "variations"."wip" = 1 and "variations"."on_head" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_variations_head_wip` ON `variations` (`prompt_id`) WHERE "variations"."wip" = 1 and "variations"."on_head" = 1;