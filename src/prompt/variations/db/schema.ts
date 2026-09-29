// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Drizzle sqlite-core schema backing {@link TursoVariationStore}. See
 * `specs/prompt-versions-and-variations.md` §E. fs-free by construction, like
 * the trace and dataset schemas.
 */

import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Every variation, frozen or WIP. A frozen row is unique by (prompt, base,
 * canonical updates, the values they overwrite); there is at most one WIP per
 * (prompt, old version), and at most one head WIP per prompt.
 */
export const variations = sqliteTable(
  "variations",
  {
    /** `var_` + a short random id. */
    id: text("id").primaryKey(),
    /** The prompt's provider-scoped id, as of the base. */
    promptId: text("prompt_id").notNull(),
    /** The prompt's `prompts()` id, when it has one. */
    globalId: text("global_id"),
    /**
     * The commit the variation was made against, or `''` for none — so it
     * takes part in the unique indexes, which a NULL wouldn't.
     */
    baseVersion: text("base_version").notNull().default(""),
    /** Canonical JSON `NormalizedPromptUpdates` — see `serializeUpdates`. */
    updates: text("updates").notNull(),
    /** Canonical JSON `FieldValues`: what the updates overwrite. */
    baseValues: text("base_values").notNull(),
    wip: integer("wip").notNull().default(0),
    /** For a WIP: whether it holds the unsaved edits to head. */
    onHead: integer("on_head").notNull().default(0),
    /** For a WIP opened from a named variation: that name. */
    originName: text("origin_name"),
    /** For a WIP: JSON `PendingConflicts` awaiting resolution. */
    pending: text("pending"),
    /** Creation timestamp (ms). */
    createdAt: real("created_at").notNull(),
    /** Last-change timestamp (ms). */
    updatedAt: real("updated_at").notNull(),
  },
  t => [
    uniqueIndex("uq_variations_frozen")
      .on(t.promptId, t.baseVersion, t.updates, t.baseValues)
      .where(sql`${t.wip} = 0`),
    uniqueIndex("uq_variations_wip")
      .on(t.promptId, t.baseVersion)
      .where(sql`${t.wip} = 1 and ${t.onHead} = 0`),
    uniqueIndex("uq_variations_head_wip")
      .on(t.promptId)
      .where(sql`${t.wip} = 1 and ${t.onHead} = 1`),
  ],
);

/** Names point at variations; a variation doesn't carry its names. */
export const variationNames = sqliteTable(
  "variation_names",
  {
    promptId: text("prompt_id").notNull(),
    name: text("name").notNull(),
    variationId: text("variation_id")
      .notNull()
      .references(() => variations.id),
    /** Creation timestamp (ms). */
    createdAt: real("created_at").notNull(),
  },
  t => [primaryKey({ columns: [t.promptId, t.name] })],
);
