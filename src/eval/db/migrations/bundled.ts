// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

// GENERATED FILE — do not edit by hand. Regenerate with
// `npm run db:generate && npm run db:bundle`
// (see scripts/generate-migration-bundle.ts).

import type { MigrationMeta } from "drizzle-orm/migrator";

/** Every migration under `src/eval/db/migrations/`, in apply order. */
export const bundledMigrations: MigrationMeta[] = [
  {
    "name": "20260930161407_first_george_stacy",
    "hash": "9346c56eb5b58f8abfa943cf452934cfbfdc0987a61e6dbc3cfcf03e0e2b0e92",
    "folderMillis": 1790784847000,
    "bps": true,
    "sql": [
      "-- SPDX\u002DLicense-Identifier: AGPL-3.0-only\n-- Copyright (c) 2026 Alexander Corrado\n\nCREATE TABLE `eval_check_results` (\n\t`run_id` text NOT NULL,\n\t`arm_id` text NOT NULL,\n\t`row_id` text NOT NULL,\n\t`sample` integer DEFAULT 0 NOT NULL,\n\t`check_id` text NOT NULL,\n\t`outcome` text NOT NULL,\n\t`score` real,\n\t`message` text,\n\t`details` text,\n\t`duration_ms` real,\n\tCONSTRAINT `eval_check_results_pk` PRIMARY KEY(`run_id`, `arm_id`, `row_id`, `sample`, `check_id`),\n\tCONSTRAINT `fk_eval_check_results_run_id_eval_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `eval_runs`(`id`) ON DELETE CASCADE\n);\n",
      "\nCREATE TABLE `eval_row_results` (\n\t`run_id` text NOT NULL,\n\t`arm_id` text NOT NULL,\n\t`row_id` text NOT NULL,\n\t`sample` integer DEFAULT 0 NOT NULL,\n\t`row_index` integer NOT NULL,\n\t`row_cells` text NOT NULL,\n\t`trace_provider_id` text,\n\t`trace_id` text,\n\t`version` text,\n\t`variation` text,\n\t`status` text NOT NULL,\n\t`error` text,\n\t`cost_usd` real,\n\t`duration_ms` real,\n\t`trace_incomplete` integer DEFAULT 0 NOT NULL,\n\tCONSTRAINT `eval_row_results_pk` PRIMARY KEY(`run_id`, `arm_id`, `row_id`, `sample`),\n\tCONSTRAINT `fk_eval_row_results_run_id_eval_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `eval_runs`(`id`) ON DELETE CASCADE\n);\n",
      "\nCREATE TABLE `eval_runs` (\n\t`id` text PRIMARY KEY,\n\t`eval_id` text NOT NULL,\n\t`definition` text NOT NULL,\n\t`arms` text NOT NULL,\n\t`start_version` text,\n\t`dirty` integer DEFAULT 0 NOT NULL,\n\t`status` text NOT NULL,\n\t`drifted` integer DEFAULT 0 NOT NULL,\n\t`concurrency` integer NOT NULL,\n\t`total` integer NOT NULL,\n\t`started_at` real NOT NULL,\n\t`ended_at` real,\n\tCONSTRAINT `fk_eval_runs_eval_id_evals_id_fk` FOREIGN KEY (`eval_id`) REFERENCES `evals`(`id`) ON DELETE CASCADE\n);\n",
      "\nCREATE TABLE `evals` (\n\t`id` text PRIMARY KEY,\n\t`name` text NOT NULL,\n\t`prompt` text NOT NULL,\n\t`dataset_provider_id` text NOT NULL,\n\t`dataset_id` text NOT NULL,\n\t`inputs` text NOT NULL,\n\t`checks` text NOT NULL,\n\t`created_at` real NOT NULL,\n\t`updated_at` real NOT NULL\n);\n",
      "\nCREATE INDEX `idx_eval_row_results_trace` ON `eval_row_results` (`trace_provider_id`,`trace_id`);",
      "\nCREATE INDEX `idx_eval_runs_eval` ON `eval_runs` (`eval_id`,`started_at`);"
    ]
  },
  {
    "name": "20261009093329_soft_pandemic",
    "hash": "e8916ff94f63623ce05055ed9e6522a447a24dfeac99214e6ec4c2f1efc954be",
    "folderMillis": 1791538409000,
    "bps": true,
    "sql": [
      "ALTER TABLE `eval_row_results` ADD `row_resources` text;"
    ]
  }
];
