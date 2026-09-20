// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** A span/trace duration in ms, at whatever precision reads best. */
export function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Full date/time, used by the trace header at its normal (wide) width. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Narrower rendering of {@link formatTimestamp}, for a squeezed trace header
 * and the sidebar's trace list (permanently narrow).
 */
export function formatTimestampCompact(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A span's status for display. A span that hasn't ended has no recorded
 * status yet, so it reads as `running`.
 */
export function spanDisplayStatus(span: {
  status?: string;
  endTime?: number;
}): string | undefined {
  return span.status ?? (span.endTime === undefined ? "running" : undefined);
}

/** A glyph standing in for a span's status, shown in its status pill. */
export function statusGlyph(status: string): string {
  switch (status) {
    case "ok":
      return "✓";
    case "error":
      return "✕";
    case "running":
      return "●";
    default:
      return "?";
  }
}

/** A token count with thousands separators, e.g. `12,345`. */
export function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString();
}

/** A dollar cost, e.g. `$0.00012` — per-call costs are tiny fractions of a cent. */
export function formatCost(cost: number): string {
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
