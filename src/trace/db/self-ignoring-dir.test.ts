// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSelfIgnoring } from "./self-ignoring-dir.ts";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

/** A fresh repository, with a store directory inside it. */
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-ignore-"));
  tmpDirs.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  return { root, git, dir: path.join(root, ".evalution", "traces") };
}

describe("mkdirSelfIgnoring", () => {
  it("ignores everything in a directory it creates, its .gitignore included", async () => {
    const { git, dir } = await repo();
    await mkdirSelfIgnoring(dir);
    await fs.writeFile(path.join(dir, "local.db"), "");
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf8")).toBe("*\n");
    // Nothing for git to see: the repository stays clean.
    expect(git("status", "--porcelain")).toBe("");
  });

  it("leaves a directory that already existed without a .gitignore", async () => {
    const { dir } = await repo();
    await fs.mkdir(dir, { recursive: true });
    await mkdirSelfIgnoring(dir);
    expect(existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });
});
