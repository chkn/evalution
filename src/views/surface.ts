// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A surface: a place in the app where sandboxed views can appear. The frame
 * machinery is generic; a surface supplies the rest — its subject, how that
 * changes, the host context a view is told about, and what a view may ask
 * the host to do. Imported by both the frame runtime and the host. See
 * `specs/trace-visualizers.md` §A.1.
 */

import type { ViewProps } from "./view.ts";

/**
 * How a view's request is applied. An *ephemeral* action (select, highlight)
 * is applied directly; an *effectful* one is staged by the host and applied
 * only when the viewer confirms it in host-rendered UI.
 */
export type ActionEffect = "ephemeral" | "effectful";

/** What a view on a surface knows: its subject, and the host's context. */
export interface SurfaceState<S, C> {
  subject: S;
  context: C;
}

/** One thing a view may ask the host to do. */
export interface SurfaceAction<S, C> {
  /** Whether it's applied directly or staged for the viewer to confirm. */
  effect: ActionEffect;
  /**
   * The host's check of a frame's request, whose `args` are untrusted: why
   * it's refused, or `undefined` to accept it.
   */
  check(args: unknown, state: SurfaceState<S, C>): string | undefined;
}

/** Sends an action from a view to the host. */
export type SendAction = (name: string, args: unknown) => void;

/**
 * A surface's descriptor: subject `S`, incremental change `E`, host context
 * `C`, and the props `P` its views are given.
 */
export interface Surface<S, E, C, P extends ViewProps> {
  /** The surface's name, which is also its directory under `.evalution/views/`. */
  readonly name: string;
  /** The helper a view on it is made with (`traceView`), for messages. */
  readonly helper: string;
  /**
   * Applies one incremental change to the subject. A surface whose subject
   * is small leaves it out and has the host resend snapshots instead.
   */
  applyEvent?(subject: S, event: E): S;
  /**
   * Whether the subject can no longer change, so a view's `applies` answer
   * is final and a frame that doesn't apply can be dropped.
   */
  isFinal(subject: S): boolean;
  /** What a view may ask the host to do, by name. */
  readonly actions: Readonly<Record<string, SurfaceAction<S, C>>>;
  /**
   * The props a view is given, built in the frame from what it knows.
   * `send` sends one of {@link actions}; `base` carries the actions every
   * view has.
   */
  props(state: SurfaceState<S, C>, send: SendAction, base: ViewProps): P;
}
