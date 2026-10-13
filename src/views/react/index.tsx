// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * **evalution/views/react** — writing a view as a React component:
 * {@link react} adapts one to a view's `mount`, and a few building blocks
 * match the host's look. React is an optional peer dependency: it comes from
 * your project when your view is bundled. See
 * `specs/trace-visualizers.md` §A, §B.4.
 *
 * @module evalution/views/react
 */

import {
  Component,
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
} from "react";
import { createRoot } from "react-dom/client";
import { diffWords } from "../../shared/text-diff.ts";
import { reportViewError } from "../runtime.ts";
import type { TraceViewProps } from "../surfaces/trace.ts";
import type { MountedView, ViewProps } from "../view.ts";

export type {
  DatasetViewProps,
  SelectedRow,
} from "../surfaces/datasets.ts";
export type { TraceViewProps } from "../surfaces/trace.ts";
export type { ViewProps } from "../view.ts";

const PropsContext = createContext<ViewProps | null>(null);

/** Styles for the building blocks, themed by the host's tokens. */
const BLOCKS_CSS = `
.ev-span-link {
  all: unset; cursor: pointer; color: var(--ev-link);
  border-radius: 3px;
}
.ev-span-link:hover { text-decoration: underline; }
.ev-span-link:focus-visible { outline: 2px solid var(--ev-link); }
.ev-span-link[data-selected] { background: var(--ev-selected); }
.ev-diff-del { background: var(--ev-removed-bg); color: var(--ev-removed); text-decoration: line-through; }
.ev-diff-add { background: var(--ev-added-bg); color: var(--ev-added); }
.ev-json {
  margin: 0; font: 12px/1.45 var(--ev-mono); white-space: pre-wrap;
  word-break: break-word;
}
.ev-error {
  margin: 12px; padding: 10px 12px; border-radius: 6px;
  background: var(--ev-removed-bg); color: var(--ev-removed);
}
.ev-error pre { margin: 6px 0 0; white-space: pre-wrap; font: 12px var(--ev-mono); }
`;

let stylesAdded = false;
function addBlockStyles(): void {
  if (stylesAdded || typeof document === "undefined") return;
  stylesAdded = true;
  const style = document.createElement("style");
  style.textContent = BLOCKS_CSS;
  document.head.append(style);
}

interface BoundaryProps {
  children: ReactNode;
  /** A new value retries a failed render: each update brings one. */
  resetKey: unknown;
}

/** Catches a render error, shows it in the frame, and tells the host. */
class ErrorBoundary extends Component<BoundaryProps, { error?: unknown }> {
  override state: { error?: unknown } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown) {
    reportViewError(error);
  }

  override componentDidUpdate(prev: BoundaryProps) {
    if (
      this.state.error !== undefined &&
      prev.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: undefined });
    }
  }

  override render() {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    return (
      <div className="ev-error" role="alert">
        <strong>This view failed to render.</strong>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
      </div>
    );
  }
}

/**
 * A view's `mount`, rendering `component` with the view's props into a
 * React root, inside an error boundary that shows a render error in the
 * view and reports it to the host.
 *
 * @example
 * ```tsx
 * export default traceView({ label: "Tasks", applies, mount: react(TaskTree) });
 * ```
 */
export function react<P extends ViewProps>(
  component: ComponentType<P>,
): (element: HTMLElement, props: P) => MountedView<P> {
  const Component = component as ComponentType<ViewProps>;
  return (element, props) => {
    addBlockStyles();
    const root = createRoot(element);
    const render = (p: P) =>
      root.render(
        <ErrorBoundary resetKey={p}>
          <PropsContext.Provider value={p}>
            <Component {...p} />
          </PropsContext.Provider>
        </ErrorBoundary>,
      );
    render(props);
    return { update: render, unmount: () => root.unmount() };
  };
}

/** The view's current props, from anywhere inside a {@link react} view. */
export function useViewProps<P extends ViewProps = ViewProps>(): P {
  const props = useContext(PropsContext);
  if (!props)
    throw new Error("useViewProps() is only for views made with react()");
  return props as P;
}

/** Props of {@link SpanLink}. */
export interface SpanLinkProps {
  /** The span to select. */
  spanId: string;
  children: ReactNode;
  className?: string;
  title?: string;
}

/**
 * A link that selects a span in the trace view's details pane. Marked
 * `data-selected` while that span is the selected one. Trace views only.
 */
export function SpanLink({
  spanId,
  children,
  className,
  title,
}: SpanLinkProps) {
  const { selectSpan, selectedSpanId } = useViewProps<TraceViewProps>();
  return (
    <button
      type="button"
      className={className ? `ev-span-link ${className}` : "ev-span-link"}
      title={title}
      data-selected={selectedSpanId === spanId || undefined}
      onClick={event => {
        event.stopPropagation();
        selectSpan(spanId);
      }}
    >
      {children}
    </button>
  );
}

/** Props of {@link TextDiff}. */
export interface TextDiffProps {
  before: string;
  after: string;
}

/** `before` and `after` as one word-level diff: removed words struck out, added ones marked. */
export function TextDiff({ before, after }: TextDiffProps) {
  return (
    <span className="ev-diff">
      {diffWords(before, after).map((segment, i) =>
        segment.type === "same" ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <span key={i} className={`ev-diff-${segment.type}`}>
            {segment.text}
          </span>
        ),
      )}
    </span>
  );
}

/** Props of {@link JsonView}. */
export interface JsonViewProps {
  value: unknown;
}

/** A value as indented JSON. */
export function JsonView({ value }: JsonViewProps) {
  return <pre className="ev-json">{JSON.stringify(value, null, 2)}</pre>;
}
