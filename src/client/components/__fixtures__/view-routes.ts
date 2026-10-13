// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real view bundles for component tests: built in the test's Node process
 * by the server's `ViewRegistry`, and served to the page with the real
 * frame document and its sandboxing policy.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { MemoryFileProvider } from "../../../file-provider-memory";
import { viewFrameCsp, viewFrameDocument } from "../../../server/view-frame";
import { ViewRegistry } from "../../../server/view-registry";
import type { ViewList } from "../../../shared/types";

/** Builds `files` (paths relative to a project root) as a project's views. */
export async function buildViews(files: Record<string, string>) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "evalution-ct-views-"));
  const views = new ViewRegistry({
    fileProvider: new MemoryFileProvider(
      Object.fromEntries(
        Object.entries(files).map(([rel, code]) => [
          path.join(rootDir, rel),
          code,
        ]),
      ),
    ),
    rootDir,
  });
  const list = await views.list();
  if (list.errors.length > 0) {
    throw new Error(list.errors.map(e => `${e.uri}: ${e.message}`).join("\n"));
  }
  return { list, views };
}

/** Serves `/api/views` and the frame route from built views. */
export async function routeViews(
  page: Page,
  { list, views }: { list: ViewList; views: ViewRegistry },
) {
  await page.route("**/api/views", route => route.fulfill({ json: list }));
  await page.route("**/api/views/frame?*", async route => {
    const uri = new URL(route.request().url()).searchParams.get("uri") ?? "";
    const bundle = await views.bundle(uri);
    if (!bundle) return route.fulfill({ status: 404, body: "No such view" });
    const nonce = Math.random().toString(36).slice(2);
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": viewFrameCsp(nonce),
      },
      body: viewFrameDocument(bundle, nonce),
    });
  });
}

/**
 * Gives the page the policy the server gives the app's own pages: frames
 * from the frame route only. Set with a `<meta>`, which `frame-src` honors.
 */
export async function restrictFrames(page: Page) {
  await page.evaluate(() => {
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = `frame-src ${location.origin}/api/views/frame`;
    document.head.append(meta);
  });
}
