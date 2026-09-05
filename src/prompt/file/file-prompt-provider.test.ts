// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { pathToFileURL } from "node:url";
import { valueToSourceText } from "ts-proppy";
import { describe, expect, it, vi } from "vitest";
import { MemoryFileProvider } from "../../file-provider-memory.ts";
import { VercelAISDK } from "../../sdk/vercel-ai-sdk/index.ts";
import type { NormalizedPrompt, PropValue } from "../../shared/types.ts";
import { FilePromptProvider } from "./file-prompt-provider.ts";

/** Virtual root all in-memory prompt files live under. */
const ROOT = "/virtual";

/** Builds an absolute path inside the virtual root. */
function p(relPath: string): string {
  return `${ROOT}/${relPath}`;
}

/**
 * Spins up a {@link FilePromptProvider} backed by a {@link MemoryFileProvider}
 * — no disk access. Returns the provider plus the file provider so tests can
 * drive writes/deletes (which fire watch callbacks synchronously).
 */
function setup(files: Record<string, string> = {}) {
  const fileProvider = new MemoryFileProvider(files);
  const provider = new FilePromptProvider({
    rootDir: ROOT,
    fileProvider,
    sdk: new VercelAISDK(),
  });
  return { provider, fileProvider };
}

/** Flushes pending microtasks/timers so async watch callbacks can run. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Look up a parameter value by name on a normalized prompt. */
function getParameter(
  prompt: NormalizedPrompt,
  name: string,
): PropValue | undefined {
  return prompt.modelParameters.find(p => p.def.name === name)?.value;
}

describe("FilePromptProvider", () => {
  it("should return all prompts from all files", async () => {
    const { provider } = setup({
      [p("test1.prompt.ts")]: `
export function prompt1() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test 1'
  };
}
`,
      [p("test2.prompt.ts")]: `
export function prompt2() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test 2'
  };
}
`,
    });

    const prompts = await provider.getAllPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts.some(p => p.name === "prompt1")).toBe(true);
    expect(prompts.some(p => p.name === "prompt2")).toBe(true);
  });

  it("should return specific prompt by ID", async () => {
    const { provider } = setup({
      [p("test.prompt.ts")]: `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`,
    });

    const promptId = `test.prompt.ts#myPrompt`;
    const prompt = await provider.getPrompt(promptId);

    expect(prompt).not.toBeNull();
    expect(prompt!.name).toBe("myPrompt");
    expect(prompt!.id).toBe(promptId);
  });

  it("should return null for non-existent ID", async () => {
    const { provider } = setup();
    const prompt = await provider.getPrompt("/fake/path.ts#nonexistent");

    expect(prompt).toBeNull();
  });

  it("execute forwards the trace id and prompt identity to the SDK adapter", async () => {
    const fileProvider = new MemoryFileProvider({
      // Untyped parameter: the in-memory provider imports through a `data:`
      // URL, where Node does not strip type annotations.
      [p("id.prompt.ts")]:
        `export function greet(name) { return { model: 'openai/gpt-4o', system: 'hi' }; }`,
    });
    const sdk = new VercelAISDK();
    const spy = vi
      .spyOn(sdk, "executeConfig")
      .mockResolvedValue({ done: Promise.resolve() });
    const provider = new FilePromptProvider({
      rootDir: ROOT,
      fileProvider,
      sdk,
    });

    const functionInputs = [
      {
        kind: "value" as const,
        value: { kind: "primitive" as const, value: "Ada" },
      },
    ];
    await provider.execute("id.prompt.ts#greet", ["Ada"], {
      traceId: "trace-x",
      inputs: { functionInputs },
    });

    expect(spy).toHaveBeenCalledWith(expect.anything(), {
      traceId: "trace-x",
      executeValues: undefined,
      identity: {
        id: "id.prompt.ts#greet",
        name: "greet",
        // The trace records the recipe, not the resolved arguments: one of
        // those could be a live handle that doesn't serialize, and the recipe
        // is what a replay needs. The signature snapshot rides along so a
        // replay can diff two known shapes instead of guessing.
        functionInputs,
        executeInputs: undefined,
        parameterDefinitions: [expect.objectContaining({ name: "name" })],
      },
    });
  });

  it("run-scoped teardown waits for the run to settle, not for execute to return", async () => {
    const fileProvider = new MemoryFileProvider({
      [p("id.prompt.ts")]:
        `export function greet() { return { model: 'openai/gpt-4o', system: 'hi' }; }`,
    });
    const sdk = new VercelAISDK();
    let finish!: () => void;
    const done = new Promise<void>(resolve => {
      finish = resolve;
    });
    vi.spyOn(sdk, "executeConfig").mockResolvedValue({ done });
    const provider = new FilePromptProvider({
      rootDir: ROOT,
      fileProvider,
      sdk,
    });

    let settled = false;
    await provider.execute("id.prompt.ts#greet", [], {
      onSettled: () => {
        settled = true;
      },
    });

    // `execute` is fire-and-forget by design, so the run is still going.
    expect(settled).toBe(false);
    finish();
    await done;
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("should update editable property", async () => {
    const filePath = p("test.prompt.ts");
    const { provider, fileProvider } = setup({
      [filePath]: `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Old value'
  };
}
`,
    });

    const promptId = `${filePath}#myPrompt`;
    const updatedPrompt = await provider.updatePromptProperties(promptId, {
      system: { kind: "primitive", value: "New value" },
    });

    expect(updatedPrompt.system).toEqual({
      kind: "primitive",
      value: "New value",
    });

    const fileContent = await fileProvider.readFile(filePath);
    expect(fileContent).toContain('"New value"');
  });

  it("should return updated sourceText on model property after mode switch", async () => {
    const filePath = p("test.prompt.ts");
    const { provider } = setup({
      [filePath]: `
import { openai } from '@ai-sdk/openai';

export function myPrompt() {
  return {
    model: openai('gpt-4o'),
    system: 'Test'
  };
}
`,
    });

    const promptId = `${filePath}#myPrompt`;
    const updatedPrompt = await provider.updatePromptProperties(promptId, {
      model: { kind: "primitive", value: "openai/gpt-4o" },
    });

    expect(valueToSourceText(updatedPrompt.model!)).toBe('"openai/gpt-4o"');
  });

  it("should throw error for read-only property", async () => {
    const filePath = p("test.prompt.ts");
    const { provider } = setup({
      [filePath]: `
function getDynamic() {
  return 'dynamic';
}

export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: getDynamic()
  };
}
`,
    });

    const promptId = `${filePath}#myPrompt`;

    await expect(
      provider.updatePromptProperties(promptId, {
        system: { kind: "primitive", value: "New" },
      }),
    ).rejects.toThrow("not editable");
  });

  it("should throw error for non-existent prompt", async () => {
    const { provider } = setup();
    await expect(
      provider.updatePromptProperties("/fake/path.ts#fake", {
        system: { kind: "primitive", value: "New" },
      }),
    ).rejects.toThrow("Prompt not found");
  });

  it("should add a new property when key does not exist", async () => {
    const filePath = p("test.prompt.ts");
    const { provider } = setup({
      [filePath]: `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`,
    });

    const promptId = `${filePath}#myPrompt`;

    const updated = await provider.updatePromptProperties(promptId, {
      modelParameters: { temperature: { kind: "primitive", value: 0.7 } },
    });
    const tempValue = getParameter(updated, "temperature");
    expect(tempValue).toBeDefined();
    expect(tempValue).toEqual({ kind: "primitive", value: 0.7 });
  });

  it("should support watching", () => {
    const { provider } = setup();
    expect(provider.watch).toBeDefined();
  });

  it("should support editing", () => {
    const { provider } = setup();
    expect(provider.updatePromptProperties).toBeDefined();
  });

  it("should handle files with multiple exported functions correctly", async () => {
    const { provider } = setup({
      [p("test.prompt.ts")]: `
export function prompt1() {
  return {
    model: 'openai/gpt-4o',
    system: 'First'
  };
}

export function prompt2() {
  return {
    model: 'openai/gpt-4o',
    system: 'Second'
  };
}
`,
    });

    const prompts = await provider.getAllPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts[0].name).toBe("prompt1");
    expect(prompts[1].name).toBe("prompt2");
  });

  it("should re-parse file after update to return fresh data", async () => {
    const filePath = p("test.prompt.ts");
    const { provider } = setup({
      [filePath]: `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Original'
  };
}
`,
    });

    const promptId = `${filePath}#myPrompt`;

    // First update
    await provider.updatePromptProperties(promptId, {
      system: { kind: "primitive", value: "Updated" },
    });

    // Verify fresh data
    const prompt = await provider.getPrompt(promptId);
    expect(prompt!.system).toEqual({ kind: "primitive", value: "Updated" });
  });

  it("should call callback on file changes", async () => {
    const filePath = p("test.prompt.ts");
    const { provider, fileProvider } = setup({
      [filePath]: `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`,
    });

    // Initialize provider by loading prompts
    await provider.getAllPrompts();

    const events: any[] = [];
    const cleanup = provider.watch!(event => {
      events.push(event);
    });

    // Modify the file — MemoryFileProvider fires the watch callback.
    await fileProvider.writeFile(
      filePath,
      `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Changed'
  };
}
`,
    );
    await tick();

    cleanup();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("change");
  });

  it("getAllPrompts does not throw after a watched file is deleted", async () => {
    const filePath = p("test.prompt.ts");
    const { provider, fileProvider } = setup({
      [filePath]: `
export function myPrompt() {
  return { model: 'openai/gpt-4o', system: 'Test' };
}
`,
    });

    expect(await provider.getAllPrompts()).toHaveLength(1);

    const cleanup = provider.watch!(() => {});
    await fileProvider.deleteFile(filePath);
    cleanup();

    await expect(provider.getAllPrompts()).resolves.toHaveLength(0);
  });

  it("should cleanup watcher when cleanup function is called", async () => {
    const filePath = p("test.prompt.ts");
    const { provider, fileProvider } = setup({
      [filePath]: `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`,
    });

    await provider.getAllPrompts();

    const callback = vi.fn();
    const cleanup = provider.watch!(callback);
    cleanup();

    // Modify file after cleanup
    await fileProvider.writeFile(
      filePath,
      `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Changed after cleanup'
  };
}
`,
    );
    await tick();

    // Callback should not be called after cleanup
    expect(callback).not.toHaveBeenCalled();
  });

  it("emits watcher events for provider-originated updates (clients dedupe echoes)", async () => {
    // Suppression moved to the client (see client/self-edits.ts) so that
    // multiple clients sharing one workspace stay in sync; the provider now
    // emits change events for its own writes too.
    const { provider } = setup({
      [p("test.prompt.ts")]: `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`,
    });

    await provider.getAllPrompts();

    const events: { type: string; promptId: string }[] = [];
    const cleanup = provider.watch!(e => events.push(e));

    await provider.updatePromptProperties(`${p("test.prompt.ts")}#myPrompt`, {
      system: { kind: "primitive", value: "Updated locally" },
    });
    // The watch callback re-parses asynchronously before emitting.
    await tick();

    cleanup();

    expect(
      events.some(
        e => e.type === "change" && e.promptId === "test.prompt.ts#myPrompt",
      ),
    ).toBe(true);
  });

  describe("file scanning", () => {
    it("should find .prompt.ts files recursively", async () => {
      const { provider } = setup({
        [p("test.prompt.ts")]: `
export function testPrompt() {
  return { model: 'openai/gpt-4o', system: 'Test' };
}
`,
        [p("subdir/nested.prompt.ts")]: `
export function nestedPrompt() {
  return { model: 'openai/gpt-4o', system: 'Nested' };
}
`,
      });

      const prompts = await provider.getAllPrompts();
      expect(prompts).toHaveLength(2);
      expect(prompts.some(p => p.name === "testPrompt")).toBe(true);
      expect(prompts.some(p => p.name === "nestedPrompt")).toBe(true);
    });

    it("should find .promp.ts files (typo pattern)", async () => {
      const { provider } = setup({
        [p("typo.promp.ts")]: `
export function typoPrompt() {
  return { model: 'openai/gpt-4o', system: 'Typo' };
}
`,
      });

      const prompts = await provider.getAllPrompts();
      expect(prompts.some(p => p.name === "typoPrompt")).toBe(true);
    });

    it("should ignore node_modules directory", async () => {
      const { provider } = setup({
        [p("node_modules/test.prompt.ts")]: `
export function ignored() { return { model: 'openai/gpt-4o', system: 'Ignored' }; }
`,
        [p("valid.prompt.ts")]: `
export function valid() { return { model: 'openai/gpt-4o', system: 'Valid' }; }
`,
      });

      const prompts = await provider.getAllPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("valid");
    });

    it("should use custom includePatterns and ignorePatterns", async () => {
      const fileProvider = new MemoryFileProvider({
        [p("test.custom.ts")]: `
export function customPrompt() {
  return { model: 'openai/gpt-4o', system: 'Custom' };
}
`,
        [p("test.prompt.ts")]: `
export function regularPrompt() {
  return { model: 'openai/gpt-4o', system: 'Regular' };
}
`,
      });
      const customProvider = new FilePromptProvider({
        rootDir: ROOT,
        fileProvider,
        includePatterns: ["**/*.custom.ts"],
        ignorePatterns: [],
        sdk: new VercelAISDK(),
      });

      const prompts = await customProvider.getAllPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("customPrompt");
    });
  });
});

describe("FilePromptProvider resource inputs", () => {
  /** A project whose playground module exports one resource. */
  function withResource(extra: Record<string, string> = {}) {
    const helper = pathToFileURL(
      path.join(import.meta.dirname, "../playground/resource.ts"),
    ).href;
    const fileProvider = new MemoryFileProvider({
      [p("x.prompt.ts")]:
        `export function greet(taskId) { return { model: 'openai/gpt-4o', system: 'hi' }; }`,
      [p("x.playground.ts")]:
        `import { resource } from ${JSON.stringify(helper)};\n` +
        `globalThis.__disposed = 0;\n` +
        `export const taskId = resource({\n` +
        `  label: "Seeded task",\n` +
        `  create: () => ({ value: "tsk_seeded", receipt: "tsk_seeded",\n` +
        `    dispose: () => { globalThis.__disposed++; } }),\n` +
        `});`,
      ...extra,
    });
    return new FilePromptProvider({
      rootDir: ROOT,
      fileProvider,
      sdk: new VercelAISDK(),
    });
  }

  it("offers the resource on the panel without ever sending its value", async () => {
    const [prompt] = await withResource().getAllPrompts();
    const sources = prompt.inputSources!;

    expect(sources.functionSlots.taskId).toEqual(["x.playground.ts#taskId"]);
    expect(sources.resources).toEqual([
      {
        uri: "x.playground.ts#taskId",
        label: "Seeded task",
        scope: "run",
      },
    ]);
  });

  it("resolves a resource reference into the value execute receives", async () => {
    const provider = withResource();
    const resolved = await provider.resolveInputs("x.prompt.ts#greet", {
      functionInputs: [{ kind: "resource", uri: "x.playground.ts#taskId" }],
    });

    // `execute` still takes plain `any[]` — the provider contract did not
    // change with the wire format.
    expect(resolved.functionParams).toEqual(["tsk_seeded"]);
    // A receipt lets a trace display what the run used, even though replaying
    // it would mint a new one.
    expect(resolved.receipts).toEqual({
      "x.playground.ts#taskId": "tsk_seeded",
    });

    (globalThis as any).__disposed = 0;
    await resolved.release?.();
    expect((globalThis as any).__disposed).toBe(1);
  });

  it("resolves the same relative ref under a different rootDir", async () => {
    // Refs are persisted in localStorage today and destined for a synced DB,
    // where a machine-absolute path would break for every teammate.
    const helper = pathToFileURL(
      path.join(import.meta.dirname, "../playground/resource.ts"),
    ).href;
    const source =
      `import { resource } from ${JSON.stringify(helper)};\n` +
      `export const taskId = resource({ create: () => ({ value: "tsk_1" }) });`;
    const promptSource = `export function greet(taskId) { return { model: 'm', system: 'hi' }; }`;

    const ref = "x.playground.ts#taskId";
    for (const root of ["/proj", "/elsewhere/deeper"]) {
      const provider = new FilePromptProvider({
        rootDir: root,
        fileProvider: new MemoryFileProvider({
          [path.join(root, "x.prompt.ts")]: promptSource,
          [path.join(root, "x.playground.ts")]: source,
        }),
        sdk: new VercelAISDK(),
      });
      const resolved = await provider.resolveInputs("x.prompt.ts#greet", {
        functionInputs: [{ kind: "resource", uri: ref }],
      });
      expect(resolved.functionParams).toEqual(["tsk_1"]);
    }
  });

  it("releases the lease when resolution fails, so nothing is left alive", async () => {
    const provider = withResource();
    await expect(
      provider.resolveInputs("x.prompt.ts#greet", {
        functionInputs: [{ kind: "resource", uri: "x.playground.ts#missing" }],
      }),
    ).rejects.toThrow(/not found/);
  });
});
