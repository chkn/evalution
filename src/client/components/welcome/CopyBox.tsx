// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ReactNode } from "react";
import { CopyButton } from "../CopyButton.tsx";

interface CopyBoxProps {
  /** The text written to the clipboard on copy. */
  text: string;
  /** Render as a multi-line `<pre>` code block instead of a single line. */
  multiline?: boolean;
  /**
   * Custom inline content to display instead of the raw {@link text} (e.g. to
   * make a URL clickable). The copy button still copies {@link text} verbatim.
   * Ignored when {@link multiline} is set.
   */
  children?: ReactNode;
}

/**
 * A read-only text box with a copy-to-clipboard button. Used throughout the
 * onboarding wizard for agent prompts and config snippets.
 */
export function CopyBox({ text, multiline, children }: CopyBoxProps) {
  return (
    <div className={`copy-box${multiline ? " copy-box-multiline" : ""}`}>
      {multiline ? (
        <pre>{text}</pre>
      ) : (
        <span className="copy-box-text">{children ?? text}</span>
      )}
      <CopyButton text={text} className="copy-box-btn" />
    </div>
  );
}
