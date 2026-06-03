import { useState, useCallback, type ReactNode } from 'react';

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
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
        )}
      </button>
    </div>
  );
}
