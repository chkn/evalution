// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import type { ReactElement } from "react";
import type { Span, TraceWithSpans } from "../../../shared/types";
import { ViewsHarness } from "./ViewsHarness";
import { buildViews, restrictFrames, routeViews } from "./view-routes";

/**
 * Trace views in their sandboxed frames, as a real browser runs them
 * (`specs/trace-visualizers.md` §H step 3). Each is plain DOM, so the test
 * project needs no React.
 */
const VIEWS = {
  // Applies once there are two spans; lists them as links that select one.
  ".evalution/views/traces/counter.ts": `
    import { traceView } from "evalution/views";
    function render(el, p) {
      el.innerHTML = "";
      const count = document.createElement("p");
      count.id = "count";
      count.textContent = p.trace.spans.length + " spans";
      el.append(count);
      for (const s of p.trace.spans) {
        const b = document.createElement("button");
        b.textContent = "select " + s.id + (p.selectedSpanId === s.id ? " (selected)" : "");
        b.onclick = () => p.selectSpan(s.id);
        el.append(b);
      }
      const open = document.createElement("button");
      open.textContent = "open link";
      open.onclick = () => p.openUrl("https://example.com/report?run=42");
      el.append(open);
    }
    export default traceView({
      label: "Counter",
      applies: t => t.spans.length >= 2,
      mount(el, p) { render(el, p); return { update: q => render(el, q) }; },
    });
  `,
  ".evalution/views/traces/thrower.ts": `
    import { traceView } from "evalution/views";
    export default traceView({
      label: "Thrower",
      applies: () => true,
      mount() { throw new Error("kaboom"); },
    });
  `,
  // Can't draw a trace with fewer than two spans: its mount throws.
  ".evalution/views/traces/recovers.ts": `
    import { traceView } from "evalution/views";
    export default traceView({
      label: "Recovers",
      applies: () => true,
      mount(el, p) {
        if (p.trace.spans.length < 2) throw new Error("not enough spans yet");
        el.textContent = p.trace.spans.length + " spans";
        return { update() {} };
      },
    });
  `,
  // Tries the network every way a page can.
  ".evalution/views/traces/fetcher.ts": `
    import { traceView } from "evalution/views";
    export default traceView({
      label: "Fetcher",
      applies: () => true,
      mount(el) {
        el.textContent = "pending";
        fetch("http://localhost:3101/leak?via=fetch").then(
          () => { el.textContent = "fetched"; },
          () => { el.textContent = "fetch blocked"; },
        );
        const img = new Image();
        img.src = "http://localhost:3101/leak?via=img";
        return { update() {} };
      },
    });
  `,
  // Tries to navigate its own frame away, carrying data in the URL.
  ".evalution/views/traces/navigator.ts": `
    import { traceView } from "evalution/views";
    export default traceView({
      label: "Navigator",
      applies: () => true,
      mount(el) {
        const loc = document.createElement("button");
        loc.textContent = "location";
        loc.onclick = () => { location.href = "http://localhost:3101/leak?via=location"; };
        const link = document.createElement("a");
        link.textContent = "link";
        link.href = "https://example.com/leak?via=link";
        const refresh = document.createElement("button");
        refresh.textContent = "refresh";
        refresh.onclick = () => {
          const meta = document.createElement("meta");
          meta.httpEquiv = "refresh";
          meta.content = "0;url=http://localhost:3101/leak?via=refresh";
          document.head.append(meta);
        };
        el.append(loc, link, refresh);
        return { update() {} };
      },
    });
  `,
};

const span = (id: string): Span => ({
  id,
  traceId: "t1",
  name: id,
  kind: "TOOL",
  startTime: 1,
});

const TRACE: TraceWithSpans = {
  trace: { id: "t1", name: "run", startTime: 0, status: "running" },
  spans: [span("root")],
};

let built: Awaited<ReturnType<typeof buildViews>>;
test.beforeAll(async () => {
  built = await buildViews(VIEWS);
});

/**
 * Every request for `/leak` that got out of the browser — routed, or
 * answered — which no view should ever manage. (A request the frame's CSP
 * refused can still be *reported*, failed with `csp`, before it's sent.)
 */
async function watchLeaks(page: Page) {
  const leaks: string[] = [];
  page.on("response", r => {
    if (r.url().includes("/leak")) leaks.push(`answered ${r.url()}`);
  });
  await page.route("**/leak*", route => {
    leaks.push(`sent ${route.request().url()}`);
    return route.fulfill({ body: "leaked" });
  });
  return leaks;
}

async function start(page: Page, mount: (c: ReactElement) => Promise<unknown>) {
  await restrictFrames(page);
  await routeViews(page, built);
  const leaks = await watchLeaks(page);
  await mount(<ViewsHarness />);
  await page.waitForFunction(() => !!window.__viewChannel);
  await page.evaluate(t => window.__viewChannel!.setSubject(t), TRACE);
  return leaks;
}

const tab = (page: Page, name: string) =>
  page.locator(".trace-view-tab-list").getByRole("button", { name });
const frame = (page: Page, label: string) =>
  page.frameLocator(`iframe[title="${label}"]`);

test("a view's tab appears once it applies, mid-stream, and its links select spans", async ({
  mount,
  page,
}) => {
  await start(page, mount);
  await expect(tab(page, "Fetcher")).toBeVisible();
  await expect(tab(page, "Counter")).toHaveCount(0);

  await page.evaluate(
    s => window.__viewChannel!.event({ type: "span-start", span: s }),
    span("tool1"),
  );
  await tab(page, "Counter").click();
  await expect(page.getByText("Built-in content")).toHaveCount(0);
  const counter = frame(page, "Counter");
  await expect(counter.locator("#count")).toHaveText("2 spans");

  await counter.getByRole("button", { name: "select tool1" }).click();
  await expect(page.getByTestId("selected")).toHaveText("tool1");
  // The host's selection comes back as context.
  await expect(
    counter.getByRole("button", { name: "select tool1 (selected)" }),
  ).toBeVisible();
});

test("a view's link opens only after the viewer confirms, showing the whole URL", async ({
  mount,
  page,
}) => {
  await start(page, mount);
  await page.evaluate(
    s => window.__viewChannel!.event({ type: "span-start", span: s }),
    span("tool1"),
  );
  await tab(page, "Counter").click();
  await frame(page, "Counter")
    .getByRole("button", { name: "open link" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Open link" });
  await expect(dialog).toContainText("example.com");
  await expect(dialog).toContainText("https://example.com/report?run=42");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a throwing view is contained: its tab says so, and the others keep working", async ({
  mount,
  page,
}) => {
  await start(page, mount);
  await tab(page, "Thrower").click();
  await expect(page.locator(".view-frame-error")).toContainText("kaboom");
  await tab(page, "Fetcher").click();
  await expect(page.locator(".view-frame-error")).toHaveCount(0);
  await expect(frame(page, "Fetcher").locator("body")).toContainText("blocked");
});

test("a view that failed to render on a partial trace recovers when more arrives", async ({
  mount,
  page,
}) => {
  await start(page, mount);
  await tab(page, "Recovers").click();
  await expect(page.locator(".view-frame-error")).toContainText(
    "not enough spans yet",
  );
  await page.evaluate(
    s => window.__viewChannel!.event({ type: "span-start", span: s }),
    span("tool1"),
  );
  await expect(frame(page, "Recovers").locator("body")).toHaveText("2 spans");
  await expect(page.locator(".view-frame-error")).toHaveCount(0);
});

test("a view can't reach the network", async ({ mount, page }) => {
  const leaks = await start(page, mount);
  await tab(page, "Fetcher").click();
  await expect(frame(page, "Fetcher").locator("body")).toHaveText(
    "fetch blocked",
  );
  expect(leaks).toEqual([]);
});

for (const via of ["location", "link", "refresh"] as const) {
  test(`a view can't navigate its frame away (${via})`, async ({
    mount,
    page,
    browserName,
  }) => {
    const leaks = await start(page, mount);
    await tab(page, "Navigator").click();
    const navigator = frame(page, "Navigator");
    await (via === "link"
      ? navigator.getByRole("link", { name: "link" })
      : navigator.getByRole("button", { name: via })
    ).click();
    if (browserName === "firefox") {
      // Firefox refuses the navigation without loading anything into the
      // frame, so there's no second load to notice: the view stays put.
      await page.waitForTimeout(500);
      await expect(
        navigator.getByRole("button", { name: "location" }),
      ).toBeVisible();
    } else {
      // Chromium and WebKit load an error page into the frame, which the
      // host notices and tears the frame down for.
      await expect(page.locator(".view-frame-message")).toHaveText(
        "This view tried to navigate away and was stopped.",
      );
    }
    expect(leaks).toEqual([]);
  });
}
