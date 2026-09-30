// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { EvalSummary } from "../../eval/eval-types";
import type { PromptID } from "../../shared/types";
import { formatRate, passRate } from "./eval-summary";
import {
  type SummaryColumn,
  SummaryList,
  TableModeButton,
} from "./SummaryList";
import { tableModeWidth } from "./summary-list";
import { formatTimestampCompact } from "./trace/format.ts";
import {
  CalendarIcon,
  EvalsIcon,
  PlusIcon,
  PromptLinkIcon,
} from "./trace/icons.tsx";

interface Props {
  evals: EvalSummary[];
  loading: boolean;
  error: string | null;
  /** {@link evalKey} of the eval open in the focused pane. */
  selectedKey: string | null;
  onSelect: (item: EvalSummary) => void;
  /** "New eval…" — opens the dialog that creates one. */
  onNew: () => void;
  /** The name of the prompt an eval tests, if it's loaded. */
  promptName: (prompt: PromptID) => string | undefined;
  sidebarWidth: number;
  onResizeSidebar: (width: number) => void;
}

/** The key {@link Props.selectedKey} compares against. */
export function evalKey(e: { providerId: string; id: string }): string {
  return `${e.providerId}:${e.id}`;
}

/** The last run's overall pass rate, as the sidebar shows it. */
function lastRunRate(e: EvalSummary): number | undefined {
  return e.lastRun && passRate(e.lastRun.counts);
}

/**
 * The sidebar's Evals section: each eval's prompt, its last run's pass rate,
 * and when it last changed. Shares its layout with `DatasetList` via
 * `SummaryList`. See `specs/evals.md` §F.
 */
function EvalList({
  evals,
  loading,
  error,
  selectedKey,
  onSelect,
  onNew,
  promptName,
  sidebarWidth,
  onResizeSidebar,
}: Props) {
  const columns: SummaryColumn<EvalSummary>[] = [
    {
      key: "passRate",
      label: "Last run",
      icon: <EvalsIcon />,
      width: 64,
      cell: e =>
        e.lastRun?.status === "running"
          ? `${e.lastRun.done}/${e.lastRun.total}`
          : formatRate(lastRunRate(e)),
      card: e =>
        !e.lastRun
          ? "never run"
          : e.lastRun.status === "running"
            ? `running ${e.lastRun.done}/${e.lastRun.total}`
            : `${formatRate(lastRunRate(e))} passing`,
      sortValue: lastRunRate,
    },
    {
      key: "prompt",
      label: "Prompt",
      icon: <PromptLinkIcon />,
      width: 110,
      cell: e => promptName(e.prompt) || "—",
      card: e => promptName(e.prompt) || null,
      sortValue: e => promptName(e.prompt) || undefined,
    },
    {
      key: "updatedAt",
      label: "Updated",
      icon: <CalendarIcon />,
      width: 100,
      cell: e => formatTimestampCompact(e.updatedAt),
      card: e => formatTimestampCompact(e.updatedAt),
      sortValue: e => e.updatedAt,
    },
  ];

  return (
    <SummaryList
      title="Evals"
      headerActions={
        <>
          <TableModeButton
            sidebarWidth={sidebarWidth}
            onResizeSidebar={onResizeSidebar}
            tableWidth={tableModeWidth(columns.map(c => c.width))}
          />
          <button
            type="button"
            className="tree-toolbar-btn"
            title="New eval…"
            aria-label="New eval"
            onClick={onNew}
          >
            <PlusIcon />
          </button>
        </>
      }
      loading={loading}
      error={error}
      empty={
        <>
          <p>No evals yet.</p>
          <p className="trace-list-hint">
            An eval runs a prompt over a dataset and checks each result. Start
            one with “+” above, or with “New eval…” on a dataset.
          </p>
        </>
      }
      items={evals}
      columns={columns}
      itemKey={evalKey}
      itemName={e => e.name}
      selectedKey={selectedKey}
      onSelect={onSelect}
      defaultSort={{ key: "updatedAt", dir: "desc" }}
    />
  );
}

export default EvalList;
