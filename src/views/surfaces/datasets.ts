// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The datasets surface: views shown as tabs beside a dataset's Grid, each
 * showing — and able to propose edits to — the selected row. See
 * `specs/dataset-views.md` §B.
 */

import type {
  Dataset,
  DatasetRow,
  DatasetRowsOverview,
  DatasetRowUpdate,
} from "../../dataset/dataset-types.ts";
import { isValidInstanceName } from "../../shared/instance-names.ts";
import type { Surface } from "../surface.ts";
import {
  defineView,
  type View,
  type ViewDefinition,
  type ViewProps,
} from "../view.ts";

/**
 * What a dataset view's `applies` sees: the dataset and an overview of its
 * rows — never the rows themselves, which are paged and grow without bound.
 */
export interface DatasetViewSubject {
  dataset: Dataset;
  /** Row count, and what the rows' cells and instances hold. */
  overview: DatasetRowsOverview;
}

/** The row a dataset view shows: the one selected in the dataset view. */
export interface SelectedRow {
  /** The row's position, from 0. */
  index: number;
  /** The row, with any unsaved changes the view proposed applied. */
  row: DatasetRow;
  /** The row's label (`Dataset.rowLabel`), when the dataset names rows. */
  label?: string;
}

/** The host state a dataset view is told about. */
export interface DatasetViewContext {
  /** The selected row, or `null` before one is (or when there are none). */
  selected: SelectedRow | null;
}

/** What a dataset view is given, on mount and on every update. */
export interface DatasetViewProps extends ViewProps {
  dataset: Dataset;
  overview: DatasetRowsOverview;
  /** The selected row. The host selects one before showing a view's tab. */
  selected: SelectedRow | null;
  /** Asks the host to select another row. */
  selectRow(index: number): void;
  /**
   * Proposes a change to the selected row. The host stages it in a draft
   * — the view gets the row back with it applied — and saves only when the
   * viewer clicks Save. Build one with `evalution/views/datasets`.
   */
  proposeUpdate(update: DatasetRowUpdate): void;
}

/** A view on the datasets surface. */
export type DatasetViewDefinition = ViewDefinition<
  DatasetViewSubject,
  DatasetViewProps
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `value` isn't a {@link DatasetRowUpdate}, or `undefined` if it is one. */
export function updateProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "an update must be an object";
  if (typeof value.rowId !== "string") return "an update needs a rowId";
  if (!isRecord(value.cells)) return "an update needs cells (use {} for none)";
  for (const [field, cell] of Object.entries(value.cells)) {
    if (cell !== null && !(isRecord(cell) && typeof cell.kind === "string")) {
      return `cell ${field} must be an input or null`;
    }
  }
  if (value.resources !== undefined) {
    if (!isRecord(value.resources)) return "resources must be an object";
    for (const [name, spec] of Object.entries(value.resources)) {
      if (!isValidInstanceName(name)) {
        return `'${name}' isn't a valid instance name`;
      }
      if (spec === null) continue;
      if (!isRecord(spec) || typeof spec.uri !== "string") {
        return `instance ${name} needs a resource uri`;
      }
      if (spec.args !== undefined && !isRecord(spec.args)) {
        return `instance ${name}'s args must be an object`;
      }
    }
  }
  return undefined;
}

/** The datasets surface's descriptor. */
export const datasetSurface: Surface<
  DatasetViewSubject,
  never,
  DatasetViewContext,
  DatasetViewProps
> = {
  name: "datasets",
  helper: "datasetView",
  // A dataset is never live: a change is a fresh snapshot.
  isFinal: () => true,
  actions: {
    selectRow: {
      effect: "ephemeral",
      check(args, { subject }) {
        const index = (args as { index?: unknown } | null)?.index;
        return Number.isInteger(index) &&
          (index as number) >= 0 &&
          (index as number) < subject.overview.rowCount
          ? undefined
          : `no row ${String(index)}`;
      },
    },
    proposeUpdate: {
      effect: "effectful",
      check(args, { context }) {
        const update = (args as { update?: unknown } | null)?.update;
        const problem = updateProblem(update);
        if (problem) return problem;
        const { rowId } = update as DatasetRowUpdate;
        return rowId === context.selected?.row.id
          ? undefined
          : "a view can only change the row it's showing";
      },
    },
  },
  props: ({ subject, context }, send, base) => ({
    ...base,
    dataset: subject.dataset,
    overview: subject.overview,
    selected: context.selected,
    selectRow: index => send("selectRow", { index }),
    proposeUpdate: update => send("proposeUpdate", { update }),
  }),
};

/**
 * Makes a dataset view: a tab beside the Grid for every dataset `applies`
 * says yes to. A file under `.evalution/views/datasets/` default-exports
 * one.
 *
 * @example
 * ```tsx
 * export default datasetView({
 *   label: "Task Hierarchy",
 *   applies: ({ overview }) =>
 *     Object.values(overview.instances).some(i => i.uri.endsWith("#seededTask")),
 *   mount: react(TaskHierarchy),
 * });
 * ```
 */
export function datasetView(
  definition: DatasetViewDefinition,
): View<DatasetViewSubject, DatasetViewProps> {
  return defineView(datasetSurface, definition);
}
