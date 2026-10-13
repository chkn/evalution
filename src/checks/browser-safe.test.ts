// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * Views import `evalution/checks`'s trace helpers, and views run in the
 * browser: a Node import creeping in would break every one of them. See
 * `specs/trace-visualizers.md` §G.
 */
describe("browser-safe entries", () => {
  for (const entry of [
    "../checks/index.ts",
    "../views/index.ts",
    "../views/datasets/index.ts",
  ]) {
    it(`${entry} bundles for the browser`, async () => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        logLevel: "silent",
      });
      expect(result.errors).toEqual([]);
    });
  }
});
