// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  HeadState,
  VersionHistoryOptions,
  VersionId,
  VersionInfo,
  VersioningAdapter,
} from "./versioning-adapter.ts";

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
function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      // No optional locks: a read like `status` would otherwise take the
      // index lock to refresh the user's index — rewriting it, and failing
      // a `git commit` they run at the same moment.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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
    child.stdin.end();
  });
}

/** `git log` format for {@link parseLogEntry}: fields NUL-separated, records RS-terminated. */
const LOG_FORMAT = "--format=%H%x00%an%x00%ct%x00%s%x1e";

function parseLog(stdout: string): VersionInfo[] {
  return stdout
    .split("\x1e")
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [id, author, time, message] = record.split("\0");
      return { id, message, author, time: Number(time) * 1000 };
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
}

/**
 * A {@link VersioningAdapter} for a git repository: a version is a commit.
 * Uncommitted changes are never recorded — a run on a dirty working tree
 * simply has no version.
 *
 * Shells out to `git`; there is no library dependency. See
 * `specs/prompt-versions-and-variations.md` §C.
 */
export class GitVersioning implements VersioningAdapter {
  readonly id = "git";

  readonly repoDir: string;
  readonly rootDir: string;

  constructor({ repoDir, rootDir }: GitVersioningOptions) {
    this.repoDir = repoDir;
    this.rootDir = rootDir;
  }

  /**
   * Builds a `GitVersioning` for the repository containing `rootDir`, or
   * returns `undefined` when there is none — or no `git` binary to run, which
   * is reported once, here, as "versioning unavailable" rather than failing
   * later.
   */
  static async detect(rootDir: string): Promise<GitVersioning | undefined> {
    let result: GitResult;
    try {
      result = await runGit(rootDir, ["rev-parse", "--show-toplevel"]);
    } catch (err: any) {
      console.warn(
        `⚠️ git versioning unavailable (${err?.code === "ENOENT" ? "no git binary found" : err?.message}); prompts will have no versions.`,
      );
      return undefined;
    }
    if (result.code !== 0) return undefined;
    return new GitVersioning({
      repoDir: result.stdout.trim(),
      // git reports the top level with symlinks resolved (`/private/var` for
      // `/var` on macOS), so the root has to be too for paths to relate.
      rootDir: await realpath(rootDir),
    });
  }

  async head(): Promise<HeadState> {
    const [commit, status] = await Promise.all([
      this.resolve("HEAD"),
      // Untracked files count: a new tool module changes what a run does as
      // surely as an edited one. Ignored files don't.
      this.git(["status", "--porcelain"]),
    ]);
    return {
      ...(commit && { commit: await this.info(commit) }),
      clean: status.trim() === "",
    };
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
    return parseLog(result.stdout)[0];
  }

  async history(
    relativePath: string,
    { limit, before }: VersionHistoryOptions = {},
  ): Promise<VersionInfo[]> {
    if (!(await this.resolve("HEAD"))) return [];
    // Commits on `HEAD`'s ancestry that touched the file.
    let commits = parseLog(
      await this.git([
        "log",
        LOG_FORMAT,
        `-n${MAX_HISTORY_COMMITS}`,
        "HEAD",
        "--",
        this.repoPath(relativePath),
      ]),
    );
    if (before) {
      const index = commits.findIndex(v => v.id === before);
      if (index >= 0) commits = commits.slice(index + 1);
    }
    return limit !== undefined ? commits.slice(0, limit) : commits;
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

  private async git(args: readonly string[]): Promise<string> {
    const result = await runGit(this.repoDir, args);
    if (result.code !== 0) throw new GitError(args, result);
    return result.stdout;
  }
}
