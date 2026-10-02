// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately: what's under test is a file one process
 * writes and another reads.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimServerInfo,
  findRunningServer,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
} from "./server-discovery.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evalution-discovery-"));
  dirs.push(dir);
  return dir;
}

/** A `fetch` answering `/api/config` for a server rooted at `rootPath`. */
function serving(rootPath: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ rootPath }))) as unknown as typeof fetch;
}

/** Records a server as another process — the parent of this one, so it's alive. */
async function recordOther(
  rootDir: string,
  pid = process.ppid,
  kind: "ui" | "mcp" = "ui",
) {
  await writeServerInfo(rootDir, "http://localhost:4567", kind);
  const path = serverInfoPath(rootDir);
  const info = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...info, pid }));
}

describe("server discovery", () => {
  it("writes a self-ignoring record, and removes only its own", async () => {
    const dir = await project();
    await writeServerInfo(dir, "http://localhost:4567", "ui");
    expect(JSON.parse(await readFile(serverInfoPath(dir), "utf8"))).toEqual({
      url: "http://localhost:4567",
      pid: process.pid,
      kind: "ui",
    });
    expect(
      await readFile(join(dir, ".evalution", "run", ".gitignore"), "utf8"),
    ).toBe("*\n");

    removeServerInfo(dir);
    await expect(readFile(serverInfoPath(dir))).rejects.toThrow();

    await recordOther(dir);
    removeServerInfo(dir);
    await expect(readFile(serverInfoPath(dir), "utf8")).resolves.toContain(
      "4567",
    );
  });

  it("finds a live server serving this project, and which command it is", async () => {
    const dir = await project();
    await recordOther(dir);
    expect(await findRunningServer(dir, { fetch: serving(dir) })).toEqual({
      url: "http://localhost:4567",
      pid: process.ppid,
      kind: "ui",
    });
    await recordOther(dir, process.ppid, "mcp");
    expect(await findRunningServer(dir, { fetch: serving(dir) })).toEqual(
      expect.objectContaining({ kind: "mcp" }),
    );
  });

  it("ignores no record, its own record, a dead process, and a server for another project", async () => {
    const dir = await project();
    expect(await findRunningServer(dir, { fetch: serving(dir) })).toBe(
      undefined,
    );

    await writeServerInfo(dir, "http://localhost:4567", "ui");
    expect(await findRunningServer(dir, { fetch: serving(dir) })).toBe(
      undefined,
    );

    // Far above any real pid limit, so never alive.
    await recordOther(dir, 2 ** 30);
    expect(await findRunningServer(dir, { fetch: serving(dir) })).toBe(
      undefined,
    );

    await recordOther(dir);
    expect(
      await findRunningServer(dir, { fetch: serving("/somewhere/else") }),
    ).toBe(undefined);
    const unreachable = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await findRunningServer(dir, { fetch: unreachable })).toBe(
      undefined,
    );
  });

  it("claims a project only when no live process has, taking over a dead one's record", async () => {
    const dir = await project();
    expect(await claimServerInfo(dir, "mcp")).toBe(true);
    expect(JSON.parse(await readFile(serverInfoPath(dir), "utf8"))).toEqual({
      pid: process.pid,
      kind: "mcp",
    });
    // Already ours.
    expect(await claimServerInfo(dir, "mcp")).toBe(true);

    await writeFile(
      serverInfoPath(dir),
      JSON.stringify({ pid: process.ppid, kind: "ui" }),
    );
    expect(await claimServerInfo(dir, "mcp")).toBe(false);

    await writeFile(
      serverInfoPath(dir),
      JSON.stringify({
        url: "http://localhost:4567",
        pid: 2 ** 30,
        kind: "ui",
      }),
    );
    expect(await claimServerInfo(dir, "ui")).toBe(true);
    expect(JSON.parse(await readFile(serverInfoPath(dir), "utf8"))).toEqual({
      pid: process.pid,
      kind: "ui",
    });
  });

  it("waits for a process that has claimed the project to start serving it", async () => {
    const dir = await project();
    await claimServerInfo(dir, "mcp");
    await writeFile(
      serverInfoPath(dir),
      JSON.stringify({ pid: process.ppid, kind: "mcp" }),
    );
    const found = findRunningServer(dir, { fetch: serving(dir) });
    setTimeout(
      () =>
        void writeFile(
          serverInfoPath(dir),
          JSON.stringify({
            url: "http://localhost:4567",
            pid: process.ppid,
            kind: "mcp",
          }),
        ),
      200,
    );
    expect(await found).toEqual({
      url: "http://localhost:4567",
      pid: process.ppid,
      kind: "mcp",
    });

    // One that never does is given up on.
    await writeFile(
      serverInfoPath(dir),
      JSON.stringify({ pid: process.ppid, kind: "mcp" }),
    );
    expect(
      await findRunningServer(dir, {
        fetch: serving(dir),
        startupTimeoutMs: 200,
      }),
    ).toBe(undefined);
  });
});
