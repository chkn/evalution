// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { z } from "zod";
import { resource } from "../../../playground/resource.ts";
import type { TaskId } from "./handle-types.ts";

/**
 * A playground module beside `seeded-task.prompt.ts`, modelling
 * `specs/resource-arguments.md`'s motivating `seededTask` example: a resource
 * that takes arguments (`title`, `status`) alongside a code-wired dependency
 * would go here (see `resource-outputs.playground.ts` for the dependency
 * case) — this one keeps arguments as the only kind of `inputs` entry, so the
 * probe and slot-matching tests below aren't also exercising dependency
 * resolution.
 */
export const seededTask = resource({
  label: "Seeded task",
  inputs: {
    title: z.string(),
    status: z.enum(["triaged", "open", "done"]).default("triaged"),
  },
  outputs: { taskId: "Task ID", title: "Title" },
  create: ({ title, status }) => ({
    value: { taskId: `tsk_${title}` as TaskId, title, status },
  }),
});

/**
 * A number, which fits none of `seededTask`'s arguments by type — offered on
 * `status` only because its explicit `for` says so.
 */
export const statusPicker = resource({
  label: "Status picker",
  for: "seededTask.status",
  create: () => ({ value: 42 }),
});

/** A plain string resource, assignable to `seededTask`'s `title` argument. */
export const titleGenerator = resource({
  label: "Title generator",
  create: () => ({ value: "Generated title" }),
});
