// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState, useCallback, type ReactNode } from 'react';
import checkIcon from '../../assets/check.svg?raw';
import copyIcon from '../../assets/copy.svg?raw';

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
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — ignore */
    }
  }, [text]);

  return (
    <div className={`copy-box${multiline ? ' copy-box-multiline' : ''}`}>
      {multiline ? <pre>{text}</pre> : <span className="copy-box-text">{children ?? text}</span>}
      <button
        type="button"
        className="copy-box-btn"
        onClick={copy}
        title={copied ? 'Copied!' : 'Copy to clipboard'}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      >
        <span dangerouslySetInnerHTML={{ __html: copied ? checkIcon : copyIcon }} />
      </button>
    </div>
  );
}
