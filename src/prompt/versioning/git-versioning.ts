// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { spawn } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  realpath,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  VersionHistoryOptions,
  VersionId,
  VersionInfo,
  VersioningAdapter,
} from "./versioning-adapter.ts";

/** Where snapshot commits are kept alive, one ref per tree. */
export const SNAPSHOT_REF_PREFIX = "refs/evalution/snapshots/";

/** The message every snapshot commit carries. */
export const SNAPSHOT_MESSAGE = "evalution: uncommitted changes";

/** How long a snapshot stays memoized without a watcher event. */
const DEFAULT_MEMO_TTL_MS = 2000;

/** Commits `git log` is asked for when listing a file's history. */
const MAX_HISTORY_COMMITS = 1000;

/**
 * A commit id (or abbreviation). Every id reaching git is checked against
 * this, so nothing a client sends can be read as an option.
 */
const OBJECT_ID = /^[0-9a-f]{4,64}$/;

/** What running git produced. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Thrown when git exits non-zero where that isn't an expected answer. */
class GitError extends Error {
  constructor(args: readonly string[], result: GitResult) {
    super(
      `git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`,
    );
  }
}

/** Runs git and collects its output. Rejects only if git can't be started. */
function runGit(
  cwd: string,
  args: readonly string[],
  { env, input }: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      // No optional locks: a read like `status` would otherwise take the
      // index lock to refresh the user's index — rewriting it, and failing
      // a `git commit` they run at the same moment.
      env: { ...(env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

/** `git log` format for {@link parseLogEntry}: fields NUL-separated, records RS-terminated. */
const LOG_FORMAT = "--format=%H%x00%P%x00%an%x00%ct%x00%s%x1e";

interface LogEntry {
  id: string;
  parents: string[];
  author: string;
  time: number;
  message: string;
}

function parseLog(stdout: string): LogEntry[] {
  return stdout
    .split("\x1e")
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [id, parents, author, time, message] = record.split("\0");
      return {
        id,
        parents: parents ? parents.split(" ") : [],
        author,
        time: Number(time) * 1000,
        message,
      };
    });
}

/** Options for {@link GitVersioning}. */
export interface GitVersioningOptions {
  /** The repository's top-level directory. */
  repoDir: string;
  /**
   * The directory the adapter's relative paths are relative to, spelled the
   * way git spells {@link repoDir} (symlinks resolved).
   */
  rootDir: string;
  /** How long a snapshot stays memoized. Defaults to two seconds. */
  memoTtlMs?: number;
}

/**
 * A {@link VersioningAdapter} for a git repository. A version is a commit: a
 * real one, or — when the working tree is dirty — a snapshot of it, recorded
 * as an unreferenced commit **without touching the user's index, branch or
 * stash**, and kept alive by a ref under `refs/evalution/snapshots/`.
 *
 * Shells out to `git`; there is no library dependency. See
 * `specs/prompt-versions-and-variations.md` §C.
 */
export class GitVersioning implements VersioningAdapter {
  readonly id = "git";

  readonly repoDir: string;
  readonly rootDir: string;
  private readonly memoTtlMs: number;

  /** The last snapshot, until a watcher event or the TTL retires it. */
  private memo?: { value: VersionInfo; expires: number };
  /** Bumped by {@link invalidate}, so a snapshot in flight doesn't memoize stale state. */
  private generation = 0;
  private inflight?: Promise<VersionInfo>;

  constructor({
    repoDir,
    rootDir,
    memoTtlMs = DEFAULT_MEMO_TTL_MS,
  }: GitVersioningOptions) {
    this.repoDir = repoDir;
    this.rootDir = rootDir;
    this.memoTtlMs = memoTtlMs;
  }

  /**
   * Builds a `GitVersioning` for the repository containing `rootDir`, or
   * returns `undefined` when there is none — or no `git` binary to run, which
   * is reported once, here, as "versioning unavailable" rather than failing
   * later.
   */
  static async detect(
    rootDir: string,
    options: { memoTtlMs?: number } = {},
  ): Promise<GitVersioning | undefined> {
    let result: GitResult;
    try {
      result = await runGit(rootDir, ["rev-parse", "--show-toplevel"]);
    } catch (err: any) {
      console.warn(
        `⚠️ git versioning unavailable (${err?.code === "ENOENT" ? "no git binary found" : err?.message}); prompt versions will cover prompt files only.`,
      );
      return undefined;
    }
    if (result.code !== 0) return undefined;
    return new GitVersioning({
      repoDir: result.stdout.trim(),
      // git reports the top level with symlinks resolved (`/private/var` for
      // `/var` on macOS), so the root has to be too for paths to relate.
      rootDir: await realpath(rootDir),
      ...options,
    });
  }

  invalidate(): void {
    this.memo = undefined;
    this.generation++;
  }

  snapshot(): Promise<VersionInfo> {
    if (this.memo && Date.now() < this.memo.expires) {
      return Promise.resolve(this.memo.value);
    }
    if (this.inflight) return this.inflight;

    const generation = this.generation;
    const inflight = this.takeSnapshot().then(value => {
      if (this.generation === generation) {
        this.memo = { value, expires: Date.now() + this.memoTtlMs };
      }
      return value;
    });
    this.inflight = inflight;
    const clear = () => {
      if (this.inflight === inflight) this.inflight = undefined;
    };
    inflight.then(clear, clear);
    return inflight;
  }

  private async takeSnapshot(): Promise<VersionInfo> {
    const head = await this.resolve("HEAD");

    // The clean case — by far the most common — costs one `status`.
    if (head) {
      const status = await this.git(["status", "--porcelain"]);
      if (status.trim() === "") return this.info(head);
    }

    const tree = await this.dirtyTree();
    if (head && tree === (await this.resolve(`${head}^{tree}`))) {
      return this.info(head);
    }

    // The tree is the identity: the same dirty state always resolves to the
    // same snapshot. The commit's own hash can't be, as it includes a time.
    const ref = `${SNAPSHOT_REF_PREFIX}${tree}`;
    const existing = await this.resolve(ref);
    if (existing) return this.info(existing);

    const commit = await this.commitTree(tree, head);
    await this.git(["update-ref", ref, commit]);
    return this.info(commit);
  }

  /**
   * Writes the working tree — untracked files included, ignored ones not —
   * as a tree object, through a throwaway copy of the index so the user's own
   * is never touched. Starting from a copy of the real index keeps it
   * incremental: `add -A` rehashes only files whose stat changed.
   */
  private async dirtyTree(): Promise<string> {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "evalution-index-"));
    try {
      const indexFile = path.join(tmp, "index");
      const realIndex = path.resolve(
        this.repoDir,
        (await this.git(["rev-parse", "--git-path", "index"])).trim(),
      );
      try {
        await copyFile(realIndex, indexFile);
        // Keep the real index's times: git trusts an entry's stat only when
        // it's older than the index itself ("racy git"), so a copy stamped
        // now would pass off a same-size edit made in the same second as the
        // last `git add` as unchanged.
        const { atime, mtime } = await stat(realIndex);
        await utimes(indexFile, atime, mtime);
      } catch (err: any) {
        // No index yet: a repo nothing was ever added to.
        if (err?.code !== "ENOENT") throw err;
      }
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      await this.git(["add", "-A"], { env });
      return (await this.git(["write-tree"], { env })).trim();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async commitTree(tree: string, parent?: string): Promise<string> {
    const args = [
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "-m",
      SNAPSHOT_MESSAGE,
    ];
    const result = await runGit(this.repoDir, args);
    if (result.code === 0) return result.stdout.trim();
    // A repo with no identity configured (a CI box, a fresh container) can
    // still be snapshotted; the snapshot just isn't anyone's.
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "evalution",
      GIT_AUTHOR_EMAIL: "evalution@localhost",
      GIT_COMMITTER_NAME: "evalution",
      GIT_COMMITTER_EMAIL: "evalution@localhost",
    };
    return (await this.git(args, { env })).trim();
  }

  async readFile(
    version: VersionId,
    relativePath: string,
  ): Promise<string | undefined> {
    if (!OBJECT_ID.test(version)) return undefined;
    const result = await runGit(this.repoDir, [
      "cat-file",
      "blob",
      `${version}:${this.repoPath(relativePath)}`,
    ]);
    return result.code === 0 ? result.stdout : undefined;
  }

  async get(id: VersionId): Promise<VersionInfo | undefined> {
    if (!OBJECT_ID.test(id)) return undefined;
    const result = await runGit(this.repoDir, [
      "log",
      "--no-walk",
      LOG_FORMAT,
      `${id}^{commit}`,
      "--",
    ]);
    if (result.code !== 0) return undefined;
    const [entry] = parseLog(result.stdout);
    return entry ? this.toInfo(entry) : undefined;
  }

  async history(
    relativePath: string,
    { limit, before }: VersionHistoryOptions = {},
  ): Promise<VersionInfo[]> {
    const file = this.repoPath(relativePath);
    const head = await this.resolve("HEAD");

    const [commits, snapshots] = await Promise.all([
      head ? this.commitsTouching(file) : Promise.resolve([]),
      this.snapshotsChanging(file, head),
    ]);

    let merged = [...commits, ...snapshots].sort((a, b) => b.time - a.time);
    if (before) {
      const index = merged.findIndex(v => v.id === before);
      if (index >= 0) merged = merged.slice(index + 1);
    }
    return limit !== undefined ? merged.slice(0, limit) : merged;
  }

  /** Commits on `HEAD`'s ancestry that touched `file`. */
  private async commitsTouching(file: string): Promise<VersionInfo[]> {
    const stdout = await this.git([
      "log",
      LOG_FORMAT,
      `-n${MAX_HISTORY_COMMITS}`,
      "HEAD",
      "--",
      file,
    ]);
    return parseLog(stdout).map(entry => ({
      id: entry.id,
      kind: "commit" as const,
      message: entry.message,
      author: entry.author,
      time: entry.time,
    }));
  }

  /**
   * Snapshots made on top of `HEAD`'s ancestry whose copy of `file` differs
   * from their parent's. Snapshots that share a blob hold the same prompt, so
   * they collapse to the newest.
   */
  private async snapshotsChanging(
    file: string,
    head: string | undefined,
  ): Promise<VersionInfo[]> {
    const refs = (
      await this.git([
        "for-each-ref",
        "--format=%(objectname)",
        SNAPSHOT_REF_PREFIX,
      ])
    )
      .split("\n")
      .filter(Boolean);
    if (refs.length === 0) return [];

    const entries = parseLog(
      await this.git(["log", "--no-walk", "--stdin", LOG_FORMAT], {
        input: refs.join("\n") + "\n",
      }),
    );

    // Only snapshots of this branch's past: a parentless one belongs to an
    // unborn branch, and counts only while `HEAD` is still unborn.
    const parents = [...new Set(entries.flatMap(e => e.parents.slice(0, 1)))];
    const reachable = new Set<string>();
    if (head) {
      await Promise.all(
        parents.map(async parent => {
          const result = await runGit(this.repoDir, [
            "merge-base",
            "--is-ancestor",
            parent,
            head,
          ]);
          if (result.code === 0) reachable.add(parent);
        }),
      );
    }
    const candidates = entries.filter(e =>
      e.parents.length === 0 ? !head : reachable.has(e.parents[0]),
    );
    if (candidates.length === 0) return [];

    // Both blob ids for every snapshot in one process.
    const specs = candidates.flatMap(e => [
      `${e.id}:${file}`,
      e.parents.length > 0 ? `${e.parents[0]}:${file}` : "",
    ]);
    const blobs = (
      await this.git(["cat-file", "--batch-check=%(objectname)"], {
        input: specs.map(s => s || "0000:missing").join("\n") + "\n",
      })
    )
      .split("\n")
      .map(line => (line.endsWith(" missing") ? undefined : line.trim()));

    const newestByBlob = new Map<string, LogEntry>();
    candidates.forEach((entry, i) => {
      const own = blobs[i * 2];
      const parent = blobs[i * 2 + 1];
      if (!own || own === parent) return;
      const seen = newestByBlob.get(own);
      if (!seen || seen.time < entry.time) newestByBlob.set(own, entry);
    });
    return [...newestByBlob.values()].map(entry => this.toInfo(entry));
  }

  private toInfo(entry: LogEntry): VersionInfo {
    const snapshot = entry.message === SNAPSHOT_MESSAGE;
    return {
      id: entry.id,
      kind: snapshot ? "snapshot" : "commit",
      ...(snapshot && entry.parents[0] && { parent: entry.parents[0] }),
      message: entry.message,
      author: entry.author,
      time: entry.time,
    };
  }

  private async info(commit: string): Promise<VersionInfo> {
    const info = await this.get(commit);
    if (!info) throw new Error(`git commit ${commit} vanished`);
    return info;
  }

  /** The object `rev` names, or `undefined` if it names nothing (an unborn `HEAD`). */
  private async resolve(rev: string): Promise<string | undefined> {
    const result = await runGit(this.repoDir, [
      "rev-parse",
      "-q",
      "--verify",
      rev,
    ]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /** `relativePath` (relative to {@link rootDir}) relative to the repository, in git's spelling. */
  private repoPath(relativePath: string): string {
    return path
      .relative(this.repoDir, path.resolve(this.rootDir, relativePath))
      .split(path.sep)
      .join("/");
  }

  private async git(
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv; input?: string },
  ): Promise<string> {
    const result = await runGit(this.repoDir, args, options);
    if (result.code !== 0) throw new GitError(args, result);
    return result.stdout;
  }
}
