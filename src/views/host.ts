// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The host side of a view's protocol, apart from the DOM: the channel that
 * holds what every frame on a surface is told, and the handling of each
 * message a frame sends — as a pure function, so it's tested without a
 * browser. See `specs/trace-visualizers.md` §A.1, §C.1.
 */

import {
  type FrameMessage,
  type HostMessage,
  PROTOCOL,
  type ViewTheme,
} from "./protocol.ts";
import type { Surface, SurfaceState } from "./surface.ts";
import type { ViewProps } from "./view.ts";

/** What the host knows of one frame. */
export interface FrameStatus {
  /** Whether it has sent a good `ready` and been sent `init`. */
  ready: boolean;
  /** The label from its `ready`. */
  label?: string;
  /** Its last `applies` answer. */
  applies?: boolean;
  /**
   * Why it can't be shown at all: a bad `ready`, an `applies` that threw,
   * no `ready` in time, or a navigation. It then gets no tab.
   */
  error?: string;
  /** The last error from rendering — shown in its tab, over the view. */
  renderError?: string;
  /**
   * Set once the frame was torn down for trying to navigate away. Its tab
   * stays, and says so.
   */
  stopped?: string;
}

/** A frame before it has said anything. */
export const NEW_FRAME: FrameStatus = { ready: false };

/** A change the channel sends every frame. */
export type ChannelChange = "subject" | "context";

/**
 * What every frame on one surface instance (one trace view, one dataset
 * view) is told: the subject, the host's context, and the `rev` stamped on
 * each change. Frames subscribe to it; the owner feeds it.
 */
export class ViewChannel<S, E, C> {
  private current: SurfaceState<S, C> | undefined;
  private revision = 0;
  private context: C;
  private listeners = new Set<
    (message: HostMessage<S, E, C>, change: ChannelChange) => void
  >();

  /** The surface whose frames this channel feeds. */
  readonly surface: Surface<S, E, C, ViewProps>;

  constructor(surface: Surface<S, E, C, ViewProps>, context: C) {
    this.surface = surface;
    this.context = context;
  }

  /** The subject and context, once there's a subject. */
  get state(): SurfaceState<S, C> | undefined {
    return this.current;
  }

  /** The `rev` of the last change. */
  get rev(): number {
    return this.revision;
  }

  /** Replaces the subject, sending frames a snapshot. */
  setSubject(subject: S): void {
    this.current = { subject, context: this.context };
    this.emit({ type: "subject", subject, rev: ++this.revision }, "subject");
  }

  /**
   * Applies an incremental change, sending frames the event. Ignored until
   * there's a subject to apply it to.
   */
  event(event: E): void {
    const { applyEvent } = this.surface;
    if (!this.current || !applyEvent) return;
    this.current = {
      ...this.current,
      subject: applyEvent(this.current.subject, event),
    };
    this.emit({ type: "event", event, rev: ++this.revision }, "subject");
  }

  /** Replaces the host's context, telling frames. */
  setContext(context: C): void {
    this.context = context;
    if (!this.current) return;
    this.current = { ...this.current, context };
    this.emit({ type: "context", context, rev: ++this.revision }, "context");
  }

  /** Listens for changes; returns the unsubscribe. */
  subscribe(
    listener: (message: HostMessage<S, E, C>, change: ChannelChange) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(message: HostMessage<S, E, C>, change: ChannelChange): void {
    for (const listener of this.listeners) listener(message, change);
  }
}

/** What the host does with one message from a frame. */
export interface HostReceipt {
  /** The frame's status after it. */
  status: FrameStatus;
  /** Messages to send the frame. */
  reply: HostMessage[];
  /** An action the surface's check accepted, for the owner to apply. */
  action?: { name: string; args: unknown; effect: "ephemeral" | "effectful" };
  /** A URL the view asked to open, for the host to confirm first. */
  openUrl?: string;
}

/** `url` if it's an absolute http(s) URL, else `undefined`. */
export function openableUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host's handling of one frame message — whatever the frame sent is
 * untrusted. `visible` is whether the frame is the one showing: a hidden
 * frame, mounted only to answer `applies`, can't act.
 */
export function hostReceive<S, E, C>(
  surface: Surface<S, E, C, ViewProps>,
  message: FrameMessage,
  {
    status,
    channel,
    theme,
    visible,
  }: {
    status: FrameStatus;
    channel: { state: SurfaceState<S, C> | undefined; rev: number };
    theme: ViewTheme;
    visible: boolean;
  },
): HostReceipt {
  const none: HostReceipt = { status, reply: [] };
  switch (message.type) {
    case "ready": {
      if (message.protocol !== PROTOCOL) {
        return {
          status: {
            ...status,
            error: `This view was built for protocol ${message.protocol}, and this evalution speaks ${PROTOCOL}. Rebuild it.`,
          },
          reply: [],
        };
      }
      if (message.error) {
        return { status: { ...status, error: message.error }, reply: [] };
      }
      if (message.surface !== surface.name) {
        return {
          status: {
            ...status,
            error: `This view is for the ${String(message.surface)} surface, not ${surface.name}.`,
          },
          reply: [],
        };
      }
      const state = channel.state;
      const ready: FrameStatus = {
        ready: true,
        ...(message.label !== undefined && { label: message.label }),
      };
      if (!state) return { status: ready, reply: [] };
      return {
        status: ready,
        reply: [
          {
            type: "init",
            subject: state.subject,
            rev: channel.rev,
            context: state.context,
            theme,
          },
        ],
      };
    }
    case "applies":
      if (!status.ready || status.error) return none;
      return { status: { ...status, applies: message.value }, reply: [] };
    case "error":
      if (message.during === "applies") {
        return {
          status: { ...status, applies: false, error: message.message },
          reply: [],
        };
      }
      return { status: { ...status, renderError: message.message }, reply: [] };
    case "openUrl": {
      if (!visible || !status.ready) return none;
      const url = openableUrl(message.url);
      return url ? { status, reply: [], openUrl: url } : none;
    }
    case "action": {
      if (!visible || !status.ready || !channel.state) return none;
      const reject = (reason: string): HostReceipt => ({
        status,
        reply: [{ type: "rejected", name: message.name, reason }],
      });
      const action = Object.hasOwn(surface.actions, message.name)
        ? surface.actions[message.name]
        : undefined;
      if (!action)
        return reject(`no action ${message.name} on ${surface.name}`);
      const problem = action.check(message.args, channel.state);
      if (problem) return reject(problem);
      if (action.effect === "effectful" && message.rev !== channel.rev) {
        // Proposed against something that has since changed: refuse it,
        // and resend what's current so the view redraws from it.
        return {
          status,
          reply: [
            {
              type: "rejected",
              name: message.name,
              reason: "made against an earlier version; try again",
            },
            {
              type: "context",
              context: channel.state.context,
              rev: channel.rev,
            },
          ],
        };
      }
      return {
        status,
        reply: [],
        action: {
          name: message.name,
          args: message.args,
          effect: action.effect,
        },
      };
    }
  }
}
