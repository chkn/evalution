// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Dataset } from "../../dataset/dataset-types";

/**
 * What "Delete dataset" asks before deleting. A dataset synced with
 * Evalution Cloud goes from every machine that has it, so it says so.
 */
export function deleteDatasetPrompt(
  dataset: Pick<Dataset, "name" | "synced">,
  rowCount: number,
): string {
  const question = `Delete “${dataset.name}” and its ${rowCount} row${rowCount === 1 ? "" : "s"}?`;
  return dataset.synced
    ? `${question}\n\nIt's synced with Evalution Cloud, so it will also be deleted from the cloud and from every project member's machine.`
    : question;
}
