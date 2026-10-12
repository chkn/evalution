// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";

/**
 * A text field that edits a draft of `value` and commits it on blur or Enter.
 * Once the draft is committed, rejected by `validate`, or dropped with Escape,
 * the field shows `value` again — as `onCommit` left it, so a commit the
 * parent normalizes or ignores shows what it really saved. Keeps focus
 * through the commit, so it survives the re-render a rename causes.
 */
export default function DraftInput({
  value,
  validate,
  className,
  label,
  title,
  readOnly,
  onCommit,
}: {
  value: string;
  /** Why a draft can't be committed, if it can't. */
  validate?: (draft: string) => string | null | undefined;
  className?: string;
  /** The input's accessible name. */
  label: string;
  /** Tooltip; the error, when there is one, takes its place. */
  title?: string;
  readOnly?: boolean;
  /** Called with the draft when it changed and is acceptable. */
  onCommit: (next: string) => void;
}) {
  // Only while editing; `null` shows `value`.
  const [draft, setDraft] = useState<string | null>(null);
  const error = draft === null ? null : validate?.(draft);
  const commit = () => {
    if (draft !== null && !error && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      data-1p-ignore
      className={className}
      aria-label={label}
      aria-invalid={!!error}
      title={error ?? title}
      value={draft ?? value}
      readOnly={readOnly}
      spellCheck={false}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(null);
        }
      }}
    />
  );
}
