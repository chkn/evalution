// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitVersioning, SNAPSHOT_REF_PREFIX } from "./git-versioning.ts";

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
  // No memo: each test's writes must be seen by the next snapshot.
  const versioning = (await GitVersioning.detect(dir, { memoTtlMs: 0 }))!;
  return { dir, git, write, commit, versioning };
}

describe("GitVersioning", () => {
  it("returns HEAD for a clean working tree", async () => {
    const { write, commit, versioning } = await makeRepo();
    await write("a.prompt.ts", "one");
    const head = await commit("first");

    const version = await versioning.snapshot();
    expect(version).toMatchObject({
      id: head,
      kind: "commit",
      message: "first",
    });
  });

  it("returns one snapshot for dirty trees with identical content", async () => {
    const { write, commit, versioning } = await makeRepo();
    await write("a.prompt.ts", "one");
    const head = await commit("first");
    await write("a.prompt.ts", "two");

    const first = await versioning.snapshot();
    const second = await versioning.snapshot();
    expect(first.kind).toBe("snapshot");
    expect(first.parent).toBe(head);
    expect(second.id).toBe(first.id);
    expect(await versioning.readFile(first.id, "a.prompt.ts")).toBe("two");

    // Back to the committed content: HEAD again, not a new snapshot.
    await write("a.prompt.ts", "one");
    expect((await versioning.snapshot()).id).toBe(head);
  });

  it("captures an untracked file but not an ignored one", async () => {
    const { write, commit, versioning } = await makeRepo();
    await write(".gitignore", "ignored.txt\n");
    await commit("ignore");
    await write("new.prompt.ts", "new");
    await write("ignored.txt", "secret");

    const version = await versioning.snapshot();
    expect(await versioning.readFile(version.id, "new.prompt.ts")).toBe("new");
    expect(
      await versioning.readFile(version.id, "ignored.txt"),
    ).toBeUndefined();
  });

  it("leaves the user's index, HEAD and stash byte-identical", async () => {
    const { dir, git, write, commit, versioning } = await makeRepo();
    await write("a.prompt.ts", "one");
    await commit("first");
    await write("a.prompt.ts", "two");
    await write("staged.ts", "staged");
    git("add", "staged.ts");
    await write("untracked.ts", "untracked");

    const indexPath = path.join(dir, ".git", "index");
    const before = {
      index: await fs.readFile(indexPath),
      head: git("rev-parse", "HEAD"),
      branch: git("symbolic-ref", "HEAD"),
      stash: git("stash", "list"),
      status: git("status", "--porcelain"),
    };
    await versioning.snapshot();
    expect(await fs.readFile(indexPath)).toEqual(before.index);
    expect(git("rev-parse", "HEAD")).toBe(before.head);
    expect(git("symbolic-ref", "HEAD")).toBe(before.branch);
    expect(git("stash", "list")).toBe(before.stash);
    expect(git("status", "--porcelain")).toBe(before.status);
    // Kept alive by a ref out of the way of `git branch`.
    expect(git("for-each-ref", SNAPSHOT_REF_PREFIX)).not.toBe("");
    expect(git("branch", "--list")).not.toContain("evalution");
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
    await versioning.snapshot();
    expect(await fs.readFile(indexPath)).toEqual(before);
  });

  it("captures a same-size edit made in the same second as the last add", async () => {
    const { write, commit, versioning } = await makeRepo();
    await write("a.prompt.ts", "one");
    await commit("first");
    await write("a.prompt.ts", "two");
    // Snapshot in a later second than the index was written, so only git's
    // racy-entry check tells the edit apart from the committed content.
    await new Promise(r => setTimeout(r, 1100));

    const version = await versioning.snapshot();
    expect(await versioning.readFile(version.id, "a.prompt.ts")).toBe("two");
  });

  it("snapshots a repository with an unborn HEAD", async () => {
    const { write, versioning } = await makeRepo();
    await write("a.prompt.ts", "first draft");

    const version = await versioning.snapshot();
    expect(version.kind).toBe("snapshot");
    expect(version.parent).toBeUndefined();
    expect(await versioning.readFile(version.id, "a.prompt.ts")).toBe(
      "first draft",
    );
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
      kind: "commit",
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

    it("lists a snapshot that changed the file, skips one that changed only another file, and collapses snapshots sharing a blob", async () => {
      const { write, commit, versioning } = await makeRepo();
      await write("a.prompt.ts", "one");
      await write("tools.ts", "t1");
      const head = await commit("first");

      // Changes only another file: not a version of a.prompt.ts.
      await write("tools.ts", "t2");
      const toolsOnly = await versioning.snapshot();
      // Changes the prompt.
      await write("a.prompt.ts", "two");
      const older = await versioning.snapshot();
      // Same prompt content, different tools: collapses with `older`.
      await new Promise(r => setTimeout(r, 1100)); // commit times are seconds
      await write("tools.ts", "t3");
      const newer = await versioning.snapshot();

      const history = await versioning.history("a.prompt.ts");
      const ids = history.map(v => v.id);
      expect(ids).not.toContain(toolsOnly.id);
      expect(ids).toContain(newer.id);
      expect(ids).not.toContain(older.id);
      expect(ids.at(-1)).toBe(head);
      expect(history[0]).toMatchObject({ id: newer.id, kind: "snapshot" });
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
