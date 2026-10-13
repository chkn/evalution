// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What a view is, whatever surface it's on. See
 * `specs/trace-visualizers.md` §A.
 */

import type { Surface } from "./surface.ts";

/** What every view is given, whatever its surface. */
export interface ViewProps {
  /**
   * Asks the host to open an http(s) URL in a new tab, which it does after
   * the viewer confirms. A view's frame can't open one itself.
   */
  openUrl(url: string): void;
}

/** A mounted view. */
export interface MountedView<P extends ViewProps> {
  /** Called with the new props whenever the subject or the host's context changes. */
  update(props: P): void;
  /** Called before the view is torn down, or when it stops applying. */
  unmount?(): void;
}

/** A view on a surface whose subject is `S`. */
export interface ViewDefinition<S, P extends ViewProps> {
  /** The label the host shows for it (a tab). Defaults to the file name. */
  label?: string;
  /** Whether this subject gets the view. Pure and synchronous: called on every change. */
  applies(subject: S): boolean;
  /** Renders into `element`, which fills the space the host gives it. */
  mount(element: HTMLElement, props: P): MountedView<P>;
}

/**
 * Marks a definition as a view, and carries the surface it was made for.
 * A global symbol, so a view made by one copy of the runtime is still
 * recognised by another.
 */
export const VIEW_TAG: unique symbol = Symbol.for("evalution.view");

/** A {@link ViewDefinition} tagged with its surface by that surface's helper (`traceView()`, …). */
export interface View<S, P extends ViewProps> extends ViewDefinition<S, P> {
  /** The surface the view was made for. */
  readonly [VIEW_TAG]: Surface<S, unknown, unknown, P>;
}

/** Whether `value` is a view made by a surface helper. */
export function isView(value: unknown): value is View<unknown, ViewProps> {
  return (
    typeof value === "object" &&
    value !== null &&
    VIEW_TAG in value &&
    typeof (value as { applies?: unknown }).applies === "function" &&
    typeof (value as { mount?: unknown }).mount === "function"
  );
}

/** Tags `definition` with `surface`. What each surface's helper calls. */
export function defineView<S, P extends ViewProps>(
  surface: Surface<S, never, never, P>,
  definition: ViewDefinition<S, P>,
): View<S, P> {
  return {
    ...definition,
    [VIEW_TAG]: surface as unknown as Surface<S, unknown, unknown, P>,
  };
}
