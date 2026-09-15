-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (c) 2026 Alexander Corrado

CREATE TABLE `annotations` (
	`id` text PRIMARY KEY,
	`trace_id` text NOT NULL,
	`span_id` text,
	`kind` text NOT NULL,
	`note` text NOT NULL,
	`source` text NOT NULL,
	`created_at` real NOT NULL,
	CONSTRAINT `fk_annotations_trace_id_traces_id_fk` FOREIGN KEY (`trace_id`) REFERENCES `traces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `spans` (
	`id` text PRIMARY KEY,
	`trace_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`start_time` real NOT NULL,
	`end_time` real,
	`status` text,
	`error_message` text,
	`llm_provider` text,
	`llm_model` text,
	`llm_prompt_tokens` integer,
	`llm_completion_tokens` integer,
	`llm_total_tokens` integer,
	`llm_cost_prompt` real,
	`llm_cost_completion` real,
	`llm_messages` text,
	`llm_output` text,
	`llm_parameters` text,
	`attributes` text,
	`prompt` text,
	`tool` text
);
--> statement-breakpoint
CREATE TABLE `traces` (
	`id` text PRIMARY KEY,
	`provider_id` text,
	`name` text NOT NULL,
	`start_time` real NOT NULL,
	`end_time` real,
	`status` text NOT NULL,
	`attributes` text
);
--> statement-breakpoint
CREATE INDEX `idx_annotations_trace_id` ON `annotations` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_spans_trace_id` ON `spans` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_spans_parent_id` ON `spans` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_traces_start_time` ON `traces` (`start_time`);--> statement-breakpoint
CREATE TRIGGER `trg_spans_cascade_delete_trace` AFTER DELETE ON `traces` BEGIN DELETE FROM `spans` WHERE `trace_id` = OLD.`id`; END;