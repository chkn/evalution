// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

// GENERATED FILE — do not edit by hand. Regenerate with
// `npm run db:generate && npm run db:bundle`
// (see scripts/generate-migration-bundle.ts).

import type { MigrationMeta } from "drizzle-orm/migrator";

/** Every migration under `src/prompt/variations/db/migrations/`, in apply order. */
export const bundledMigrations: MigrationMeta[] = [
  {
    name: "20260929123404_concerned_switch",
    hash: "9998d655c263eab83809e3c85bc935f57a4b15435638681103ad953387f63c83",
    folderMillis: 1790685244000,
    bps: true,
    sql: [
      "-- SPDX\u002DLicense-Identifier: AGPL-3.0-only\n-- Copyright (c) 2026 Alexander Corrado\n\nCREATE TABLE `variation_names` (\n\t`prompt_id` text NOT NULL,\n\t`name` text NOT NULL,\n\t`variation_id` text NOT NULL,\n\t`created_at` real NOT NULL,\n\tCONSTRAINT `variation_names_pk` PRIMARY KEY(`prompt_id`, `name`),\n\tCONSTRAINT `fk_variation_names_variation_id_variations_id_fk` FOREIGN KEY (`variation_id`) REFERENCES `variations`(`id`)\n);\n",
      "\nCREATE TABLE `variations` (\n\t`id` text PRIMARY KEY,\n\t`prompt_id` text NOT NULL,\n\t`global_id` text,\n\t`base_version` text DEFAULT '' NOT NULL,\n\t`updates` text NOT NULL,\n\t`base_values` text NOT NULL,\n\t`wip` integer DEFAULT 0 NOT NULL,\n\t`on_head` integer DEFAULT 0 NOT NULL,\n\t`origin_name` text,\n\t`pending` text,\n\t`created_at` real NOT NULL,\n\t`updated_at` real NOT NULL\n);\n",
      '\nCREATE UNIQUE INDEX `uq_variations_frozen` ON `variations` (`prompt_id`,`base_version`,`updates`,`base_values`) WHERE "variations"."wip" = 0;',
      '\nCREATE UNIQUE INDEX `uq_variations_wip` ON `variations` (`prompt_id`,`base_version`) WHERE "variations"."wip" = 1 and "variations"."on_head" = 0;',
      '\nCREATE UNIQUE INDEX `uq_variations_head_wip` ON `variations` (`prompt_id`) WHERE "variations"."wip" = 1 and "variations"."on_head" = 1;',
    ],
  },
];
