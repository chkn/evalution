// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * How the CLI finds another evalution process already serving the same
 * project. Only one process can hold a project's trace and dataset databases
 * open, so a second one has to talk to the first rather than open them
 * itself. A process claims the project in `.evalution/run/server.json` —
 * created exclusively, so two processes starting at once can't both claim it
 * — before it opens the databases, then records where it's listening; this
 * reads it back, checking the process is still alive and really serving
 * this project.
 */

import { readFileSync, unlinkSync } from "node:fs";
import {
  link,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdirSelfIgnoring } from "../trace/db/self-ignoring-dir.ts";

/** A claim on a project by a process not yet listening: no `url` yet. */
interface ServerRecord extends Omit<ServerInfo, "url"> {
  url?: string;
}

/** What a running server records about itself. */
export interface ServerInfo {
  /** Where it's listening, e.g. `http://localhost:3000`. */
  url: string;
  /** Its process id. */
  pid: number;
  /**
   * Which command it is: `ui` serves the playground (and MCP at `/mcp`);
   * `mcp` is an `evalution mcp` an agent started, serving only MCP.
   */
  kind: "ui" | "mcp";
}

/** Where the server info for the project at `rootDir` lives. */
export function serverInfoPath(rootDir: string): string {
  return join(rootDir, ".evalution", "run", "server.json");
}

const removedOnExit = new Set<string>();

/** Makes sure this process's record for `rootDir` goes when the process does. */
function removeOnExit(rootDir: string): void {
  if (removedOnExit.has(rootDir)) return;
  removedOnExit.add(rootDir);
  process.once("exit", () => removeServerInfo(rootDir));
}

/** The run directory, self-ignoring as the trace and dataset directories are: the record must never end up committed. */
function makeRunDir(rootDir: string): Promise<void> {
  return mkdirSelfIgnoring(join(rootDir, ".evalution", "run"));
}

/**
 * Writes `contents` to `path` whole or not at all, so a reader never sees
 * half a record: to a temporary file first, then moved into place — or,
 * `exclusive`ly, linked into place, which fails with `EEXIST` if a record is
 * there already.
 */
async function writeWhole(
  path: string,
  contents: string,
  { exclusive = false }: { exclusive?: boolean } = {},
): Promise<void> {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, contents);
  try {
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
  } finally {
    if (exclusive) await unlink(temp).catch(() => {});
  }
}

/** A record as read: missing, unreadable (a crash's leftovers, or a writer that predates {@link writeWhole}), or there. */
async function readRecord(
  path: string,
): Promise<ServerRecord | "unreadable" | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const record = JSON.parse(text);
    return typeof record?.pid === "number" ? record : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * How long a record that can't be read may stand before it's taken for a
 * crash's leftovers rather than a claim mid-write.
 */
const UNREADABLE_GRACE_MS = 5000;

/** Whether the unreadable record at `path` is recent enough to be a write in progress. */
async function freshlyWritten(path: string): Promise<boolean> {
  const age = await stat(path).then(
    s => Date.now() - s.mtimeMs,
    () => Number.POSITIVE_INFINITY,
  );
  return age < UNREADABLE_GRACE_MS;
}

/**
 * Claims the project at `rootDir` for this process, before it opens the
 * project's databases, by creating its record exclusively. Returns whether
 * it now holds the claim: `false` when another live process does. A record
 * left by a process that's gone is removed and claimed over.
 */
export async function claimServerInfo(
  rootDir: string,
  kind: ServerInfo["kind"],
): Promise<boolean> {
  const path = serverInfoPath(rootDir);
  await makeRunDir(rootDir);
  const record: ServerRecord = { pid: process.pid, kind };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeWhole(path, `${JSON.stringify(record)}\n`, {
        exclusive: true,
      });
      removeOnExit(rootDir);
      return true;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
    const held = await readRecord(path);
    if (held === undefined) continue;
    if (held === "unreadable") {
      if (await freshlyWritten(path)) return false;
    } else if (held.pid === process.pid) {
      return true;
    } else if (isAlive(held.pid)) {
      return false;
    }
    await unlink(path).catch(() => {});
  }
  return false;
}

/**
 * Records that this process serves the project at `rootDir` at `url`, and
 * removes the record again when the process exits. Called once listening,
 * by a process holding the claim ({@link claimServerInfo}).
 */
export async function writeServerInfo(
  rootDir: string,
  url: string,
  kind: ServerInfo["kind"],
): Promise<void> {
  await makeRunDir(rootDir);
  const info: ServerInfo = { url, pid: process.pid, kind };
  await writeWhole(serverInfoPath(rootDir), `${JSON.stringify(info)}\n`);
  removeOnExit(rootDir);
}

/** Removes the server info for `rootDir`, if it's this process's. Synchronous, for `exit` handlers. */
export function removeServerInfo(rootDir: string): void {
  const path = serverInfoPath(rootDir);
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as ServerInfo;
    if (info.pid === process.pid) unlinkSync(path);
  } catch {
    // Gone already, or never ours.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM: alive, but someone else's.
    return err?.code === "EPERM";
  }
}

/** Options for {@link findRunningServer}. */
export interface FindRunningServerOptions {
  fetch?: typeof fetch;
  /**
   * How long to wait for a process that has claimed the project, but isn't
   * listening yet, to start. Defaults to 60 s.
   */
  startupTimeoutMs?: number;
}

/**
 * The server serving the project at `rootDir`, or `undefined` when there
 * isn't one. A record left behind by a process that died, or by a server
 * whose port now belongs to something else, doesn't count. A process that
 * has claimed the project but is still starting is waited for.
 */
export async function findRunningServer(
  rootDir: string,
  {
    fetch: fetchImpl = fetch,
    startupTimeoutMs = 60_000,
  }: FindRunningServerOptions = {},
): Promise<ServerInfo | undefined> {
  const path = serverInfoPath(rootDir);
  const deadline = Date.now() + startupTimeoutMs;
  /** Whether `record` is a claim, or a write, still to be waited out. */
  const starting = async (record: ServerRecord | "unreadable" | undefined) =>
    record === "unreadable"
      ? await freshlyWritten(path)
      : record !== undefined &&
        record.url === undefined &&
        record.pid !== process.pid &&
        isAlive(record.pid);
  let record = await readRecord(path);
  while ((await starting(record)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    record = await readRecord(path);
  }
  const info = record === "unreadable" ? undefined : record;
  if (
    typeof info?.url !== "string" ||
    info.pid === process.pid ||
    !isAlive(info.pid)
  ) {
    return undefined;
  }
  try {
    const res = await fetchImpl(new URL("/api/config", info.url), {
      signal: AbortSignal.timeout(2000),
    });
    const config = (await res.json()) as { rootPath?: string };
    return config.rootPath && resolve(config.rootPath) === resolve(rootDir)
      ? {
          url: info.url,
          pid: info.pid,
          kind: info.kind === "mcp" ? "mcp" : "ui",
        }
      : undefined;
  } catch {
    return undefined;
  }
}
