// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Renders LLM message/output text as Markdown, via `streamdown`.
 *
 * Streamdown's default element renderers hard-code Tailwind utility classes
 * (`font-semibold`, `space-y-4`, …) and shadcn-style CSS variables
 * (`bg-background`, `text-muted-foreground`, …) that evalution has neither —
 * verified by inspecting the actual rendered output, not assumed. Left alone
 * they're inert: no bold text, no list markers, no spacing. `code`/`pre` are
 * the one exception left un-overridden below — Shiki's syntax colors are
 * inline `style`, not Tailwind, so they render correctly regardless; only
 * their container box (background/padding) needed replacing, done in
 * `styles.css`'s `.markdown pre` rule instead of here. Every other element
 * below is overridden to a plain tag per `specs/trace-workshopping.md`'s
 * "Tailwind → CSS tokens" rule, styled by `.markdown …` in `styles.css`.
 */

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { Streamdown, type StreamdownProps } from "streamdown";

const plugins = { cjk, code, math };
const linkSafety = { enabled: true };

type Tag = keyof React.JSX.IntrinsicElements;
const plain: Partial<Record<Tag, Tag>> = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  p: "p",
  ul: "ul",
  ol: "ol",
  li: "li",
  blockquote: "blockquote",
  a: "a",
  hr: "hr",
  strong: "strong",
  em: "em",
  del: "del",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
};
// `node` (the hast source node streamdown attaches for its own components'
// use) isn't a valid DOM attribute — drop it rather than pass it through to
// a plain host element, which would emit a React "unknown prop" warning.
const components: StreamdownProps["components"] = Object.fromEntries(
  Object.entries(plain).map(([tag, El]) => [
    tag,
    ({ node: _node, ...props }: any) => <El {...props} />,
  ]),
);

/**
 * Self-closing XML-ish tags (`<Foo bar="baz"/>`), which sometimes show up
 * verbatim in agent transcripts, would otherwise be swallowed as unknown HTML
 * elements by the markdown sanitizer. Escaping them to inline code keeps them
 * visible instead of silently disappearing.
 */
function escapeXmlTags(text: string): string {
  return text.replace(/<([A-Z]\w*)\s+[^>]*\/>/g, match => `\`${match}\``);
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Streamdown
        plugins={plugins}
        linkSafety={linkSafety}
        components={components}
      >
        {escapeXmlTags(children)}
      </Streamdown>
    </div>
  );
}
