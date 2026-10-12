// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { useAnchoredPopover } from "../use-anchored-popover.ts";
import { formatCost } from "./format.ts";
import { CostIcon } from "./icons.tsx";
import type { CostBreakdown } from "./usage.ts";

export interface CostTooltipProps {
  breakdown: CostBreakdown;
}

/**
 * The trace header's cost meta item: a total that reveals a breakdown panel
 * on hover, with prompt/cache read/cache write/completion dollars and the
 * $/1M-token price each implies (`cost / tokens`, scaled to a million). The
 * cache rows appear only when the trace read or wrote cached tokens.
 *
 * Positioned via {@link useAnchoredPopover} (the same clamping the header's
 * "more actions" menu uses) rather than a plain CSS `:hover` reveal, so the
 * panel stays inside the viewport instead of running off the edge of a
 * narrow window when the cost item sits near it.
 */
export function CostTooltip({ breakdown }: CostTooltipProps) {
  const [open, setOpen] = useState(false);
  const { triggerRef, popoverRef, style } = useAnchoredPopover<HTMLSpanElement>(
    {
      open,
      onClose: () => setOpen(false),
      matchTriggerWidth: false,
    },
  );

  return (
    <span
      ref={triggerRef}
      className="trace-view-meta-item trace-cost-meta"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <CostIcon />
      {formatCost(breakdown.total)}
      {open && (
        <div
          ref={popoverRef}
          className="trace-cost-tooltip"
          role="tooltip"
          style={style}
        >
          <CostRow
            label="Prompt"
            cost={breakdown.prompt}
            rate={breakdown.promptRate}
          />
          {breakdown.cacheRead !== undefined && (
            <CostRow
              label="Cache read"
              cost={breakdown.cacheRead}
              rate={breakdown.cacheReadRate}
            />
          )}
          {breakdown.cacheWrite !== undefined && (
            <CostRow
              label="Cache write"
              cost={breakdown.cacheWrite}
              rate={breakdown.cacheWriteRate}
            />
          )}
          <CostRow
            label="Completion"
            cost={breakdown.completion}
            rate={breakdown.completionRate}
          />
          <div className="trace-cost-tooltip-row trace-cost-tooltip-total">
            <span>Total</span>
            <span>{formatCost(breakdown.total)}</span>
          </div>
        </div>
      )}
    </span>
  );
}

/** One line of the breakdown: a label, its implied $/1M price, and its cost. */
function CostRow({
  label,
  cost,
  rate,
}: {
  label: string;
  cost: number;
  rate: number | undefined;
}) {
  return (
    <div className="trace-cost-tooltip-row">
      <span>
        {label}
        {rate !== undefined && ` (${formatCost(rate)}/1M tok)`}
      </span>
      <span>{formatCost(cost)}</span>
    </div>
  );
}
