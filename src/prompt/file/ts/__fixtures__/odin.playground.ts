// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { resource } from "../../../playground/resource.ts";
import type { Db, TaskId } from "./handle-types.ts";

/**
 * A playground module beside `opaque-param.prompt.ts`.
 *
 * Deliberately *not* pinned with a type argument: `db` infers `Db` from what
 * `create` returns, and `seededRootTask` infers `` `tsk_${string}` `` — a
 * different spelling of the `TaskId` the prompt's slot is declared with. That
 * mismatch is the point; assignability is what has to bridge it.
 */
export const db = resource({
  label: "Local D1 (.wrangler state)",
  scope: "server",
  create: () => ({ value: null as unknown as Db }),
});

export const seededRootTask = resource({
  label: "Freshly seeded root task",
  needs: { db },
  create: () => ({ value: `tsk_${"abc"}` as const, receipt: "tsk_abc" }),
});

/** Not a resource — the loader must skip it without complaint. */
export const HELPER_NOTE = "colocated freely";

/** Silences the unused-import warning while documenting the intended pin. */
export type PinnedTaskId = TaskId;
