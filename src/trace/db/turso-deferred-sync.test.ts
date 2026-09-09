// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Contract tests for Turso's *deferred sync* behaviour — the mechanism the
 * local-first story in `specs/trace-workshopping.md` §B.3 rests on: a user
 * gets a purely local DB, and only on cloud sign-up does a remote DB get
 * created and the accumulated local data pushed to it.
 *
 * The load-bearing detail is undocumented in the type surface: there is **no
 * public `bootstrapIfEmpty` option**. The SDK derives it internally as
 * `typeof opts.url != "function" || opts.url() != null`, so passing `url` as a
 * *function* that returns `null` is what suppresses remote bootstrap. That is
 * an implementation detail of a 0.x dependency, which is exactly why it needs a
 * test rather than a comment.
 *
 * Real filesystem and a real loopback HTTP server, deliberately: the assertions
 * are about a native engine's I/O and network behaviour, which no in-process
 * fake would reproduce.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@tursodatabase/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Recorder {
  server: Server;
  url: string;
  requests: { method: string; path: string; authorization?: string }[];
}

/**
 * A loopback stand-in for the Turso cloud. It records what the sync engine
 * tried to send and always fails the request — enough to assert *that* a push
 * was attempted and how it was authorized, without needing a real account.
 */
async function startRecorder(): Promise<Recorder> {
  const requests: Recorder["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: req.headers.authorization,
    });
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

let dir: string;
let recorder: Recorder;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalution-turso-sync-"));
  recorder = await startRecorder();
});

afterEach(async () => {
  await new Promise<void>(resolve => recorder.server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("Turso deferred sync", () => {
  it("creates a local-only database and never calls the credential callbacks", async () => {
    let authTokenCalls = 0;
    const client = await connect({
      path: join(dir, "local.db"),
      // Signed-out state: no cloud DB exists yet.
      url: () => null,
      authToken: async () => {
        authTokenCalls++;
        return "unused";
      },
      clientName: "evalution-local",
    });

    await client.exec("CREATE TABLE t (id integer primary key, v text)");
    const insert = await client.prepare("INSERT INTO t (v) VALUES (?)");
    await insert.run(["local-row"]);

    // The whole point: a signed-out user's traces cost zero network calls, and
    // we are never asked for a token we do not have.
    expect(authTokenCalls).toBe(0);
    expect(recorder.requests).toHaveLength(0);

    const stats = await client.stats();
    expect(stats.networkSentBytes).toBe(0);
    expect(stats.networkReceivedBytes).toBe(0);

    await client.close();
  });

  it("queues local writes as pending changes to push on first sync", async () => {
    const client = await connect({
      path: join(dir, "local.db"),
      url: () => null,
    });
    await client.exec("CREATE TABLE t (id integer primary key, v text)");
    const insert = await client.prepare("INSERT INTO t (v) VALUES (?)");
    await insert.run(["a"]);
    await insert.run(["b"]);

    // Writes made while signed out are retained as CDC operations, which is
    // what lets a later push seed the fresh cloud DB with existing history.
    const stats = await client.stats();
    expect(stats.cdcOperations).toBeGreaterThan(0);
    // Nothing has been pushed yet. Note the SDK types this `number | null` but
    // actually omits the key until a first push, hence the `?? null`.
    expect(stats.lastPushUnixTime ?? null).toBeNull();

    await client.close();
  });

  it("fails cleanly rather than hanging when asked to push while signed out", async () => {
    const client = await connect({
      path: join(dir, "local.db"),
      url: () => null,
    });
    await client.exec("CREATE TABLE t (id integer primary key)");

    await expect(client.push()).rejects.toThrow(/sync is paused/);
    expect(recorder.requests).toHaveLength(0);

    await client.close();
  });

  it("switches sync on when the url callback starts returning a value", async () => {
    let cloudUrl: string | null = null;
    let authTokenCalls = 0;

    const client = await connect({
      path: join(dir, "local.db"),
      url: () => cloudUrl,
      authToken: async () => {
        authTokenCalls++;
        return "tok-abc";
      },
    });
    await client.exec("CREATE TABLE t (id integer primary key, v text)");
    const insert = await client.prepare("INSERT INTO t (v) VALUES (?)");
    await insert.run(["local-row"]);
    expect(authTokenCalls).toBe(0);

    // The user signs up: we provision a cloud DB and start returning its URL.
    // No reconnect, no new client — the callbacks are re-read per operation.
    cloudUrl = recorder.url;
    await expect(client.push()).rejects.toThrow(); // recorder always 500s

    expect(authTokenCalls).toBe(1);
    expect(recorder.requests.length).toBeGreaterThan(0);
    expect(recorder.requests[0]).toMatchObject({
      method: "POST",
      authorization: "Bearer tok-abc",
    });

    await client.close();
  });
});
