// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { type ReactNode, useEffect, useRef, useState } from "react";

/** Whether `el` is scrolled short of its bottom edge. */
function hasMoreBelow(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight > 1;
}

/**
 * A prompt screen's two columns: the editor on the left, an execute panel on
 * the right. Narrow, the panel docks below the editor instead — all of it
 * CSS (`@container playground`), so every screen that uses this gets the same
 * behavior at the same widths. `header` sits above both.
 */
export function PromptSplit({
  header,
  editor,
  panel,
  loading,
}: {
  header: ReactNode;
  /** The left column's content. */
  editor: ReactNode;
  /** The right column's content: an {@link ExecPanelShell}. */
  panel: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="pg-playground-wrapper">
      {header}
      <div
        className={"pg-content" + (loading ? " pg-content--loading" : "")}
        aria-busy={loading}
      >
        <div className="pg-editor-col">{editor}</div>
        <div className="pg-exec-col">{panel}</div>
      </div>
    </div>
  );
}

/**
 * The execute panel's frame: a title row, a scrolling body of fields, and a
 * footer with the run action (and the error it caused) that stays in view
 * however far the fields scroll. The playground's panel and the eval's share
 * it, so they lay out and collapse identically.
 */
export function ExecPanelShell({
  title,
  actions,
  children,
  error,
  onDismissError,
  footer,
  notice,
}: {
  title: string;
  /** Beside the title, right-aligned: "Add to dataset", say. */
  actions?: ReactNode;
  /** The fields. */
  children: ReactNode;
  /** The run's own error, shown above {@link footer} — not scrolled away with the fields. */
  error?: ReactNode;
  onDismissError?: () => void;
  /** The run button, and anything that goes with it. */
  footer: ReactNode;
  /** Below the body and footer, across the panel's full width in either layout. */
  notice?: ReactNode;
}) {
  // Whether `.pg-exec-body` has more content below the fold — cues the
  // shadow above the run error, which otherwise reads as sitting flush
  // against the inputs even though it's actually in the non-scrolling
  // footer below them.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHasMoreBelow, setBodyHasMoreBelow] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setBodyHasMoreBelow(hasMoreBelow(el));
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, []);

  // The listener above only catches the user's own scrolling — this also
  // re-checks after every render (the first included), so a row appearing, an
  // argument form opening, or the error itself showing up (all of which can
  // change how much of `.pg-exec-body` overflows without the user touching
  // it) keeps the shadow honest too.
  useEffect(() => {
    if (bodyRef.current) setBodyHasMoreBelow(hasMoreBelow(bodyRef.current));
  });

  return (
    <div className="pg-exec-inner">
      <div className="pg-exec-header">
        <span className="pg-exec-title">{title}</span>
        {actions}
      </div>
      <div className="pg-exec-main">
        <div className="pg-exec-body" ref={bodyRef}>
          {children}
        </div>
        <div className="pg-exec-footer">
          {error && (
            <div
              className={
                "pg-exec-error pg-exec-error-run" +
                (bodyHasMoreBelow ? " pg-exec-error-run-shadow" : "")
              }
            >
              {error}
              {onDismissError && (
                <button
                  type="button"
                  className="pg-dismiss"
                  onClick={onDismissError}
                >
                  ×
                </button>
              )}
            </div>
          )}
          {footer}
        </div>
      </div>
      {notice && <div className="pg-exec-notice">{notice}</div>}
    </div>
  );
}
