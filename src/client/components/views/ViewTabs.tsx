// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../use-anchored-popover";
import type { ViewProblem, ViewTab } from "./use-surface-views.tsx";

/** A small "panel" glyph for a view's tab. */
function ViewIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M2 6h12M6 6v7.5" />
    </svg>
  );
}

/** The tab buttons for a surface's views, styled as the host's own tabs. */
export function ViewTabButtons({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly ViewTab[];
  active: string | null;
  onSelect: (uri: string) => void;
}) {
  return tabs.map(tab => (
    <button
      key={tab.uri}
      type="button"
      className={`trace-view-tab${active === tab.uri ? " trace-view-tab-active" : ""}`}
      onClick={() => onSelect(tab.uri)}
      title={tab.uri}
    >
      <ViewIcon />
      {tab.label}
    </button>
  ));
}

/**
 * A warning in the tab bar when views can't be shown — a failed build, a
 * file in the wrong place, a frame that never started — listing why, so a
 * broken view is visible rather than silently missing.
 */
export function ViewProblemsButton({
  problems,
}: {
  problems: readonly ViewProblem[];
}) {
  const [open, setOpen] = useState(false);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: () => setOpen(false),
      matchTriggerWidth: false,
    });
  if (problems.length === 0) return null;
  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="view-problems-btn"
        onClick={() => setOpen(o => !o)}
        title="Views that can't be shown"
      >
        ⚠ {problems.length} view{problems.length === 1 ? "" : "s"}
      </button>
      {open &&
        createPortal(
          <div className="view-problems" ref={popoverRef} style={style}>
            {problems.map(p => (
              <div key={p.uri} className="view-problem">
                <code className="view-problem-uri">{p.uri}</code>
                <pre className="view-problem-message">{p.message}</pre>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
