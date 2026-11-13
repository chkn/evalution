// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import { watchFocus } from "./usePullOnFocus.ts";

function page() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  let time = 0;
  return {
    win,
    doc,
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("watchFocus", () => {
  it("calls back when the window regains focus or the tab is shown again", () => {
    const { win, doc, now } = page();
    const onFocus = vi.fn();
    watchFocus({ win, doc, onFocus, minIntervalMs: 0, now });

    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));

    expect(onFocus).toHaveBeenCalledTimes(2);
  });

  it("ignores the tab being hidden", () => {
    const { win, doc, now } = page();
    const onFocus = vi.fn();
    watchFocus({ win, doc, onFocus, minIntervalMs: 0, now });

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));

    expect(onFocus).not.toHaveBeenCalled();
  });

  it("calls back at most once per interval", () => {
    const { win, doc, now, advance } = page();
    const onFocus = vi.fn();
    watchFocus({ win, doc, onFocus, minIntervalMs: 10_000, now });

    win.dispatchEvent(new Event("focus"));
    // Showing a tab focuses its window too: one call for both.
    doc.dispatchEvent(new Event("visibilitychange"));
    advance(9_999);
    win.dispatchEvent(new Event("focus"));
    expect(onFocus).toHaveBeenCalledTimes(1);

    advance(1);
    win.dispatchEvent(new Event("focus"));
    expect(onFocus).toHaveBeenCalledTimes(2);
  });

  it("stops when unsubscribed", () => {
    const { win, doc, now } = page();
    const onFocus = vi.fn();
    const stop = watchFocus({ win, doc, onFocus, minIntervalMs: 0, now });

    stop();
    win.dispatchEvent(new Event("focus"));

    expect(onFocus).not.toHaveBeenCalled();
  });
});
