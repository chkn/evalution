// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The frame side of a view: answers the host's handshake, keeps the subject
 * up to date through the surface's reducer, runs `applies`, and mounts and
 * updates the view with errors caught. Bundled into every view's frame. It
 * imports no framework and knows no surface by name: the view carries its
 * own surface (`VIEW_TAG`). See `specs/trace-visualizers.md` §C.
 */

import {
  type FrameMessage,
  type HostMessage,
  PROTOCOL,
  parseHostMessage,
  type ViewTheme,
} from "./protocol.ts";
import type { SurfaceState } from "./surface.ts";
import {
  isView,
  type MountedView,
  VIEW_TAG,
  type View,
  type ViewProps,
} from "./view.ts";

/** What the frame knows, between messages. */
export interface FrameState<S, C> {
  /** The subject and context, once `init` has arrived. */
  known?: SurfaceState<S, C>;
  /** The `rev` of the last message that changed {@link known}. */
  rev: number;
  /** The view's last `applies` answer, once there is one. */
  applies?: boolean;
  /** Whether the view is mounted: it is exactly while it applies. */
  mounted: boolean;
}

/** What the frame has to do after a message, beyond replying. */
export type FrameEffect =
  | { kind: "mount" }
  | { kind: "update" }
  | { kind: "unmount" }
  | { kind: "theme"; theme: ViewTheme }
  | { kind: "rejected"; name: string; reason: string };

/** The frame's state before `init`. */
export const INITIAL_FRAME_STATE: FrameState<never, never> = {
  rev: 0,
  mounted: false,
};

/**
 * The frame's handling of one host message, as a pure function: the next
 * state, the messages to send back, and what to do to the view. `applies`
 * is called here, since it's pure; `mount` and `update` are left to the
 * caller as effects.
 */
export function frameStep<S, E, C, P extends ViewProps>(
  view: View<S, P>,
  state: FrameState<S, C>,
  message: HostMessage<S, E, C>,
): { state: FrameState<S, C>; out: FrameMessage[]; effects: FrameEffect[] } {
  const surface = view[VIEW_TAG];
  const out: FrameMessage[] = [];
  const effects: FrameEffect[] = [];

  /** Re-asks `applies` after the subject changed, and mounts or unmounts. */
  const reevaluate = (next: FrameState<S, C>): FrameState<S, C> => {
    let value: boolean;
    try {
      value = !!view.applies(next.known!.subject);
    } catch (err) {
      out.push({
        type: "error",
        message: errorMessage(err),
        during: "applies",
      });
      value = false;
    }
    if (value !== next.applies) out.push({ type: "applies", value });
    if (value && !next.mounted) effects.push({ kind: "mount" });
    else if (value) effects.push({ kind: "update" });
    else if (next.mounted) effects.push({ kind: "unmount" });
    return { ...next, applies: value, mounted: value };
  };

  switch (message.type) {
    case "init": {
      effects.push({ kind: "theme", theme: message.theme });
      const next = reevaluate({
        ...state,
        known: { subject: message.subject, context: message.context },
        rev: message.rev,
      });
      return { state: next, out, effects };
    }
    case "subject":
    case "event": {
      if (!state.known) return { state, out, effects };
      const subject =
        message.type === "subject"
          ? message.subject
          : surface.applyEvent
            ? (surface.applyEvent(
                state.known.subject,
                message.event as never,
              ) as S)
            : state.known.subject;
      const next = reevaluate({
        ...state,
        known: { ...state.known, subject },
        rev: message.rev,
      });
      return { state: next, out, effects };
    }
    case "context": {
      if (!state.known) return { state, out, effects };
      if (state.mounted) effects.push({ kind: "update" });
      return {
        state: {
          ...state,
          known: { ...state.known, context: message.context },
          rev: message.rev,
        },
        out,
        effects,
      };
    }
    case "theme":
      effects.push({ kind: "theme", theme: message.theme });
      return { state, out, effects };
    case "rejected":
      effects.push({
        kind: "rejected",
        name: message.name,
        reason: message.reason,
      });
      return { state, out, effects };
  }
}

/** The text of whatever was thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** Where errors reported from inside a view go: the running frame's host. */
let reportTo: ((message: string) => void) | undefined;

/**
 * Tells the host that the view failed to render, for errors the runtime
 * can't catch itself — an adapter's error boundary calls it.
 */
export function reportViewError(err: unknown): void {
  reportTo?.(errorMessage(err));
}

/** The frame's base styles: full size, themed by the host's tokens. */
const BASE_CSS = `
html, body { margin: 0; height: 100%; }
body {
  background: var(--ev-bg);
  color: var(--ev-fg);
  font: 13px/1.45 var(--ev-font);
}
#evalution-view { height: 100%; overflow: auto; box-sizing: border-box; }
`;

function applyTheme(root: HTMLElement, theme: ViewTheme): void {
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (name.startsWith("--")) root.style.setProperty(name, value);
  }
  root.style.colorScheme = theme.mode;
  root.dataset.theme = theme.mode;
}

/**
 * Runs `value` — a module's default export — as this frame's view on the
 * surface named `surfaceName`. The bundle's entry calls it; a view never
 * does.
 */
export function start(value: unknown, surfaceName: string): void {
  const post = (message: FrameMessage) =>
    window.parent.postMessage(message, "*");

  if (!isView(value)) {
    post({
      type: "ready",
      protocol: PROTOCOL,
      error:
        value === undefined
          ? "This file has no default export. A view is its file's default export, made with its surface's helper, e.g. `export default traceView({ … })`."
          : "This file's default export isn't a view. Make it with its surface's helper, e.g. `export default traceView({ … })`.",
    });
    return;
  }
  const view = value;
  const surface = view[VIEW_TAG];
  if (surface.name !== surfaceName) {
    post({
      type: "ready",
      protocol: PROTOCOL,
      surface: surface.name,
      error: `This is a ${surface.helper}() view, which belongs in .evalution/views/${surface.name}/, not .evalution/views/${surfaceName}/.`,
    });
    return;
  }

  const style = document.createElement("style");
  style.textContent = BASE_CSS;
  document.head.append(style);
  const element = document.createElement("div");
  element.id = "evalution-view";
  document.body.append(element);

  let state: FrameState<unknown, unknown> = INITIAL_FRAME_STATE;
  let mounted: MountedView<ViewProps> | undefined;
  const reportError = (message: string) =>
    post({ type: "error", message, during: "render" });
  reportTo = reportError;

  const props = (): ViewProps =>
    surface.props(
      state.known!,
      (name, args) => post({ type: "action", name, args, rev: state.rev }),
      { openUrl: url => post({ type: "openUrl", url: String(url) }) },
    );

  const perform = (effect: FrameEffect) => {
    try {
      switch (effect.kind) {
        case "mount":
        case "update":
          // A view whose `mount` threw is mounted afresh on the next update:
          // a live subject may now have what it needed.
          if (mounted) mounted.update(props());
          else {
            element.replaceChildren();
            mounted = view.mount(element, props());
          }
          break;
        case "unmount":
          mounted?.unmount?.();
          mounted = undefined;
          element.replaceChildren();
          break;
        case "theme":
          applyTheme(document.documentElement, effect.theme);
          break;
        case "rejected":
          console.warn(`${effect.name} was refused: ${effect.reason}`);
          break;
      }
    } catch (err) {
      reportError(errorMessage(err));
    }
  };

  window.addEventListener("message", event => {
    if (event.source !== window.parent) return;
    const message = parseHostMessage(event.data);
    if (!message) return;
    const result = frameStep(view, state, message);
    state = result.state;
    for (const m of result.out) post(m);
    for (const effect of result.effects) perform(effect);
  });
  window.addEventListener("error", event =>
    reportError(errorMessage(event.error ?? event.message)),
  );
  window.addEventListener("unhandledrejection", event =>
    reportError(errorMessage(event.reason)),
  );

  post({
    type: "ready",
    protocol: PROTOCOL,
    surface: surface.name,
    ...(view.label !== undefined && { label: String(view.label) }),
  });
}
