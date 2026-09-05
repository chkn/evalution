// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalFileProvider } from "../../../file-provider-local.ts";
import { MemoryFileProvider } from "../../../file-provider-memory.ts";
import { VercelAISDK } from "../../../sdk/vercel-ai-sdk/index.ts";
import { FilePromptProvider } from "../file-prompt-provider.ts";
import * as promptProgram from "./prompt-program.ts";
import { TSPromptFileType } from "./ts-prompt-file-type.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "__fixtures__");
const fixture = (name: string) => path.join(fixturesDir, name);

function fileType() {
  return new TSPromptFileType(new LocalFileProvider());
}

describe("opaque parameters (§A)", () => {
  it("collapses a class-backed handle instead of shipping its expansion", async () => {
    const prompts = await fileType().parsePrompts(
      [fixture("opaque-param.prompt.ts")],
      fixturesDir,
    );
    const orchestrate = prompts.find(p => p.name === "orchestrate")!;
    const ctx = orchestrate.functionParameters.find(p => p.name === "ctx")!;

    expect(ctx.type.kind).toBe("object");
    const db = (ctx.type as any).properties.find((p: any) => p.name === "db");
    // The alias the author wrote is kept as `syntax`, so the panel can name
    // the slot even though there is nothing beneath it to show.
    expect(db.type).toEqual({ kind: "opaque", syntax: "Db" });

    // The regression this exists for: expanding a handle type produced
    // megabytes of `functionParameters` JSON, shipped on every prompt list.
    const size = JSON.stringify(orchestrate.functionParameters).length;
    expect(size).toBeLessThan(20_000);
  });

  it("is structural — a branded id keeps its editor whether or not a resource exists", async () => {
    // No playground module is present here at all: opacity must be decided
    // from the type alone, never from what happens to be available to fill it.
    const prompts = await fileType().parsePrompts(
      [fixture("opaque-param.prompt.ts")],
      fixturesDir,
    );
    const taskId = prompts
      .find(p => p.name === "orchestrate")!
      .functionParameters.find(p => p.name === "taskId")!;

    expect(taskId.type.kind).toBe("primitive");
    expect(taskId.type).toMatchObject({ base: "string" });
  });
});

describe("resource-to-slot matching (§D)", () => {
  /**
   * A project on disk: a prompt, a playground module beside it, and the shared
   * types both refer to. Real files because both halves have to land in one
   * `ts.Program` for the checker to relate them.
   */
  async function project() {
    const provider = new FilePromptProvider({
      rootDir: fixturesDir,
      includePatterns: ["opaque-param.prompt.ts"],
      playgroundIncludePatterns: ["odin.playground.ts"],
      sdk: new VercelAISDK(),
    });
    return provider.getAllPrompts();
  }

  it("offers a resource on every slot its type fits, and only those", async () => {
    const [prompt] = await project();
    const slots = prompt.inputSources!.functionSlots;

    // `db` is declared to produce a `Db`; the `ctx.db` slot is a `Db`.
    expect(slots["ctx.db"]).toEqual(["odin.playground.ts#db"]);
    // …and nothing else is, including the sibling string field.
    expect(slots["ctx.workspaceId"] ?? []).not.toContain(
      "odin.playground.ts#db",
    );
  });

  it("matches across two spellings of one type, without a pinned type argument", async () => {
    const [prompt] = await project();
    const slots = prompt.inputSources!.functionSlots;

    // `seededRootTask` infers `` `tsk_${string}` `` from what `create` returns;
    // the slot is declared `TaskId`. Identity comparison would have missed
    // this — assignability is what makes the pin unnecessary.
    expect(slots.taskId).toContain("odin.playground.ts#seededRootTask");
  });

  it("offers a resource beside an editable slot's editor, not instead of it", async () => {
    const [prompt] = await project();
    const taskId = prompt.functionParameters.find(p => p.name === "taskId")!;

    // Matched *and* still editable: the two questions are independent.
    expect(prompt.inputSources!.functionSlots.taskId).toBeTruthy();
    expect(taskId.type.kind).toBe("primitive");
  });

  it("falls back to name matching when no checker can see the types", async () => {
    // The documented in-memory situation: cross-file types stay unresolved, so
    // there is nothing for the type rule to compare and the name rule carries.
    // A `file:` URL, not a bare path: the in-memory provider imports through
    // a `data:` URL, which can only resolve absolute ones.
    const helper = pathToFileURL(
      path.join(__dirname, "../../playground/resource.ts"),
    ).href;
    const fileProvider = new MemoryFileProvider({
      "/proj/x.prompt.ts": `export function greet(taskId: string) {
        return { model: 'openai/gpt-4o', system: 'hi' };
      }`,
      "/proj/x.playground.ts":
        `import { resource } from ${JSON.stringify(helper)};\n` +
        `export const taskId = resource({ create: () => ({ value: "tsk_1" }) });`,
    });
    const provider = new FilePromptProvider({
      rootDir: "/proj",
      fileProvider,
      sdk: new VercelAISDK(),
    });

    const [prompt] = await provider.getAllPrompts();
    expect(prompt.inputSources!.functionSlots.taskId).toEqual([
      "x.playground.ts#taskId",
    ]);
  });
});

describe("execute parameters (§E)", () => {
  it("derives toolsContext covering exactly the tools that declare a context", async () => {
    const prompts = await fileType().parsePrompts(
      [fixture("contextual-tools.prompt.ts")],
      fixturesDir,
    );
    const sdk = new VercelAISDK();
    const probes = sdk.getExecuteParameterProbes(prompts[0], "typescript");
    const [resolved] = await fileType().resolveTypeProbes(
      probes.map(probe => ({
        probe,
        filePath: fixture("contextual-tools.prompt.ts"),
        promptName: prompts[0].name,
      })),
    );

    expect(resolved).toBeTruthy();
    expect(resolved!.name).toBe("toolsContext");
    expect(resolved!.type.kind).toBe("object");
    const tools = (resolved!.type as any).properties.map((p: any) => p.name);
    // `plain` declares no `contextSchema`, so it drops out on its own — no
    // filtering logic of ours is involved.
    expect(tools.sort()).toEqual(["lookup"]);
  });

  it("yields no execute parameter for a prompt with no tools", async () => {
    const prompts = await fileType().parsePrompts(
      [fixture("basic.prompt.ts")],
      fixturesDir,
    );
    const sdk = new VercelAISDK();
    const probes = sdk.getExecuteParameterProbes(prompts[0], "typescript");
    const resolved = await fileType().resolveTypeProbes(
      probes.map(probe => ({
        probe,
        filePath: fixture("basic.prompt.ts"),
        promptName: prompts[0].name,
      })),
    );

    // `null`, not `undefined`: the probe ran and answered "no requirement",
    // which must not be confused with "could not tell".
    expect(resolved).toEqual([null]);
    expect(
      sdk.normalizePrompt(prompts[0], resolved).executeParameters,
    ).toBeUndefined();
  });

  it("declares the parameter unresolved rather than staying silent", async () => {
    // No `resolveTypeProbes` at all — the case that used to fail silently at
    // the first tool call.
    const sdk = new VercelAISDK();
    const prompts = await fileType().parsePrompts(
      [fixture("contextual-tools.prompt.ts")],
      fixturesDir,
    );
    const normalized = sdk.normalizePrompt(prompts[0], [undefined]);

    const [param] = normalized.executeParameters!;
    expect(param.name).toBe("toolsContext");
    expect(param.type.kind).toBe("opaque");
  });

  it("returns no probes for a language it does not speak", () => {
    const sdk = new VercelAISDK();
    const prompts = { name: "x", extractedProps: { definitions: [] } } as any;
    expect(sdk.getExecuteParameterProbes(prompts, "yaml")).toEqual([]);
  });
});

describe("probe batching", () => {
  it("builds one program for N prompts, not N", async () => {
    const spy = vi.spyOn(promptProgram, "createPromptProgram");
    try {
      const ft = fileType();
      const files = [
        fixture("basic.prompt.ts"),
        fixture("parameterized.prompt.ts"),
        fixture("contextual-tools.prompt.ts"),
      ];
      const prompts = await ft.parsePrompts(files, fixturesDir);
      expect(prompts.length).toBeGreaterThan(2);

      const before = spy.mock.calls.length;
      await ft.resolveTypeProbes(
        prompts.map(p => ({
          probe: { name: "probe", expression: "$config" },
          filePath: path.join(fixturesDir, p.metadata.relativeFilePath),
          promptName: p.name,
        })),
      );

      // Every probe rides in one build; resolving per prompt would throw away
      // the source-file reuse that makes a rebuild cheap.
      expect(spy.mock.calls.length - before).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
