// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { resource } from "../../../playground/resource.ts";
import type { TaskId } from "./handle-types.ts";

/** What `orchestrate` in `resource-values.prompt.ts` wants alongside `taskId`. */
export interface TaskInfo {
  title: string;
  description: string;
}

/**
 * A playground module beside `resource-values.prompt.ts`, modelling the
 * motivating case from `specs/resource-hierarchy.md` §A: one seeded row,
 * exposed as several named values so `taskId` and `taskInfo` can both be
 * filled from the one insert that produced them.
 */
export const taskA = resource({
  group: "Tasks",
  label: "Task A — simple bug report",
  values: { id: "Task ID", title: "Task Name", info: "Task Info" },
  create: () => ({
    value: {
      id: `tsk_${"a"}` as TaskId,
      title: "Fix the flaky login test",
      info: { title: "Fix the flaky login test", description: "…" } as TaskInfo,
    },
  }),
});
