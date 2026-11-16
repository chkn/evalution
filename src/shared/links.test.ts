// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as links from "./links.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Shipped source: everything under these, but tests and their fixtures. */
function shippedSources(): string[] {
  return ["src", "packages/sdk/src"].flatMap(dir =>
    readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .map(file => path.join(dir, file))
      .filter(
        file =>
          /\.tsx?$/.test(file) &&
          !/\.(test|pw)\.tsx?$/.test(file) &&
          !file.includes("__fixtures__"),
      ),
  );
}

describe("links", () => {
  it("all go through the link host", () => {
    const urls = Object.entries(links).filter(([name]) => name !== "LINK_HOST");
    expect(urls.length).toBeGreaterThan(0);
    for (const [, url] of urls) {
      expect(url).toMatch(/^https:\/\/l\.evalut\.io\/s\/[a-z.-]+$/);
    }
  });

  // A link straight to the site or our repo can't be moved without a release.
  it("are the only way shipped source links to evalut.io or our repo", () => {
    const direct = /https:\/\/(evalut\.io|github\.com\/chkn)\//;
    const offenders = shippedSources().filter(file =>
      direct.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
