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

function fanOutField(name: string): PropDefinition {
  switch (name) {
    case "db":
      return { name, optional: false, type: { kind: "opaque", syntax: "Db" } };
    case "workspaceId":
      return {
        name,
        optional: false,
        type: { kind: "primitive", syntax: "`ws_${string}`", base: "string" },
      };
    case "rootTaskId":
      return {
        name,
        optional: false,
        type: { kind: "primitive", syntax: "`tsk_${string}`", base: "string" },
      };
    case "runId":
      return {
        name,
        optional: false,
        type: { kind: "primitive", syntax: "`run_${string}`", base: "string" },
      };
    default:
      throw new Error(`fanOutField: unknown field '${name}'`);
  }
}

function fanOutMember(name: string, fields: string[]): PropDefinition {
  return {
    name,
    optional: false,
    type: {
      kind: "object",
      syntax: "Ctx",
      properties: fields.map(fanOutField),
    },
  };
}

/**
 * The `toolsContext` shape from `specs/combined-execute-inputs.md` §A: four
 * tools sharing `db` and `workspaceId`, two sharing `rootTaskId`, and one
 * alone with `runId` — 11 fields that combined mode collapses into 4 rows.
 */
export const ODIN_TOOLS_CONTEXT: PropDefinition = {
  name: "toolsContext",
  optional: false,
  type: {
    kind: "object",
    syntax: "InferToolSetContext<typeof tools>",
    properties: [
      fanOutMember("list_tasks", ["db", "workspaceId", "rootTaskId"]),
      fanOutMember("create_task", ["db", "workspaceId", "rootTaskId"]),
      fanOutMember("update_task", ["db", "workspaceId"]),
      fanOutMember("post_message", ["db", "workspaceId", "runId"]),
    ],
  },
};

/** `db` slots for every member of {@link ODIN_TOOLS_CONTEXT}, all offering `resource`. */
export function odinDbSlots(resource: ResourceInfo): Record<string, string[]> {
  return Object.fromEntries(
    ["list_tasks", "create_task", "update_task", "post_message"].map(m => [
      `toolsContext.${m}.db`,
      [resource.uri],
    ]),
  );
}

/** A per-run value that only running code can produce. */
export const SEEDED_TASK: ResourceInfo = {
  uri: "odin.playground.ts#seededRootTask",
  label: "Freshly seeded root task",
  scope: "run",
};

/**
 * A resource that takes arguments (`specs/resource-arguments.md` §B) — the
 * motivating `seededTask` example, with a `title` (string) and a `status`
 * (enum, defaulted) parameter.
 */
export const SEEDED_TASK_PARAM: PropDefinition = {
  name: "title",
  type: { kind: "primitive", syntax: "string", base: "string" },
  optional: false,
};
export const SEEDED_TASK_STATUS_PARAM: PropDefinition = {
  name: "status",
  type: {
    kind: "union",
    syntax: '"triaged" | "open" | "done"',
    types: [
      { kind: "constant", syntax: '"triaged"', value: "triaged" },
      { kind: "constant", syntax: '"open"', value: "open" },
      { kind: "constant", syntax: '"done"', value: "done" },
    ],
  },
  optional: false,
};
export const PARAMETERIZED_SEEDED_TASK: ResourceInfo = {
  uri: "seeded-task.playground.ts#seededTask",
  label: "Seeded task",
  scope: "run",
  parameters: [SEEDED_TASK_PARAM, SEEDED_TASK_STATUS_PARAM],
};

/** A plain string resource, assignable to {@link PARAMETERIZED_SEEDED_TASK}'s `title` argument. */
export const TITLE_GENERATOR: ResourceInfo = {
  uri: "seeded-task.playground.ts#titleGenerator",
  label: "Title generator",
  scope: "run",
};

/**
 * A second parameterized resource whose own argument happens to be named
 * `taskId` — the exact same name as a top-level prompt parameter a test
 * might also be filling from {@link PARAMETERIZED_SEEDED_TASK}. Regression
 * fixture for the name-collision bug a bare-label "who owns this form" check
 * fell into: two rows named `taskId` at different depths in the tree are not
 * the same row.
 */
export const SEEDED_RUN_TASK_ID_PARAM: PropDefinition = {
  name: "taskId",
  type: { kind: "primitive", syntax: "TaskId", base: "string" },
  optional: false,
};
export const SEEDED_RUN: ResourceInfo = {
  uri: "seeded-task.playground.ts#seededRun",
  label: "Seeded run",
  scope: "run",
  parameters: [SEEDED_RUN_TASK_ID_PARAM],
};

/**
 * A static `value` resource the server already knows, so the panel can
 * preview it — unlike {@link SEEDED_TASK}, which only exists once a run
 * creates it.
 */
export const WORKSPACE_RESOURCE: ResourceInfo = {
  uri: ".evalution/playground/workspace.ts#defaultWorkspace",
  label: "Default workspace",
  scope: "server",
  value: "ws_internal_default",
};

/**
 * A grouped, multi-value library — `specs/resource-hierarchy.md`'s
 * motivating "Tasks" example: two seeded tasks under one group, `taskA`
 * exposing three values (so it keeps a submenu) and `taskB` exposing only
 * one (so it collapses to its own label — `siblings === 1`, per §E).
 */
export const TASK_A: ResourceInfo = {
  uri: "tasks.playground.ts#taskA",
  label: "Task A — simple bug report",
  scope: "run",
  group: ["Tasks"],
};
export const TASK_A_ID: ResourceInfo = {
  uri: "tasks.playground.ts#taskA.id",
  label: "Task ID",
  scope: "run",
  group: ["Tasks"],
  parent: TASK_A.uri,
  siblings: 3,
};
export const TASK_A_TITLE: ResourceInfo = {
  uri: "tasks.playground.ts#taskA.title",
  label: "Task Name",
  scope: "run",
  group: ["Tasks"],
  parent: TASK_A.uri,
  siblings: 3,
};
export const TASK_A_INFO: ResourceInfo = {
  uri: "tasks.playground.ts#taskA.info",
  label: "Task Info",
  scope: "run",
  group: ["Tasks"],
  parent: TASK_A.uri,
  siblings: 3,
};
export const TASK_B: ResourceInfo = {
  uri: "tasks.playground.ts#taskB",
  label: "Task B — blocked subtree",
  scope: "run",
  group: ["Tasks"],
};
export const TASK_B_ID: ResourceInfo = {
  uri: "tasks.playground.ts#taskB.id",
  label: "Task ID",
  scope: "run",
  group: ["Tasks"],
  parent: TASK_B.uri,
  siblings: 1,
};

/** Every source in the `Tasks` library, unfiltered — for `PromptInputSources.resources`. */
export const TASKS_LIBRARY: ResourceInfo[] = [
  TASK_A,
  TASK_A_ID,
  TASK_A_TITLE,
  TASK_A_INFO,
  TASK_B,
  TASK_B_ID,
];

/** Offers `resources` on whichever slot paths `slots` names. */
export function sourcesFor(
  slots: Record<string, string[]>,
  resources: ResourceInfo[],
  which: "functionSlots" | "executeSlots" = "functionSlots",
  resourceSlots?: Record<string, Record<string, string[]>>,
): PromptInputSources {
  return {
    resources,
    functionSlots: which === "functionSlots" ? slots : {},
    executeSlots: which === "executeSlots" ? slots : {},
    ...(resourceSlots ? { resourceSlots } : {}),
  };
}
