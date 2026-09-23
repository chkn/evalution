// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ReactNode } from "react";
import { readAnswers } from "./answers";
import { JsonView } from "./JsonView.tsx";
import { SystemOneAnswers } from "./SystemOneAnswers.tsx";

/**
 * A way to show a structured span output, chosen by the output's shape. The
 * span's input comes along: it may describe the output (the questions an
 * evaluation's answers answer).
 */
export interface OutputRenderer {
  /** Whether this renderer understands `output`. */
  matches: (output: unknown, input?: unknown) => boolean;
  render: (output: unknown, input?: unknown) => ReactNode;
}

/**
 * Renderers for structured outputs, most specific first. Matching by shape
 * works for any trace — a playground run or one sent over OTLP — with no
 * adapter involved.
 */
export const OUTPUT_RENDERERS: readonly OutputRenderer[] = [
  {
    matches: (output, input) => readAnswers(output, input) !== undefined,
    render: (output, input) => (
      <SystemOneAnswers answers={readAnswers(output, input)!} raw={output} />
    ),
  },
];

/** A structured output through the first renderer that matches it, or as JSON. */
export function renderOutput(output: unknown, input?: unknown): ReactNode {
  const renderer = OUTPUT_RENDERERS.find(r => r.matches(output, input));
  return renderer ? renderer.render(output, input) : <JsonView data={output} />;
}
