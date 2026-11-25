// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useState } from "react";
import checkIcon from "../assets/check.svg?raw";
import copyIcon from "../assets/copy.svg?raw";

/**
 * An icon button that writes {@link text} to the clipboard, swapping to a
 * check mark for a moment once it has. The click stops at the button, so one
 * inside a clickable card (a conversation turn selects its span) copies
 * without also doing what the card does.
 */
export function CopyButton({
  text,
  className = "copy-btn",
  label = "Copy to clipboard",
}: {
  /** The text written to the clipboard. */
  text: string;
  /** The button's class; defaults to the small inline `copy-btn`. */
  className?: string;
  /** Its tooltip and accessible name before copying. */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* clipboard unavailable (e.g. insecure context) — ignore */
      }
    },
    [text],
  );

  return (
    <button
      type="button"
      className={`${className}${copied ? " copied" : ""}`}
      onClick={copy}
      title={copied ? "Copied!" : label}
      aria-label={copied ? "Copied" : label}
    >
      <span
        aria-hidden
        dangerouslySetInnerHTML={{ __html: copied ? checkIcon : copyIcon }}
      />
    </button>
  );
}
