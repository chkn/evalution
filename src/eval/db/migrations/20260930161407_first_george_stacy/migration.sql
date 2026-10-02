-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (c) 2026 Alexander Corrado

CREATE TABLE `eval_check_results` (
	`run_id` text NOT NULL,
	`arm_id` text NOT NULL,
	`row_id` text NOT NULL,
	`sample` integer DEFAULT 0 NOT NULL,
	`check_id` text NOT NULL,
	`outcome` text NOT NULL,
	`score` real,
	`message` text,
	`details` text,
	`duration_ms` real,
	CONSTRAINT `eval_check_results_pk` PRIMARY KEY(`run_id`, `arm_id`, `row_id`, `sample`, `check_id`),
	CONSTRAINT `fk_eval_check_results_run_id_eval_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `eval_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `eval_row_results` (
	`run_id` text NOT NULL,
	`arm_id` text NOT NULL,
	`row_id` text NOT NULL,
	`sample` integer DEFAULT 0 NOT NULL,
	`row_index` integer NOT NULL,
	`row_cells` text NOT NULL,
	`trace_provider_id` text,
	`trace_id` text,
	`version` text,
	`variation` text,
	`status` text NOT NULL,
	`error` text,
	`cost_usd` real,
	`duration_ms` real,
	`trace_incomplete` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `eval_row_results_pk` PRIMARY KEY(`run_id`, `arm_id`, `row_id`, `sample`),
	CONSTRAINT `fk_eval_row_results_run_id_eval_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `eval_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY,
	`eval_id` text NOT NULL,
	`definition` text NOT NULL,
	`arms` text NOT NULL,
	`start_version` text,
	`dirty` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`drifted` integer DEFAULT 0 NOT NULL,
	`concurrency` integer NOT NULL,
	`total` integer NOT NULL,
	`started_at` real NOT NULL,
	`ended_at` real,
	CONSTRAINT `fk_eval_runs_eval_id_evals_id_fk` FOREIGN KEY (`eval_id`) REFERENCES `evals`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `evals` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`dataset_provider_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`inputs` text NOT NULL,
	`checks` text NOT NULL,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_eval_row_results_trace` ON `eval_row_results` (`trace_provider_id`,`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_eval_runs_eval` ON `eval_runs` (`eval_id`,`started_at`);