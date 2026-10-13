// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** The view that asked, by its label. */
  viewLabel: string;
  /** The URL to open: an absolute http(s) URL. */
  url: string;
  onCancel: () => void;
}

/**
 * Asks before opening a URL a view asked for. A view's frame can't open
 * one itself, and the URL is what it would smuggle data out in — so its
 * host is shown prominently, and the full URL below it, never truncated.
 * See `specs/trace-visualizers.md` §C.1.
 */
export function OpenUrlDialog({ viewLabel, url, onCancel }: Props) {
  const { host, protocol } = new URL(url);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return createPortal(
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog open-url-dialog"
        role="dialog"
        aria-label="Open link"
        onClick={e => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3>Open a link?</h3>
          <button type="button" className="dialog-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="dialog-body">
          <p className="open-url-lede">
            The <strong>{viewLabel}</strong> view wants to open a page on
          </p>
          <p className="open-url-host">
            {protocol === "http:" && (
              <span className="open-url-insecure">http://</span>
            )}
            {host}
          </p>
          <p className="open-url-full">{url}</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-btn-cancel"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dialog-btn-create"
              autoFocus
              onClick={() => {
                window.open(url, "_blank", "noopener,noreferrer");
                onCancel();
              }}
            >
              Open
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
