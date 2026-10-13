// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ViewInfo } from "../../../shared/types.ts";
import { viewFrameUrl } from "../../../shared/view-surfaces.ts";
import {
  type FrameStatus,
  hostReceive,
  NEW_FRAME,
  type ViewChannel,
} from "../../../views/host.ts";
import {
  type HostMessage,
  parseFrameMessage,
} from "../../../views/protocol.ts";
import type { Surface } from "../../../views/surface.ts";
import type { ViewProps } from "../../../views/view.ts";
import { useViewTheme } from "./view-theme.ts";

/** How long a frame has to say `ready` before it's given up on. */
export const READY_TIMEOUT_MS = 8000;

/** An action a frame asked for, which its surface's check accepted. */
export interface AcceptedAction {
  name: string;
  args: unknown;
  effect: "ephemeral" | "effectful";
}

interface Props<S, E, C> {
  view: ViewInfo;
  surface: Surface<S, E, C, ViewProps>;
  channel: ViewChannel<S, E, C>;
  /** Whether this is the frame showing. Only it may act. */
  visible: boolean;
  onStatus: (status: FrameStatus) => void;
  /** Applies an accepted action; returns why it's refused, if it is. */
  onAction: (action: AcceptedAction) => string | undefined;
  onOpenUrl: (url: string) => void;
}

/**
 * One view's sandboxed frame, and the host side of its protocol: every
 * message is checked to come from this frame's window, and is then handled
 * by {@link hostReceive}. A frame that loads a second document — a
 * navigation, which the page's `frame-src` should already have stopped — is
 * torn down. See `specs/trace-visualizers.md` §C.
 */
export function ViewFrame<S, E, C>({
  view,
  surface,
  channel,
  visible,
  onStatus,
  onAction,
  onOpenUrl,
}: Props<S, E, C>) {
  const { uri } = view;
  const ref = useRef<HTMLIFrameElement>(null);
  const theme = useViewTheme();
  const [stopped, setStopped] = useState(false);
  // What the message handler reads; kept current without re-subscribing.
  const latest = useRef({ visible, theme, onStatus, onAction, onOpenUrl });
  latest.current = { visible, theme, onStatus, onAction, onOpenUrl };
  const status = useRef<FrameStatus>(NEW_FRAME);
  /** Whether the frame has been sent `init`, after which it gets changes. */
  const inited = useRef(false);

  // A layout effect, so the listener is in place before the frame can load
  // and say `ready`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a frame is keyed by its uri and version, so it never changes them.
  useLayoutEffect(() => {
    const setStatus = (next: FrameStatus) => {
      status.current = next;
      latest.current.onStatus(next);
    };
    const post = (message: HostMessage) =>
      ref.current?.contentWindow?.postMessage(message, "*");
    const sendInit = () => {
      const state = channel.state;
      if (!state) return;
      inited.current = true;
      post({
        type: "init",
        subject: state.subject,
        rev: channel.rev,
        context: state.context,
        theme: latest.current.theme,
      });
    };

    const onMessage = (event: MessageEvent) => {
      // An opaque origin's `event.origin` is "null", which names nothing:
      // only the window is proof of where a message came from.
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      const receipt = hostReceive(surface, message, {
        status: status.current,
        channel,
        theme: latest.current.theme,
        visible: latest.current.visible,
      });
      if (receipt.status !== status.current) setStatus(receipt.status);
      for (const reply of receipt.reply) {
        if (reply.type === "init") inited.current = true;
        post(reply);
      }
      if (receipt.action) {
        const refusal = latest.current.onAction(receipt.action);
        if (refusal) {
          post({
            type: "rejected",
            name: receipt.action.name,
            reason: refusal,
          });
          const state = channel.state;
          if (state) {
            post({ type: "context", context: state.context, rev: channel.rev });
          }
        }
      }
      if (receipt.openUrl) latest.current.onOpenUrl(receipt.openUrl);
    };
    window.addEventListener("message", onMessage);

    const unsubscribe = channel.subscribe(message => {
      if (!status.current.ready) return;
      // The frame renders again, and reports any error afresh.
      if (status.current.renderError) {
        const { renderError: _, ...rest } = status.current;
        setStatus(rest);
      }
      if (inited.current) post(message);
      else sendInit();
    });

    const timeout = setTimeout(() => {
      if (!status.current.ready && !status.current.error) {
        setStatus({
          ...status.current,
          error: `Didn't start within ${READY_TIMEOUT_MS / 1000} seconds.`,
        });
      }
    }, READY_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  // Tell the frame when the theme changes.
  useEffect(() => {
    if (inited.current) {
      ref.current?.contentWindow?.postMessage({ type: "theme", theme }, "*");
    }
  }, [theme]);

  /** Counts documents: the first is the view; a second means it navigated. */
  const loads = useRef(0);
  const onLoad = () => {
    if (++loads.current < 2) return;
    setStopped(true);
    const next = {
      ...status.current,
      stopped: "This view tried to navigate away and was stopped.",
    };
    status.current = next;
    onStatus(next);
  };

  if (stopped) return null;
  return (
    <iframe
      ref={ref}
      className={`view-frame${visible ? " view-frame-visible" : ""}`}
      title={status.current.label ?? uri}
      src={viewFrameUrl(uri, view.moduleVersion)}
      // Scripts only: no same-origin (so an opaque origin), no popups (links
      // go through the host), no forms, no top navigation.
      sandbox="allow-scripts"
      onLoad={onLoad}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
    />
  );
}
