// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedPromptUpdates } from "../../shared/types.ts";
import { runVariationMigrations } from "./db/migrate.ts";
import { TursoVariationStore } from "./turso-variation-store.ts";

const clients: Database[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});

async function makeStore(): Promise<TursoVariationStore> {
  const client = await connect({ path: ":memory:", url: () => null });
  clients.push(client);
  await runVariationMigrations(drizzle({ client }));
  return new TursoVariationStore({ client });
}

const system = (text: string): NormalizedPromptUpdates => ({
  style: "chat",
  system: { kind: "primitive", value: text },
});

describe("TursoVariationStore", () => {
  it("interns identical content to one frozen row", async () => {
    const store = await makeStore();
    const a = await store.intern({
      promptId: "p.prompt.ts#a",
      base: "v1",
      updates: system("hi"),
    });
    const b = await store.intern({
      promptId: "p.prompt.ts#a",
      base: "v1",
      updates: system("hi"),
    });
    expect(b.id).toBe(a.id);
    expect(a.wip).toBe(false);
    expect(a.updates).toEqual(system("hi"));
  });

  it("keeps the same updates for different prompts or bases apart", async () => {
    const store = await makeStore();
    const a = await store.intern({
      promptId: "p#a",
      base: "v1",
      updates: system("hi"),
    });
    const otherPrompt = await store.intern({
      promptId: "p#b",
      base: "v1",
      updates: system("hi"),
    });
    const otherBase = await store.intern({
      promptId: "p#a",
      base: "v2",
      updates: system("hi"),
    });
    expect(new Set([a.id, otherPrompt.id, otherBase.id]).size).toBe(3);
  });

  it("holds one WIP per (prompt, base) and one head WIP per prompt", async () => {
    const store = await makeStore();
    const first = await store.putWip({
      promptId: "p#a",
      base: "v1",
      updates: system("one"),
      onHead: true,
    });
    const second = await store.putWip({
      promptId: "p#a",
      base: "v2",
      updates: system("two"),
      onHead: true,
    });
    expect(await store.get(first.id)).toBeUndefined();
    expect((await store.getHeadWip("p#a"))?.id).toBe(second.id);

    const old = await store.putWip({
      promptId: "p#a",
      base: "v0",
      updates: system("old"),
      onHead: false,
    });
    expect((await store.getWip("p#a", "v0"))?.id).toBe(old.id);
    expect((await store.getHeadWip("p#a"))?.id).toBe(second.id);
    expect((await store.listHeadWips()).map(w => w.id)).toEqual([second.id]);
  });

  it("updates a WIP in place, records and clears pending conflicts", async () => {
    const store = await makeStore();
    const wip = await store.putWip({
      promptId: "p#a",
      base: "v1",
      updates: system("one"),
      onHead: true,
    });
    const pending = {
      onto: "v2",
      updates: { style: "chat" as const },
      conflicts: [{ field: "system", base: 1, target: 2, variation: 3 }],
      labels: { target: "head", variation: "yours" },
    };
    const moved = await store.updateWip(wip.id, {
      base: "v2",
      updates: system("two"),
      pending,
    });
    expect(moved).toMatchObject({
      id: wip.id,
      base: "v2",
      updates: system("two"),
      pending,
    });
    const cleared = await store.updateWip(wip.id, { pending: null });
    expect(cleared.pending).toBeUndefined();
  });

  it("never deletes a frozen variation through deleteWip", async () => {
    const store = await makeStore();
    const frozen = await store.intern({
      promptId: "p#a",
      base: "v1",
      updates: system("hi"),
    });
    await store.deleteWip(frozen.id);
    expect(await store.get(frozen.id)).toBeDefined();
  });

  it("lists named variations and WIPs, and moves a name when re-used", async () => {
    const store = await makeStore();
    const a = await store.intern({
      promptId: "p#a",
      base: "v1",
      updates: system("a"),
    });
    const b = await store.intern({
      promptId: "p#a",
      base: "v1",
      updates: system("b"),
    });
    await store.intern({ promptId: "p#a", base: "v1", updates: system("c") });
    const wip = await store.putWip({
      promptId: "p#a",
      base: "v1",
      updates: system("w"),
      onHead: true,
    });

    await store.name(a.id, "p#a", "terse");
    expect((await store.get(a.id))?.names).toEqual(["terse"]);
    await store.name(b.id, "p#a", "terse");
    expect((await store.get(a.id))?.names).toEqual([]);
    expect((await store.get(b.id))?.names).toEqual(["terse"]);

    const listed = await store.list("p#a");
    expect(listed.map(v => v.id).sort()).toEqual([b.id, wip.id].sort());

    await store.unname("p#a", "terse");
    expect((await store.list("p#a")).map(v => v.id)).toEqual([wip.id]);
  });

  it("stores blobs and file snapshots", async () => {
    const store = await makeStore();
    const sha = await store.putBlob("hello");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.putBlob("hello")).toBe(sha);
    expect(await store.getBlob(sha)).toBe("hello");

    const first = await store.recordSnapshot("a.prompt.ts", sha);
    const again = await store.recordSnapshot("a.prompt.ts", sha);
    expect(again.createdAt).toBe(first.createdAt);
    expect(await store.listSnapshots("a.prompt.ts")).toHaveLength(1);
    expect((await store.getSnapshot(sha))?.path).toBe("a.prompt.ts");
  });
});
