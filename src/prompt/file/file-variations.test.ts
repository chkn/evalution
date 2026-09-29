// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFileProvider } from "../../file-provider-memory.ts";
import { VercelAISDK } from "../../sdk/vercel-ai-sdk/index.ts";
import type { NormalizedChatPrompt, PropValue } from "../../shared/types.ts";
import { VariationConflictError } from "../prompt-provider.ts";
import { runVariationMigrations } from "../variations/db/migrate.ts";
import { TursoVariationStore } from "../variations/turso-variation-store.ts";
import { FileSnapshotVersioning } from "../versioning/file-snapshot-versioning.ts";
import { FilePromptProvider } from "./file-prompt-provider.ts";
import { TSPromptFileType } from "./ts/ts-prompt-file-type.ts";

const ROOT = "/virtual";
const FILE = `${ROOT}/greet.prompt.ts`;
const ID = "greet.prompt.ts#greet";

// Untyped: the in-memory provider imports through a `data:` URL, where Node
// does not strip type annotations.
const SOURCE = `export function greet(name) {
  return {
    model: 'openai/gpt-4o',
    system: 'Hello',
    temperature: 0.5,
  };
}
`;

const str = (value: string): PropValue => ({ kind: "primitive", value });

const clients: Database[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});

async function setup(source = SOURCE) {
  const client = await connect({ path: ":memory:", url: () => null });
  clients.push(client);
  await runVariationMigrations(drizzle({ client }));
  const store = new TursoVariationStore({ client });
  const fileProvider = new MemoryFileProvider({ [FILE]: source });
  const sdk = new VercelAISDK();
  const execute = vi
    .spyOn(sdk, "executeConfig")
    .mockResolvedValue({ done: Promise.resolve() });
  const provider = new FilePromptProvider({
    rootDir: ROOT,
    fileProvider,
    sdk,
    versioning: new FileSnapshotVersioning({
      rootDir: ROOT,
      fileProvider,
      store,
    }),
    variationStore: store,
  });
  const edit = (
    ref: Parameters<typeof provider.updatePromptProperties>[0],
    system: string,
  ) =>
    provider.updatePromptProperties(ref, {
      style: "chat",
      system: str(system),
    });
  return { provider, fileProvider, store, execute, edit };
}

const systemOf = (prompt: unknown) => (prompt as NormalizedChatPrompt).system;

describe("FilePromptProvider WIP variations", () => {
  it("an edit leaves the file untouched and lands in a WIP", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { prompt, ref } = await edit(ID, "Hi there");

    expect(await fileProvider.readFile(FILE)).toBe(SOURCE);
    expect(ref.variation).toMatch(/^var_/);
    expect(systemOf(prompt)).toEqual(str("Hi there"));
    expect(prompt.variation).toMatchObject({ wip: true, onHead: true });
    expect(prompt.atHead).toBe(true);

    const head = await provider.getPrompt(ID);
    expect(systemOf(head)).toEqual(str("Hello"));
    expect(head).toMatchObject({ dirty: true, wipId: ref.variation });
    const all = await provider.getAllPrompts();
    expect(all[0]).toMatchObject({ dirty: true, wipId: ref.variation });
  });

  it("later edits fold into the same WIP, and undoing them clears it", async () => {
    const { provider, edit } = await setup();
    const first = await edit(ID, "One");
    const second = await edit(first.ref, "Two");
    expect(second.ref.variation).toBe(first.ref.variation);
    expect(systemOf(second.prompt)).toEqual(str("Two"));

    const undone = await edit(second.ref, "Hello");
    expect(undone.ref).toEqual({ promptId: ID });
    expect((await provider.getPrompt(ID))?.dirty).toBeUndefined();
  });

  it("a variation's prompt reflects its updates while the real file keeps its content", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { ref } = await edit(ID, "Patched");
    const materialized = await provider.getPrompt(ref);
    expect(systemOf(materialized)).toEqual(str("Patched"));
    expect(await fileProvider.readFile(FILE)).toContain("'Hello'");
  });

  it("a run interns a frozen row, and a second run of unchanged edits reuses it", async () => {
    const { provider, execute, edit } = await setup();
    const { ref } = await edit(ID, "Run me");

    const first = await provider.execute(ref, ["Ada"], { traceId: "t1" });
    const second = await provider.execute(ref, ["Ada"], { traceId: "t2" });
    expect(first.variation).toBeDefined();
    expect(first.variation).not.toBe(ref.variation);
    expect(second.variation).toBe(first.variation);
    expect(first.version).toMatch(/^blob:/);

    // The patched source is what ran, and the trace records what it was.
    const [config, options] = execute.mock.calls[0];
    expect(config.system).toBe("Run me");
    expect(options?.identity).toMatchObject({
      id: ID,
      version: first.version,
      variation: first.variation,
    });
    // The WIP carries on.
    expect((await provider.getPrompt(ID))?.wipId).toBe(ref.variation);
  });

  it("a run at head records the version and no variation", async () => {
    const { provider, execute } = await setup();
    const result = await provider.execute(ID, ["Ada"], { traceId: "t1" });
    expect(result.variation).toBeUndefined();
    expect(result.version).toMatch(/^blob:/);
    expect(execute.mock.calls[0][0].system).toBe("Hello");
    expect(execute.mock.calls[0][1]?.identity?.version).toBe(result.version);
  });

  it("save writes the file and clears the WIP", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { ref } = await edit(ID, "Saved");
    const saved = await provider.variations!.save(ref.variation!);
    expect(saved.ok).toBe(true);
    expect(await fileProvider.readFile(FILE)).toContain('"Saved"');
    const head = await provider.getPrompt(ID);
    expect(systemOf(head)).toEqual(str("Saved"));
    expect(head?.dirty).toBeUndefined();
    expect(await provider.variations!.get(ref.variation!)).toBeUndefined();
  });

  it("a save issued while an edit is still landing never loses the edit", async () => {
    const { provider, edit } = await setup();
    const { ref } = await edit(ID, "One");
    const landing = edit(ref, "Two");
    const saving = provider.variations!.save(ref.variation!);
    await Promise.all([landing, saving]);

    // Saved with the edit, or saved without it and the edit kept as unsaved
    // edits — never reported as landed and then thrown away.
    const head = await provider.getPrompt(ID);
    const latest = head?.wipId
      ? await provider.getPrompt({ promptId: ID, variation: head.wipId })
      : head;
    expect(systemOf(latest)).toEqual(str("Two"));
  });

  it("an edit queued behind a save of its unsaved edits starts new ones", async () => {
    const { provider, fileProvider, store, edit } = await setup();
    const { ref } = await edit(ID, "One");

    // Issue the edit while the save holds the lock, once the edit has seen
    // the WIP the save is about to delete.
    let landing: ReturnType<typeof edit> | undefined;
    let editSawWip!: () => void;
    const sawWip = new Promise<void>(resolve => (editSawWip = resolve));
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementation(async id => {
      const v = await get(id);
      if (landing && id === ref.variation) editSawWip();
      return v;
    });
    const deleteWip = store.deleteWip.bind(store);
    vi.spyOn(store, "deleteWip").mockImplementationOnce(async id => {
      landing = edit(ref, "Two");
      await sawWip;
      return deleteWip(id);
    });
    await provider.variations!.save(ref.variation!);

    const after = await landing!;
    expect(after.ref.variation).toMatch(/^var_/);
    expect(after.ref.variation).not.toBe(ref.variation);
    expect(systemOf(after.prompt)).toEqual(str("Two"));
    expect(await fileProvider.readFile(FILE)).toContain('"One"');
    expect(await provider.getPrompt(ID)).toMatchObject({
      dirty: true,
      wipId: after.ref.variation,
    });
  });

  it("an edit racing a rename is never reported landed and then lost", async () => {
    const { provider, store, edit } = await setup();
    const { ref } = await edit(ID, "One");

    // Start the edit just as the rename reads the WIP it's about to move,
    // and give it every chance to land before the move.
    const getHeadWip = store.getHeadWip.bind(store);
    let landing: Promise<unknown> | undefined;
    vi.spyOn(store, "getHeadWip").mockImplementation(async promptId => {
      const wip = await getHeadWip(promptId);
      if (promptId === ID && !landing) {
        landing = edit(ref, "Two");
        landing.catch(() => {});
        await Promise.race([
          landing,
          new Promise(resolve => setTimeout(resolve, 500)),
        ]);
      }
      return wip;
    });
    await provider.renamePrompt(ID, "hello");
    const edited = await landing!.then(
      () => true,
      () => false,
    );

    const renamed = await provider.getPrompt("greet.prompt.ts#hello");
    expect(renamed?.wipId).toBeDefined();
    const moved = await provider.getPrompt({
      promptId: "greet.prompt.ts#hello",
      variation: renamed!.wipId!,
    });
    // The edit either failed loudly, or moved along with the rest.
    expect(systemOf(moved)).toEqual(str(edited ? "Two" : "One"));
  });

  it("discard drops the WIP and leaves the file alone", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { ref } = await edit(ID, "Nope");
    await provider.variations!.discard(ref.variation!);
    expect(await fileProvider.readFile(FILE)).toBe(SOURCE);
    expect((await provider.getPrompt(ID))?.dirty).toBeUndefined();
  });

  it("an external write rebases a clean WIP onto it", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { ref } = await edit(ID, "Mine");
    const rebased = new Promise<void>(resolve =>
      provider.watch(event => {
        if (event.ref?.variation) resolve();
      }),
    );

    // The IDE changes a different field.
    await fileProvider.writeFile(FILE, SOURCE.replace("0.5", "0.9"));
    await rebased;

    const wip = await provider.getPrompt(ref);
    expect(systemOf(wip)).toEqual(str("Mine"));
    expect(
      wip?.modelParameters.find(p => p.def.name === "temperature")?.value,
    ).toEqual({ kind: "primitive", value: 0.9 });
    expect(wip?.variation?.pending).toBeUndefined();
  });

  it("an external write to the same field marks the WIP conflicted, and it can't run until resolved", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { ref } = await edit(ID, "Mine");
    await fileProvider.writeFile(FILE, SOURCE.replace("Hello", "Theirs"));

    // Rebased lazily on the next read, even without a watcher.
    const head = await provider.getPrompt(ID);
    const wip = await provider.getPrompt({
      promptId: ID,
      variation: head!.wipId!,
    });
    expect(wip?.variation?.pending?.conflicts).toEqual([
      {
        field: "system",
        base: str("Hello"),
        target: str("Theirs"),
        variation: str("Mine"),
      },
    ]);
    await expect(provider.execute(ref, ["Ada"])).rejects.toBeInstanceOf(
      VariationConflictError,
    );
    await expect(edit(ref, "More")).rejects.toBeInstanceOf(
      VariationConflictError,
    );

    const resolved = await provider.variations!.resolve(ref.variation!, {
      system: "variation",
    });
    expect(resolved.ok).toBe(true);
    const after = await provider.getPrompt(ref);
    expect(systemOf(after)).toEqual(str("Mine"));
    expect(after?.variation?.pending).toBeUndefined();

    await provider.variations!.save(ref.variation!);
    expect(await fileProvider.readFile(FILE)).toContain('"Mine"');
  });

  it("opens a variation from an old version at head, creating the WIP", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { ref } = await edit(ID, "Old idea");
    const named = await provider.variations!.name(ref.variation!, "old idea");
    await provider.variations!.discard(ref.variation!);
    // Head moves on under it.
    await fileProvider.writeFile(FILE, SOURCE.replace("0.5", "0.9"));

    const opened = await provider.variations!.openOnHead(named.id);
    expect(opened.ok).toBe(true);
    const head = await provider.getPrompt(ID);
    expect(head?.dirty).toBe(true);
    const wip = await provider.getPrompt({
      promptId: ID,
      variation: head!.wipId!,
    });
    expect(systemOf(wip)).toEqual(str("Old idea"));
    expect(wip?.variation?.originName).toBe("old idea");
  });

  it("opening a variation over a WIP merges disjoint fields and conflicts on a field both set", async () => {
    const { provider, edit } = await setup();
    const { ref } = await edit(ID, "Named");
    const named = await provider.variations!.name(ref.variation!, "named");
    await provider.variations!.discard(ref.variation!);

    // Unsaved edits to another field merge in cleanly.
    await provider.updatePromptProperties(ID, {
      style: "chat",
      model: str("openai/gpt-5"),
    });
    const merged = await provider.variations!.openOnHead(named.id);
    expect(merged.ok).toBe(true);
    const wipId = (await provider.getPrompt(ID))!.wipId!;
    const wip = await provider.getPrompt({ promptId: ID, variation: wipId });
    expect(systemOf(wip)).toEqual(str("Named"));
    expect(wip?.model).toMatchObject({ value: "openai/gpt-5" });

    // Unsaved edits to the same field conflict.
    await edit({ promptId: ID, variation: wipId }, "Unsaved");
    const conflicted = await provider.variations!.openOnHead(named.id);
    expect(conflicted).toEqual({
      ok: false,
      conflicts: [
        {
          field: "system",
          base: str("Hello"),
          target: str("Unsaved"),
          variation: str("Named"),
        },
      ],
      labels: { target: "unsaved edits", variation: "named" },
    });
    // Reporting a conflict changes nothing: cancelling leaves the edits as
    // they were.
    const untouched = await provider.variations!.get(wipId);
    expect(untouched?.pending).toBeUndefined();
    expect(untouched?.updates).toMatchObject({ system: str("Unsaved") });
  });

  it("settles an open-on-head conflict by choice per field, or by discarding the unsaved edits", async () => {
    const { provider, edit } = await setup();
    const { ref } = await edit(ID, "Named");
    const named = await provider.variations!.name(ref.variation!, "named");
    await provider.variations!.discard(ref.variation!);
    await provider.updatePromptProperties(ID, {
      style: "chat",
      model: str("openai/gpt-5"),
      system: str("Unsaved"),
    });

    const chosen = await provider.variations!.openOnHead(named.id, {
      choices: { system: "variation" },
    });
    expect(chosen.ok).toBe(true);
    const wipId = (await provider.getPrompt(ID))!.wipId!;
    const merged = await provider.getPrompt({ promptId: ID, variation: wipId });
    expect(systemOf(merged)).toEqual(str("Named"));
    expect(merged?.model).toMatchObject({ value: "openai/gpt-5" });

    // Replacing throws the unsaved edits away: exactly the variation.
    await edit({ promptId: ID, variation: wipId }, "Unsaved again");
    const replaced = await provider.variations!.openOnHead(named.id, {
      replace: true,
    });
    expect(replaced.ok).toBe(true);
    const head = await provider.getPrompt(ID);
    const exact = await provider.getPrompt({
      promptId: ID,
      variation: head!.wipId!,
    });
    expect(systemOf(exact)).toEqual(str("Named"));
    expect(exact?.model).toMatchObject({ value: "openai/gpt-4o" });
  });

  it("naming a WIP freezes it, lists the name, and the WIP carries on", async () => {
    const { provider, edit } = await setup();
    const { ref } = await edit(ID, "Keep this");
    const named = await provider.variations!.name(ref.variation!, "keeper");
    expect(named).toMatchObject({ wip: false, names: ["keeper"] });
    const listed = await provider.variations!.list(ID);
    expect(listed.map(v => v.id).sort()).toEqual(
      [named.id, ref.variation].sort(),
    );
    expect(
      systemOf(await provider.getPrompt({ promptId: ID, variation: named.id })),
    ).toEqual(str("Keep this"));
  });

  it("reads a prompt back at an old version after the file changed", async () => {
    const { provider, fileProvider } = await setup();
    const { version } = await provider.execute(ID, ["Ada"]);
    await fileProvider.writeFile(FILE, SOURCE.replace("Hello", "Changed"));

    const old = await provider.getPrompt({ promptId: ID, version: version! });
    expect(systemOf(old)).toEqual(str("Hello"));
    expect(old).toMatchObject({
      ref: { promptId: ID, version },
      atHead: false,
      version: { id: version, kind: "snapshot", fileOnly: true },
    });
    await expect(
      provider.execute({ promptId: ID, version: version! }, ["Ada"]),
    ).rejects.toThrow(/working tree/);

    // At the current head, a version is head: editable and runnable.
    const { version: current } = await provider.execute(ID, ["Ada"]);
    const atHead = await provider.getPrompt({
      promptId: ID,
      version: current!,
    });
    expect(atHead?.ref).toEqual({ promptId: ID });

    const history = await provider.versions!.history(ID);
    expect(history.map(v => v.id)).toEqual([current, version]);
  });

  it("editing an old version makes a WIP there, which opens on head", async () => {
    const { provider, fileProvider } = await setup();
    const { version } = await provider.execute(ID, ["Ada"]);
    await fileProvider.writeFile(FILE, SOURCE.replace("0.5", "0.9"));

    const { ref, prompt } = await provider.updatePromptProperties(
      { promptId: ID, version: version! },
      { style: "chat", system: str("From the past") },
    );
    expect(prompt.atHead).toBe(false);
    expect(prompt.variation).toMatchObject({ wip: true, onHead: false });
    expect((await provider.getPrompt(ID))?.dirty).toBeUndefined();

    const opened = await provider.variations!.openOnHead(ref.variation!);
    expect(opened.ok).toBe(true);
    const head = await provider.getPrompt(ID);
    const wip = await provider.getPrompt({
      promptId: ID,
      variation: head!.wipId!,
    });
    expect(systemOf(wip)).toEqual(str("From the past"));
    expect(
      wip?.modelParameters.find(p => p.def.name === "temperature")?.value,
    ).toEqual({ kind: "primitive", value: 0.9 });
  });

  describe("finding the prompt at head", () => {
    const helperSource = (name: string) => `
import { prompts } from '@evalution/vercel-ai-sdk';
export default prompts({ id: 'greeter' }, () => ({
  ${name}() { return { model: 'openai/gpt-4o', system: 'Hello' }; },
}));
`;
    const HELPER_ID = "helper.prompt.ts#greet";

    it("follows a file move by the prompt's prompts() id", async () => {
      const { provider, fileProvider, edit } = await setup();
      await fileProvider.writeFile(
        `${ROOT}/helper.prompt.ts`,
        helperSource("greet"),
      );
      const { ref } = await edit(HELPER_ID, "Moved along");
      const named = await provider.variations!.name(ref.variation!, "moving");
      await provider.variations!.discard(ref.variation!);

      await fileProvider.deleteFile(`${ROOT}/helper.prompt.ts`);
      await fileProvider.writeFile(
        `${ROOT}/moved.prompt.ts`,
        helperSource("greet"),
      );

      expect(await provider.variations!.openOnHead(named.id)).toMatchObject({
        ok: true,
        variation: { promptId: "moved.prompt.ts#greet" },
      });
    });

    it("conflicts on the prompt itself once neither its id nor its prompts() id is at head", async () => {
      const { provider, fileProvider, edit } = await setup();
      await fileProvider.writeFile(
        `${ROOT}/helper.prompt.ts`,
        helperSource("greet"),
      );
      const { ref } = await edit(HELPER_ID, "Renamed away");
      const named = await provider.variations!.name(ref.variation!, "gone");
      await provider.variations!.discard(ref.variation!);

      // The export is renamed, which renames the prompts() id with it.
      await fileProvider.writeFile(
        `${ROOT}/helper.prompt.ts`,
        helperSource("welcome"),
      );
      const result = await provider.variations!.openOnHead(named.id);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.conflicts.map(c => c.field)).toEqual([
        "prompt",
      ]);
    });
  });

  it("opens an old version on head as unsaved edits restoring its values", async () => {
    const { provider, fileProvider } = await setup();
    const { version } = await provider.execute(ID, ["Ada"]);
    await fileProvider.writeFile(
      FILE,
      SOURCE.replace("Hello", "Newer").replace("0.5", "0.9"),
    );

    const opened = await provider.variations!.openVersionOnHead(ID, version!);
    expect(opened.ok).toBe(true);
    const head = await provider.getPrompt(ID);
    expect(systemOf(head)).toEqual(str("Newer"));
    const wip = await provider.getPrompt({
      promptId: ID,
      variation: head!.wipId!,
    });
    expect(systemOf(wip)).toEqual(str("Hello"));
    expect(wip?.variation?.updates).toEqual({
      style: "chat",
      system: str("Hello"),
      modelParameters: { temperature: { kind: "primitive", value: 0.5 } },
    });
  });

  it("reads unsaved edits and old versions without resolving types again", async () => {
    const { provider, fileProvider, edit } = await setup();
    const { version } = await provider.execute(ID, ["Ada"]);
    const resolve = vi.spyOn(TSPromptFileType.prototype, "resolveTypes");
    // Calls that build a program: project probes alone are answered from a
    // cache.
    const builds = () =>
      resolve.mock.calls.filter(
        ([r]) => (r.probes?.length ?? 0) + (r.slotMatches?.length ?? 0) > 0,
      ).length;
    try {
      const head = await provider.getPrompt(ID);
      const afterHead = builds();
      expect(afterHead).toBeGreaterThan(0);

      // Edits, and reading them back, borrow head's types.
      const { ref } = await edit(ID, "Quick");
      await edit(ref, "Quicker");
      const wip = await provider.getPrompt(ref);
      expect(systemOf(wip)).toEqual(str("Quicker"));
      expect(wip?.executeParameters).toEqual(head?.executeParameters);
      expect(wip?.inputSources).toEqual(head?.inputSources);

      // An old version can't run, so it's read for its fields alone.
      await fileProvider.writeFile(FILE, SOURCE.replace("0.5", "0.9"));
      await provider.getPrompt({ promptId: ID, version: version! });
      await provider.getPrompt({ promptId: ID, variation: ref.variation! });
      // Only head's own re-read after its file changed resolves types.
      expect(builds() - afterHead).toBeLessThanOrEqual(1);
    } finally {
      resolve.mockRestore();
    }
  });

  it("without a variation store, edits write straight to the file", async () => {
    const fileProvider = new MemoryFileProvider({ [FILE]: SOURCE });
    const provider = new FilePromptProvider({
      rootDir: ROOT,
      fileProvider,
      sdk: new VercelAISDK(),
    });
    expect(provider.variations).toBeUndefined();
    const { ref } = await provider.updatePromptProperties(ID, {
      style: "chat",
      system: str("Direct"),
    });
    expect(ref).toEqual({ promptId: ID });
    expect(await fileProvider.readFile(FILE)).toContain('"Direct"');
  });
});
