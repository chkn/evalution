// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Ties the packages to the current release, run by the `version` script after
 * `npm version` has bumped the workspaces: pins every `@evalution/sdk`
 * dependency exactly, so a project only ever has one copy, and sets the core's
 * optional peers on the adapters to this major, whose `/config` entries match
 * the adapter contract it ships.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const rootManifest = readJson(join(root, "package.json"));
const version: string = rootManifest.version;
const major = version.split(".")[0];

for (const file of [
  join(root, "package.json"),
  ...rootManifest.workspaces.map((w: string) => join(root, w, "package.json")),
]) {
  const manifest = readJson(file);
  if (manifest.dependencies?.["@evalution/sdk"]) {
    manifest.dependencies["@evalution/sdk"] = version;
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (name.startsWith("@evalution/")) {
      manifest.peerDependencies[name] = `^${major}.0.0`;
    }
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
