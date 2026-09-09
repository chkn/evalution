// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

// GENERATED FILE — do not edit by hand. Regenerate with
// `npm run db:generate && npm run db:bundle`
// (see scripts/generate-migration-bundle.ts).

import type { MigrationMeta } from "drizzle-orm/migrator";

/** Every migration under `src/trace/db/migrations/`, in apply order. */
export const bundledMigrations: MigrationMeta[] = [
  {
    "name": "20260909125011_motionless_pandemic",
    "hash": "55a419473bbb865ae7a9bf8f65a3c4c0fa4474987ec267bc7d3ca74684a96fe7",
    "folderMillis": 1788958211000,
    "bps": true,
    "sql": [
      "CREATE TABLE `annotations` (\n\t`id` text PRIMARY KEY,\n\t`trace_id` text NOT NULL,\n\t`span_id` text,\n\t`kind` text NOT NULL,\n\t`note` text NOT NULL,\n\t`source` text NOT NULL,\n\t`created_at` real NOT NULL,\n\tCONSTRAINT `fk_annotations_trace_id_traces_id_fk` FOREIGN KEY (`trace_id`) REFERENCES `traces`(`id`) ON DELETE CASCADE\n);\n",
      "\nCREATE TABLE `spans` (\n\t`id` text PRIMARY KEY,\n\t`trace_id` text NOT NULL,\n\t`parent_id` text,\n\t`name` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`start_time` real NOT NULL,\n\t`end_time` real,\n\t`status` text,\n\t`error_message` text,\n\t`llm_provider` text,\n\t`llm_model` text,\n\t`llm_prompt_tokens` integer,\n\t`llm_completion_tokens` integer,\n\t`llm_total_tokens` integer,\n\t`llm_cost` real,\n\t`llm_messages` text,\n\t`llm_output` text,\n\t`llm_parameters` text,\n\t`attributes` text,\n\t`prompt` text,\n\t`tool` text\n);\n",
      "\nCREATE TABLE `traces` (\n\t`id` text PRIMARY KEY,\n\t`provider_id` text,\n\t`name` text NOT NULL,\n\t`start_time` real NOT NULL,\n\t`end_time` real,\n\t`status` text NOT NULL,\n\t`attributes` text\n);\n",
      "\nCREATE INDEX `idx_annotations_trace_id` ON `annotations` (`trace_id`);",
      "\nCREATE INDEX `idx_spans_trace_id` ON `spans` (`trace_id`);",
      "\nCREATE INDEX `idx_spans_parent_id` ON `spans` (`parent_id`);",
      "\nCREATE INDEX `idx_traces_start_time` ON `traces` (`start_time`);",
      "\nCREATE TRIGGER `trg_spans_cascade_delete_trace` AFTER DELETE ON `traces` BEGIN DELETE FROM `spans` WHERE `trace_id` = OLD.`id`; END;"
    ]
  }
];
