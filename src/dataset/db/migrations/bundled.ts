// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

// GENERATED FILE — do not edit by hand. Regenerate with
// `npm run db:generate && npm run db:bundle`
// (see scripts/generate-migration-bundle.ts).

import type { MigrationMeta } from "drizzle-orm/migrator";

/** Every migration under `src/dataset/db/migrations/`, in apply order. */
export const bundledMigrations: MigrationMeta[] = [
  {
    "name": "20260921135858_broad_gambit",
    "hash": "97b2057ebe26df83e0dcd08105ebb2bee08aaf6b7cef9a2b3d5cd17c29deaf63",
    "folderMillis": 1789999138000,
    "bps": true,
    "sql": [
      "-- SPDX\u002DLicense-Identifier: AGPL-3.0-only\n-- Copyright (c) 2026 Alexander Corrado\n\nCREATE TABLE `dataset_rows` (\n\t`id` text PRIMARY KEY,\n\t`dataset_id` text NOT NULL,\n\t`cells` blob NOT NULL,\n\t`source` blob,\n\t`created_at` real NOT NULL,\n\tCONSTRAINT `fk_dataset_rows_dataset_id_datasets_id_fk` FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON DELETE CASCADE\n);\n",
      "\nCREATE TABLE `datasets` (\n\t`id` text PRIMARY KEY,\n\t`name` text NOT NULL,\n\t`fields` text NOT NULL,\n\t`next_field_id` integer NOT NULL,\n\t`prompt` text,\n\t`created_at` real NOT NULL,\n\t`updated_at` real NOT NULL\n);\n",
      "\nCREATE INDEX `idx_dataset_rows_dataset` ON `dataset_rows` (`dataset_id`,`created_at`);"
    ]
  },
  {
    "name": "20261008131520_row_resources",
    "hash": "3d47cdd5b4a04ceef5601b30f690fc37da4ff071e6ce6c0af10be84c8ffd23e7",
    "folderMillis": 1791465320000,
    "bps": true,
    "sql": [
      "-- SPDX\u002DLicense-Identifier: AGPL-3.0-only\n-- Copyright (c) 2026 Alexander Corrado\n\nALTER TABLE `dataset_rows` ADD `resources` blob;\n"
    ]
  }
];
