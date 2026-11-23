// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `ts-proppy` values cross from the SDK packages into the core, so a project
 * must resolve one copy for both. A package that asks for a range the core's
 * doesn't share makes npm nest the core's copy and drop the top-level one,
 * which the adapters' `/config` entries import: the config then fails to load.
 */
const SHARED = ["ts-proppy"];

const root = join(import.meta.dirname, "..");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const rootManifest = readJson(join(root, "package.json"));
const packages = readdirSync(join(root, "packages")).map(dir => ({
  dir,
  manifest: readJson(join(root, "packages", dir, "package.json")),
}));

describe("shared dependency ranges", () => {
  for (const name of SHARED) {
    const expected = rootManifest.dependencies[name];

    it.each(packages)(`asks for the core's ${name} range in $dir`, ({
      manifest,
    }) => {
      for (const kind of [
        "dependencies",
        "peerDependencies",
        "devDependencies",
      ]) {
        const range = manifest[kind]?.[name];
        if (range !== undefined)
          expect({ kind, range }).toEqual({ kind, range: expected });
      }
    });
  }
});
