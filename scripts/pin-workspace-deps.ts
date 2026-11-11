// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Ties the packages to the current release, run by the `version` script after
 * `pnpm version` has bumped the root: moves every workspace package to the same
 * version, and sets the core's optional peers on the adapters to this major,
 * whose `/config` entries match the adapter contract it ships.
 *
 * `@evalution/sdk` dependencies are declared `workspace:*`, which pnpm replaces
 * with this exact version on publish, so a project only ever has one copy.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const rootManifest = readJson(join(root, "package.json"));
const version: string = rootManifest.version;
const major = version.split(".")[0];
const workspaces: string[] = readFileSync(
  join(root, "pnpm-workspace.yaml"),
  "utf8",
)
  .split("\n")
  .map(line => line.match(/^\s+-\s+(packages\/[\w-]+)\s*$/)?.[1])
  .filter((dir): dir is string => dir !== undefined);

for (const dir of workspaces) {
  const file = join(root, dir, "package.json");
  const manifest = readJson(file);
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const name of Object.keys(rootManifest.peerDependencies ?? {})) {
  if (name.startsWith("@evalution/")) {
    rootManifest.peerDependencies[name] = `^${major}.0.0`;
  }
}
writeFileSync(
  join(root, "package.json"),
  `${JSON.stringify(rootManifest, null, 2)}\n`,
);
