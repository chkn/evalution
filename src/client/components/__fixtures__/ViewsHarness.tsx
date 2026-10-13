// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useState } from "react";
import { ViewChannel } from "../../../views/host";
import { traceSurface } from "../../../views/surfaces/trace";
import { useSurfaceViews } from "../views/use-surface-views";
import { ViewProblemsButton, ViewTabButtons } from "../views/ViewTabs";

declare global {
  interface Window {
    /** The harness's channel, for a test to feed the trace through. */
    __viewChannel?: ViewChannel<unknown, unknown, unknown>;
  }
}

/**
 * The trace surface's views, hosted as TraceView hosts them — tabs, frames,
 * and `selectSpan` — over a channel the test drives through
 * `window.__viewChannel`, so it can stream spans in at its own pace.
 */
export function ViewsHarness() {
  const channel = useMemo(
    () =>
      new ViewChannel(traceSurface, { selectedSpanId: null as string | null }),
    [],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    window.__viewChannel = channel as ViewChannel<unknown, unknown, unknown>;
  }, [channel]);
  useEffect(
    () => channel.setContext({ selectedSpanId: selected }),
    [channel, selected],
  );
  const views = useSurfaceViews({
    surface: traceSurface,
    channel,
    activeUri: active,
    onAction: action => {
      if (action.name === "selectSpan") {
        setSelected((action.args as { spanId: string }).spanId);
      }
      return undefined;
    },
  });
  return (
    <div style={{ height: 420, display: "flex", flexDirection: "column" }}>
      <div className="trace-view-tab-list">
        <button
          type="button"
          className="trace-view-tab"
          onClick={() => setActive(null)}
        >
          Built-in
        </button>
        <ViewTabButtons
          tabs={views.tabs}
          active={views.shownUri}
          onSelect={setActive}
        />
        <ViewProblemsButton problems={views.problems} />
      </div>
      <output data-testid="selected">{selected ?? ""}</output>
      <div className="view-stack">
        {views.shownUri ? null : <p>Built-in content</p>}
        {views.layer}
      </div>
    </div>
  );
}
