// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

// GENERATED FILE — do not edit by hand. Regenerate with
// `npm run db:generate && npm run db:bundle`
// (see scripts/generate-migration-bundle.ts).

import type { MigrationMeta } from "drizzle-orm/migrator";

/** Every migration under `src/prompt/variations/db/migrations/`, in apply order. */
export const bundledMigrations: MigrationMeta[] = [
  {
    "name": "20260927230820_funny_leech",
    "hash": "47702c85c708cdd59ba207da367c956b08556a78784144b1b98536d1ccbcc54e",
    "folderMillis": 1790550500000,
    "bps": true,
    "sql": [
      "-- SPDX\u002DLicense-Identifier: AGPL-3.0-only\n-- Copyright (c) 2026 Alexander Corrado\n\nCREATE TABLE `blobs` (\n\t`sha256` text PRIMARY KEY,\n\t`content` text NOT NULL\n);\n",
      "\nCREATE TABLE `file_snapshots` (\n\t`path` text NOT NULL,\n\t`sha256` text NOT NULL,\n\t`created_at` real NOT NULL,\n\tCONSTRAINT `file_snapshots_pk` PRIMARY KEY(`path`, `sha256`),\n\tCONSTRAINT `fk_file_snapshots_sha256_blobs_sha256_fk` FOREIGN KEY (`sha256`) REFERENCES `blobs`(`sha256`)\n);\n",
      "\nCREATE TABLE `variation_names` (\n\t`prompt_id` text NOT NULL,\n\t`name` text NOT NULL,\n\t`variation_id` text NOT NULL,\n\t`created_at` real NOT NULL,\n\tCONSTRAINT `variation_names_pk` PRIMARY KEY(`prompt_id`, `name`),\n\tCONSTRAINT `fk_variation_names_variation_id_variations_id_fk` FOREIGN KEY (`variation_id`) REFERENCES `variations`(`id`)\n);\n",
      "\nCREATE TABLE `variations` (\n\t`id` text PRIMARY KEY,\n\t`prompt_id` text NOT NULL,\n\t`global_id` text,\n\t`base_version` text NOT NULL,\n\t`updates` text NOT NULL,\n\t`wip` integer DEFAULT 0 NOT NULL,\n\t`on_head` integer DEFAULT 0 NOT NULL,\n\t`origin_name` text,\n\t`pending` text,\n\t`created_at` real NOT NULL,\n\t`updated_at` real NOT NULL\n);\n",
      "\nCREATE UNIQUE INDEX `uq_variations_frozen` ON `variations` (`prompt_id`,`base_version`,`updates`) WHERE \"variations\".\"wip\" = 0;",
      "\nCREATE UNIQUE INDEX `uq_variations_wip` ON `variations` (`prompt_id`,`base_version`) WHERE \"variations\".\"wip\" = 1;",
      "\nCREATE UNIQUE INDEX `uq_variations_head_wip` ON `variations` (`prompt_id`) WHERE \"variations\".\"wip\" = 1 and \"variations\".\"on_head\" = 1;"
    ]
  }
];
