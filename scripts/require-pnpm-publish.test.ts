// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "require-pnpm-publish.ts");

function runGuard(userAgent: string | undefined) {
  const env = { ...process.env };
  delete env.npm_config_user_agent;
  if (userAgent !== undefined) env.npm_config_user_agent = userAgent;
  return spawnSync(process.execPath, [script], { env, encoding: "utf8" });
}

describe("require-pnpm-publish", () => {
  it("passes under pnpm", () => {
    const result = runGuard("pnpm/10.18.0 npm/? node/v26.8.1 darwin arm64");
    expect(result.status).toBe(0);
  });

  it("fails under npm and points at pnpm publish", () => {
    const result = runGuard(
      "npm/11.6.0 node/v26.8.1 darwin arm64 workspaces/false",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pnpm publish");
  });

  it("fails when no package manager is identified", () => {
    const result = runGuard(undefined);
    expect(result.status).not.toBe(0);
  });

  it("is wired into prepublishOnly of every published package", () => {
    const workspaces = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
      .split("\n")
      .map(line => line.match(/^\s+-\s+(packages\/[\w-]+)\s*$/)?.[1])
      .filter((dir): dir is string => dir !== undefined);
    for (const dir of [".", ...workspaces]) {
      const manifest = JSON.parse(
        readFileSync(join(root, dir, "package.json"), "utf8"),
      );
      if (manifest.private) continue;
      expect(
        manifest.scripts?.prepublishOnly,
        `${dir}/package.json prepublishOnly`,
      ).toMatch(/scripts\/require-pnpm-publish\.ts/);
    }
  });
});
