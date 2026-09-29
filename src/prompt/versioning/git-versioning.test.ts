// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitVersioning } from "./git-versioning.ts";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

/** A fresh repository with an identity configured, and helpers over it. */
async function makeRepo() {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "evalution-git-")),
  );
  tmpDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  const write = (rel: string, content: string) =>
    fs
      .mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
      .then(() => fs.writeFile(path.join(dir, rel), content));
  const commit = async (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const versioning = (await GitVersioning.detect(dir))!;
  return { dir, git, write, commit, versioning };
}

describe("GitVersioning", () => {
  it("reports HEAD, and whether the working tree is clean", async () => {
    const { write, commit, versioning } = await makeRepo();
    await write("a.prompt.ts", "one");
    const head = await commit("first");
    expect(await versioning.head()).toEqual({
      commit: expect.objectContaining({ id: head, message: "first" }),
      clean: true,
    });

    await write("a.prompt.ts", "two");
    expect(await versioning.head()).toMatchObject({
      commit: { id: head },
      clean: false,
    });

    // Back to the committed content: clean again.
    await write("a.prompt.ts", "one");
    expect((await versioning.head()).clean).toBe(true);
  });

  it("counts an untracked file as uncommitted, but not an ignored one", async () => {
    const { write, commit, versioning } = await makeRepo();
    await write(".gitignore", "ignored.txt\n");
    await commit("ignore");
    await write("ignored.txt", "secret");
    expect((await versioning.head()).clean).toBe(true);
    await write("new.ts", "new");
    expect((await versioning.head()).clean).toBe(false);
  });

  it("doesn't refresh the user's index when a file's stat changed but not its content", async () => {
    const { dir, write, commit, versioning } = await makeRepo();
    await write("a.prompt.ts", "one");
    await commit("first");
    // Same content, new mtime: a plain `git status` would take the index
    // lock and rewrite the index to record the new stat.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(dir, "a.prompt.ts"), future, future);

    const indexPath = path.join(dir, ".git", "index");
    const before = await fs.readFile(indexPath);
    await versioning.head();
    expect(await fs.readFile(indexPath)).toEqual(before);
  });

  it("has no commit before the first one", async () => {
    const { write, versioning } = await makeRepo();
    await write("a.prompt.ts", "first draft");
    expect(await versioning.head()).toEqual({ clean: false });
    expect(await versioning.history("a.prompt.ts")).toEqual([]);
  });

  it("resolves paths relative to a root below the repository's top level", async () => {
    const { dir, write, commit } = await makeRepo();
    await write("app/prompts/a.prompt.ts", "nested");
    const head = await commit("nested");
    const versioning = (await GitVersioning.detect(path.join(dir, "app")))!;
    expect(await versioning.readFile(head, "prompts/a.prompt.ts")).toBe(
      "nested",
    );
    expect(await versioning.history("prompts/a.prompt.ts")).toHaveLength(1);
  });

  it("describes a version, and nothing for an id that isn't one", async () => {
    const { write, commit, versioning } = await makeRepo();
    await write("a.prompt.ts", "one");
    const head = await commit("first");
    expect(await versioning.get(head)).toMatchObject({
      id: head,
      message: "first",
      author: "Test",
    });
    expect(await versioning.get("--output=/tmp/x")).toBeUndefined();
    expect(await versioning.get("deadbeef")).toBeUndefined();
  });

  describe("history", () => {
    it("lists commits that touched the file and skips ones that didn't", async () => {
      const { write, commit, versioning } = await makeRepo();
      await write("a.prompt.ts", "one");
      const first = await commit("a one");
      await write("b.prompt.ts", "other");
      await commit("b only");
      await write("a.prompt.ts", "two");
      const third = await commit("a two");

      const ids = (await versioning.history("a.prompt.ts")).map(v => v.id);
      expect(ids).toEqual([third, first]);
    });

    it("pages with before and limit", async () => {
      const { write, commit, versioning } = await makeRepo();
      const commits: string[] = [];
      for (const n of [1, 2, 3]) {
        await write("a.prompt.ts", String(n));
        commits.unshift(await commit(`c${n}`));
      }
      const page = await versioning.history("a.prompt.ts", {
        before: commits[0],
        limit: 1,
      });
      expect(page.map(v => v.id)).toEqual([commits[1]]);
    });
  });

  it("detects no repository outside one", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-nogit-"));
    tmpDirs.push(dir);
    expect(await GitVersioning.detect(dir)).toBeUndefined();
  });
});
