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

/** What the updates overwrite. */
const WAS = { system: { kind: "primitive", value: "was" } };

describe("TursoVariationStore", () => {
  it("interns identical content to one frozen row", async () => {
    const store = await makeStore();
    const a = await store.intern({
      promptId: "p.prompt.ts#a",
      base: "v1",
      updates: system("hi"),
      baseValues: WAS,
    });
    const b = await store.intern({
      promptId: "p.prompt.ts#a",
      base: "v1",
      updates: system("hi"),
      baseValues: WAS,
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
      baseValues: WAS,
    });
    const otherPrompt = await store.intern({
      promptId: "p#b",
      base: "v1",
      updates: system("hi"),
      baseValues: WAS,
    });
    const otherBase = await store.intern({
      promptId: "p#a",
      base: "v2",
      updates: system("hi"),
      baseValues: WAS,
    });
    expect(new Set([a.id, otherPrompt.id, otherBase.id]).size).toBe(3);
  });

  it("holds one head WIP per prompt, and one WIP per old version", async () => {
    const store = await makeStore();
    const first = await store.putWip({
      promptId: "p#a",
      updates: system("one"),
      baseValues: WAS,
      onHead: true,
    });
    const second = await store.putWip({
      promptId: "p#a",
      updates: system("two"),
      baseValues: WAS,
      onHead: true,
    });
    expect(await store.get(first.id)).toBeUndefined();
    expect((await store.getHeadWip("p#a"))?.id).toBe(second.id);

    const old = await store.putWip({
      promptId: "p#a",
      base: "v0",
      updates: system("old"),
      baseValues: WAS,
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
      updates: system("one"),
      baseValues: WAS,
      onHead: true,
    });
    const pending = {
      targetValues: { system: 2 },
      updates: { style: "chat" as const },
      conflicts: [{ field: "system", base: 1, target: 2, variation: 3 }],
      labels: { target: "head", variation: "yours" },
    };
    const moved = await store.updateWip(wip.id, {
      updates: system("two"),
      baseValues: { system: 2 },
      pending,
    });
    expect(moved).toMatchObject({
      id: wip.id,
      updates: system("two"),
      baseValues: { system: 2 },
      pending,
    });
    expect(moved.base).toBeUndefined();
    const cleared = await store.updateWip(wip.id, { pending: null });
    expect(cleared.pending).toBeUndefined();
  });

  it("never deletes a frozen variation through deleteWip", async () => {
    const store = await makeStore();
    const frozen = await store.intern({
      promptId: "p#a",
      base: "v1",
      updates: system("hi"),
      baseValues: WAS,
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
      baseValues: WAS,
    });
    const b = await store.intern({
      promptId: "p#a",
      base: "v1",
      updates: system("b"),
      baseValues: WAS,
    });
    await store.intern({
      promptId: "p#a",
      base: "v1",
      updates: system("c"),
      baseValues: WAS,
    });
    const wip = await store.putWip({
      promptId: "p#a",
      updates: system("w"),
      baseValues: WAS,
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

  it("dedupes variations without a base, and tells apart ones that overwrote different values", async () => {
    const store = await makeStore();
    const content = { promptId: "p#a", updates: system("hi"), baseValues: WAS };
    const a = await store.intern(content);
    expect(a.base).toBeUndefined();
    expect((await store.intern(content)).id).toBe(a.id);
    const other = await store.intern({
      ...content,
      baseValues: { system: { kind: "primitive", value: "other" } },
    });
    expect(other.id).not.toBe(a.id);
  });
});
