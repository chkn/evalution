// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
// Copyright (c) 2026 Invisible Tools, Inc. (dba Raindrop)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Small badge rendering one {@link Annotation}'s kind + source. Ported from
 * Workshop's `AnnotationChip.tsx` — inline styles → `.annotation-chip-*`
 * CSS-token classes (`styles.css`) — see `specs/trace-workshopping.md` §D.
 */

import { useEffect, useRef } from "react";
import type {
  Annotation,
  AnnotationKind,
  AnnotationSource,
} from "../../../shared/types";

// Keep in sync with `.annotation-arriving` in styles.css:
// 0.25s enter + 2 × 1.2s breathe ≈ 2.65s.
export const ANNOTATION_ARRIVAL_MS = 2700;

export const KIND_STYLES: Record<
  AnnotationKind,
  { icon: string; label: string }
> = {
  issue: { icon: "!", label: "issue" },
  good: { icon: "✓", label: "good" },
  note: { icon: "·", label: "note" },
};

export const SOURCE_GLYPH: Record<AnnotationSource, string> = {
  "claude-code": "◆",
  codex: "›",
  user: "·",
};

export function annotationSourceLabel(source: AnnotationSource): string {
  if (source === "claude-code") return "Claude Code";
  if (source === "codex") return "Codex";
  return "You";
}

/**
 * Icon-only chip (for span rows, trace-level annotation lists, etc.). When
 * `arriving` is true, plays the arrival animation exactly once — the parent
 * is responsible for clearing that flag after it fires.
 */
export function AnnotationChip({
  annotation,
  arriving = false,
  onArrivalEnd,
  title,
  showLabel = false,
}: {
  annotation: Annotation;
  arriving?: boolean;
  onArrivalEnd?: () => void;
  title?: string;
  showLabel?: boolean;
}) {
  const style = KIND_STYLES[annotation.kind];
  // Hold the latest callback in a ref so unstable arrow-function parents
  // don't reset the timer on every re-render (which would prevent the class
  // from ever being stripped while the surrounding tree is active).
  const endRef = useRef(onArrivalEnd);
  endRef.current = onArrivalEnd;

  useEffect(() => {
    if (!arriving) return;
    const handle = window.setTimeout(
      () => endRef.current?.(),
      ANNOTATION_ARRIVAL_MS,
    );
    return () => window.clearTimeout(handle);
  }, [arriving]);

  return (
    <span
      className={`annotation-chip annotation-chip-${annotation.kind}${
        showLabel ? " annotation-chip-labeled" : ""
      }${arriving ? ` annotation-arriving kind-${annotation.kind}` : ""}`}
      title={title ?? annotation.note ?? style.label}
    >
      <span className="annotation-chip-icon">{style.icon}</span>
      {showLabel ? style.label : null}
      <span className="annotation-chip-source">
        {SOURCE_GLYPH[annotation.source]}
      </span>
    </span>
  );
}
