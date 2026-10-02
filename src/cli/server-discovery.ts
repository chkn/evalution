// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * How the CLI finds another evalution process already serving the same
 * project. Only one process can hold a project's trace and dataset databases
 * open, so a second one has to talk to the first rather than open them
 * itself. The first records where it's listening in
 * `.evalution/run/server.json`; this reads it back, checking the process is
 * still alive and really serving this project.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdirSelfIgnoring } from "../trace/db/self-ignoring-dir.ts";

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

/**
 * Records that this process serves the project at `rootDir` at `url`, and
 * removes the record again when the process exits.
 */
export async function writeServerInfo(
  rootDir: string,
  url: string,
  kind: ServerInfo["kind"],
): Promise<void> {
  const path = serverInfoPath(rootDir);
  // Self-ignoring, as the trace and dataset directories are: the record must
  // never end up committed.
  await mkdirSelfIgnoring(join(rootDir, ".evalution", "run"));
  const info: ServerInfo = { url, pid: process.pid, kind };
  await writeFile(path, `${JSON.stringify(info)}\n`);
  process.once("exit", () => removeServerInfo(rootDir));
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

/**
 * The server serving the project at `rootDir`, or `undefined` when there
 * isn't one. A record left behind by a process that died, or by a server
 * whose port now belongs to something else, doesn't count.
 */
export async function findRunningServer(
  rootDir: string,
  { fetch: fetchImpl = fetch }: { fetch?: typeof fetch } = {},
): Promise<ServerInfo | undefined> {
  let info: ServerInfo;
  try {
    info = JSON.parse(await readFile(serverInfoPath(rootDir), "utf8"));
  } catch {
    return undefined;
  }
  if (
    typeof info?.url !== "string" ||
    typeof info.pid !== "number" ||
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
