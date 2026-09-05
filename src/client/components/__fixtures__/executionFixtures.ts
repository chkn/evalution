// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  PromptInputSources,
  PropDefinition,
  ResourceInfo,
} from "../../../shared/types";

/**
 * Plain fixtures for the execute-panel component tests.
 *
 * Kept out of `PlaygroundExecutionHarness.tsx` on purpose: Playwright CT
 * rewrites every named import from a component module into a component
 * registration, so a non-component export there is re-declared and the file
 * fails to load.
 */

/** A `Db`-shaped slot: opaque, so it has no editor of its own. */
export const OPAQUE_DB: PropDefinition = {
  name: "db",
  type: { kind: "opaque", syntax: "Db" },
  optional: false,
};

/**
 * A `toolsContext`-shaped param with one tool whose context has a nested
 * opaque `db` field — mirrors `InferToolSetContext<typeof tools>` in a real
 * prompt, where no resource is ever wired to that specific nested path.
 */
export const TOOLS_CONTEXT_WITH_NESTED_DB: PropDefinition = {
  name: "toolsContext",
  type: {
    kind: "object",
    syntax: "InferToolSetContext<typeof tools>",
    properties: [
      {
        name: "list_tasks",
        type: {
          kind: "object",
          syntax: "{ db: Db }",
          properties: [
            {
              name: "db",
              type: { kind: "opaque", syntax: "Db" },
              optional: false,
            },
          ],
        },
        optional: false,
      },
    ],
  },
  optional: false,
};

/** An expensive handle, created once per server. */
export const DB_RESOURCE: ResourceInfo = {
  uri: ".evalution/playground/db.ts#db",
  label: "Local D1 (.wrangler state)",
  scope: "server",
};

/** A per-run value that only running code can produce. */
export const SEEDED_TASK: ResourceInfo = {
  uri: "odin.playground.ts#seededRootTask",
  label: "Freshly seeded root task",
  scope: "run",
};

/** Offers `resources` on whichever slot paths `slots` names. */
export function sourcesFor(
  slots: Record<string, string[]>,
  resources: ResourceInfo[],
  which: "functionSlots" | "executeSlots" = "functionSlots",
): PromptInputSources {
  return {
    resources,
    functionSlots: which === "functionSlots" ? slots : {},
    executeSlots: which === "executeSlots" ? slots : {},
  };
}
