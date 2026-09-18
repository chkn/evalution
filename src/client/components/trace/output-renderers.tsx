// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ReactNode } from "react";
import { isSystemOneAnswers } from "./answers";
import { JsonView } from "./JsonView.tsx";
import { SystemOneAnswers } from "./SystemOneAnswers.tsx";

/** A way to show a structured span output, chosen by the output's shape. */
export interface OutputRenderer {
  /** Whether this renderer understands `output`. */
  matches: (output: unknown) => boolean;
  render: (output: unknown) => ReactNode;
}

/**
 * Renderers for structured outputs, most specific first. Matching by shape
 * works for any trace — a playground run or one sent over OTLP — with no
 * adapter involved.
 */
export const OUTPUT_RENDERERS: readonly OutputRenderer[] = [
  {
    matches: isSystemOneAnswers,
    render: output => (
      <SystemOneAnswers
        answers={output as Parameters<typeof SystemOneAnswers>[0]["answers"]}
      />
    ),
  },
];

/** A structured output through the first renderer that matches it, or as JSON. */
export function renderOutput(output: unknown): ReactNode {
  const renderer = OUTPUT_RENDERERS.find(r => r.matches(output));
  return renderer ? renderer.render(output) : <JsonView data={output} />;
}
