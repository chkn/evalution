// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ViewInfo } from "../../../shared/types.ts";
import { isSurfaceName } from "../../../shared/view-surfaces.ts";
import type { FrameStatus, ViewChannel } from "../../../views/host.ts";
import type { Surface } from "../../../views/surface.ts";
import type { ViewProps } from "../../../views/view.ts";
import { OpenUrlDialog } from "./OpenUrlDialog.tsx";
import { type AcceptedAction, ViewFrame } from "./ViewFrame.tsx";
import { useViewList } from "./views-store.ts";

/** A view tab: a view whose frame says it applies. */
export interface ViewTab {
  uri: string;
  label: string;
}

/** A view that can't be shown, and why. */
export interface ViewProblem {
  uri: string;
  message: string;
}

/** The label of a view that gave none: its file name. */
export function fallbackLabel(uri: string): string {
  const base = uri.split("/").at(-1) ?? uri;
  return base.replace(/\.(tsx?|jsx?)$/, "");
}

/**
 * A surface's views, as one surface instance (a trace view, a dataset view)
 * hosts them: one frame per view, mounted hidden to answer `applies` and
 * shown when its tab is active, plus the tabs and problems to draw. Frames
 * that don't apply are dropped once the subject is final, and mounted again
 * on its next change. See `specs/trace-visualizers.md` §C.2.
 */
export function useSurfaceViews<S, E, C>({
  surface,
  channel,
  activeUri,
  onAction,
}: {
  surface: Surface<S, E, C, ViewProps>;
  channel: ViewChannel<S, E, C>;
  /**
   * The view whose tab is chosen, if any. Its frame shows only while it
   * applies; until then, the owner shows its own content.
   */
  activeUri: string | null;
  /** Applies an action from the visible frame; returns why it's refused, if it is. */
  onAction: (action: AcceptedAction) => string | undefined;
}): {
  tabs: ViewTab[];
  problems: ViewProblem[];
  /**
   * The frames, absolutely filling their container. Render it in one stable
   * place: moving an iframe in the DOM reloads it.
   */
  layer: ReactNode;
  /** {@link activeUri} if its view applies, else `null`. */
  shownUri: string | null;
} {
  const list = useViewList();
  const views = useMemo(
    () => list.views.filter(v => v.surface === surface.name),
    [list, surface.name],
  );
  const [statuses, setStatuses] = useState<Record<string, FrameStatus>>({});
  /** Views whose frames were dropped, by uri. */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const droppedRef = useRef(dropped);
  droppedRef.current = dropped;
  /** Bumped per uri when a dropped frame is mounted again, for a fresh frame. */
  const [generations, setGenerations] = useState<Record<string, number>>({});
  const [subjectTick, setSubjectTick] = useState(channel.state ? 1 : 0);
  const [openUrl, setOpenUrl] = useState<{ uri: string; url: string } | null>(
    null,
  );

  useEffect(
    () =>
      channel.subscribe((_, change) => {
        if (change !== "subject") return;
        setSubjectTick(t => t + 1);
        const uris = [...droppedRef.current];
        if (uris.length === 0) return;
        // A change after the subject was final (a late span): those frames'
        // answers may no longer hold, so they're asked again.
        setGenerations(g => {
          const next = { ...g };
          for (const uri of uris) next[uri] = (next[uri] ?? 0) + 1;
          return next;
        });
        setDropped(new Set());
      }),
    [channel],
  );

  const frameKey = useCallback(
    (v: ViewInfo) => `${v.uri}@${v.moduleVersion}#${generations[v.uri] ?? 0}`,
    [generations],
  );

  /** The active view, if it applies: only then is its frame shown. */
  const shownUri = (() => {
    const v = views.find(v => v.uri === activeUri);
    const status = v && statuses[frameKey(v)];
    return v && !dropped.has(v.uri) && status?.ready && status.applies
      ? v.uri
      : null;
  })();

  // Once the subject is final, a frame's `false` is too: drop it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `subjectTick` re-checks finality as the subject changes.
  useEffect(() => {
    const state = channel.state;
    if (!state || !surface.isFinal(state.subject)) return;
    const drop = views.filter(v => {
      const status = statuses[frameKey(v)];
      return (
        !dropped.has(v.uri) &&
        status?.ready &&
        status.applies === false &&
        !status.error &&
        v.uri !== shownUri
      );
    });
    if (drop.length > 0) {
      setDropped(new Set([...dropped, ...drop.map(v => v.uri)]));
    }
  }, [statuses, subjectTick, views, dropped, frameKey, shownUri]);

  const statusOf = (v: ViewInfo) => statuses[frameKey(v)];

  const tabs: ViewTab[] = views.flatMap(v => {
    const status = statusOf(v);
    return !dropped.has(v.uri) &&
      status?.ready &&
      status.applies &&
      !status.error
      ? [{ uri: v.uri, label: status.label ?? fallbackLabel(v.uri) }]
      : [];
  });

  const problems: ViewProblem[] = [
    ...list.errors
      .filter(
        e =>
          e.surface === surface.name ||
          e.surface === undefined ||
          !isSurfaceName(e.surface),
      )
      .map(e => ({ uri: e.uri, message: e.message })),
    ...views.flatMap(v => {
      const error = statusOf(v)?.error;
      return error ? [{ uri: v.uri, message: error }] : [];
    }),
  ];

  const active = views.find(v => v.uri === shownUri);
  const activeStatus = active && statusOf(active);
  const labelOf = (uri: string) =>
    tabs.find(t => t.uri === uri)?.label ?? fallbackLabel(uri);

  const layer = (
    <div className={`view-frames${active ? " view-frames-active" : ""}`}>
      {subjectTick > 0 &&
        views
          .filter(v => !dropped.has(v.uri))
          .map(v => {
            const key = frameKey(v);
            return (
              <ViewFrame
                key={key}
                view={v}
                surface={surface}
                channel={channel}
                visible={v.uri === shownUri}
                onStatus={status => setStatuses(s => ({ ...s, [key]: status }))}
                onAction={onAction}
                onOpenUrl={url => setOpenUrl({ uri: v.uri, url })}
              />
            );
          })}
      {activeStatus?.stopped && (
        <div className="view-frame-message" role="alert">
          {activeStatus.stopped}
        </div>
      )}
      {activeStatus?.renderError && !activeStatus.stopped && (
        <div className="view-frame-error" role="alert">
          {labelOf(active!.uri)} failed: {activeStatus.renderError}
        </div>
      )}
      {openUrl && (
        <OpenUrlDialog
          viewLabel={labelOf(openUrl.uri)}
          url={openUrl.url}
          onCancel={() => setOpenUrl(null)}
        />
      )}
    </div>
  );

  return { tabs, problems, layer, shownUri };
}

/** Recalls a remembered tab. A convenience: storage may refuse. */
export function rememberedTab(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remembers a tab for {@link rememberedTab}. */
export function rememberTab(key: string, tab: string): void {
  try {
    localStorage.setItem(key, tab);
  } catch {
    /* ignore */
  }
}
